"""Exercise the actual Windows DLL ABI without making upstream requests."""
import base64
import ctypes as c
import datetime as dt
import json
import hashlib
from pathlib import Path
import tempfile

class Buffer(c.Structure):
    _fields_ = [('ptr', c.c_void_p), ('len', c.c_size_t)]
HostCall = c.CFUNCTYPE(c.c_int, c.c_void_p, c.c_char_p, c.c_void_p, c.c_size_t, c.POINTER(Buffer))
HostFree = c.CFUNCTYPE(None, c.c_void_p, c.c_size_t)
PluginCall = c.CFUNCTYPE(c.c_int, c.c_char_p, c.c_void_p, c.c_size_t, c.POINTER(Buffer))
PluginFree = c.CFUNCTYPE(None, c.c_void_p, c.c_size_t)
Shutdown = c.CFUNCTYPE(None)
class Host(c.Structure):
    _fields_ = [('abi', c.c_uint32), ('ctx', c.c_void_p), ('call', HostCall), ('free', HostFree)]
class Plugin(c.Structure):
    _fields_ = [('abi', c.c_uint32), ('call', PluginCall), ('free', PluginFree), ('shutdown', Shutdown)]
buffers = {}
status = 'unbound'
@HostCall
def callback(ctx, method, request, length, out):
    result = {'status': status} if method == b'host.affinity.lookup' else {'files': [{'id': 'seed-a', 'auth_index': 'index-a'}, {'id': 'seed-b', 'auth_index': 'index-b'}]}
    raw = json.dumps({'ok': True, 'result': result}).encode()
    buf = c.create_string_buffer(raw)
    addr = c.addressof(buf)
    buffers[addr] = buf
    out[0] = Buffer(addr, len(raw))
    return 0
@HostFree
def free(ptr, length):
    buffers.pop(ptr, None)
host = Host(1, None, callback, free)
plugin = Plugin()
dll = c.CDLL(str((Path(__file__).parent / 'bin/soonest-reset.dll').resolve()))
dll.cliproxy_plugin_init.argtypes = [c.POINTER(Host), c.POINTER(Plugin)]
assert dll.cliproxy_plugin_init(c.byref(host), c.byref(plugin)) == 0
assert plugin.abi == 1

def call(method, payload):
    raw = json.dumps(payload).encode()
    buf = c.create_string_buffer(raw)
    out = Buffer()
    code = plugin.call(method.encode(), buf, len(raw), c.byref(out))
    try:
        result = json.loads(c.string_at(out.ptr, out.len))
    finally:
        plugin.free(out.ptr, out.len)
    assert code == 0 and result['ok'], result
    return result['result']

with tempfile.TemporaryDirectory() as tmp:
    state = str(Path(tmp) / 'state.json')
    now = dt.datetime.now(dt.timezone.utc)
    seed = {hashlib.sha256(('index:' + index).encode()).hexdigest():
            {'observed': now.isoformat(), 'reset': (now+dt.timedelta(hours=hours)).isoformat(), 'provider': 'claude'}
            for index, hours in [('index-a', 8), ('index-b', 2)]}
    Path(state).write_text(json.dumps(seed))
    config = base64.b64encode(('state_file: ' + json.dumps(state)).encode()).decode()
    reg = call('plugin.register', {'config_yaml': config})
    assert all(reg['metadata'][key] for key in ('Name', 'Version', 'Author', 'GitHubRepository'))
    assert reg['capabilities'] == {'scheduler': True, 'usage_plugin': True}
    seed_req = {'Provider': 'claude', 'Model': 'opus', 'Options': {'Metadata': {'canonical_session_id': 'seed-session'}},
                'Candidates': [{'ID': 'seed-a', 'Provider': 'claude'}, {'ID': 'seed-b', 'Provider': 'claude'}]}
    assert call('scheduler.pick', seed_req)['AuthID'] == 'seed-b', 'seed index hydration failed'
    assert json.loads(Path(state + '.status.json').read_text())['loaded_at']
    for account, hours in [('a', 8), ('b', 2)]:
        call('usage.handle', {'AuthID': account, 'Generate': True, 'Provider': 'claude', 'RequestedAt': now.isoformat(),
             'ResponseHeaders': {'Anthropic-Ratelimit-Unified-7d-Reset': [str(int((now+dt.timedelta(hours=hours)).timestamp()))]},
             'APIKey': 'secret-must-not-persist', 'Failure': {'Body': 'private-body'}})
    req = {'Provider': 'claude', 'Model': 'opus', 'Options': {'Metadata': {'canonical_session_id': 'new-session'}},
           'Candidates': [{'ID': 'a', 'Provider': 'claude'}, {'ID': 'b', 'Provider': 'claude'}]}
    assert call('scheduler.pick', req)['AuthID'] == 'b'
    status = 'bound'
    assert not call('scheduler.pick', req)['Handled'], 'existing affinity must remain core owned'
    status = 'unbound'
    req['Candidates'] = [{'ID': 'a', 'Provider': 'claude'}]
    assert call('scheduler.pick', req)['AuthID'] == 'a', 'failed/disabled credential must not be reused'
    req['Candidates'].append({'ID': 'unknown', 'Provider': 'claude'})
    assert not call('scheduler.pick', req)['Handled'], 'unknown reset must delegate'
    assert 'secret' not in Path(state).read_text() and 'private' not in Path(state).read_text()
    call('plugin.reconfigure', {'config_yaml': config})
    assert not buffers, 'host callback response leaked'
plugin.shutdown()
print('Native DLL ABI passed: registration, live quota learning, earliest reset, affinity delegation, candidate failover, unknown fallback, secret exclusion, reconfigure and buffer ownership.')

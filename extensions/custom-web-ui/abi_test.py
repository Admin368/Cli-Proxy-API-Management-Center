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
dll = c.CDLL(str((Path(__file__).parent / 'bin/custom-web-ui.dll').resolve()))
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

reg=call('plugin.register', {})
assert reg['capabilities']=={'management_api':True,'usage_plugin':True}
resources=call('management.register',{})
assert resources['Resources'][0]['Menu']=='Custom Web UI'
page=call('management.handle',{'Method':'GET','Path':'/v0/resource/plugins/custom-web-ui/panel','Query':{'action':['start']}})
assert page['StatusCode']==200
assert b'Custom Web UI' in base64.b64decode(page['Body'])
status=call('management.handle',{'Method':'GET','Path':'/v0/management/plugins/custom-web-ui/status'})
assert not json.loads(base64.b64decode(status['Body']))['managed']
rejected=call('management.handle',{'Method':'GET','Path':'/v0/management/plugins/custom-web-ui/start'})
assert rejected['StatusCode']==405
with tempfile.TemporaryDirectory() as tmp:
    path=str(Path(tmp)/'history.json')
    cfg=base64.b64encode(('history_file: '+json.dumps(path)).encode()).decode()
    call('plugin.reconfigure',{'config_yaml':cfg})
    def update(prefs):
        body=base64.b64encode(json.dumps({'preferences':prefs}).encode()).decode()
        return call('management.handle',{'Method':'PUT','Path':'/v0/management/plugins/custom-web-ui/forecast','Body':body})
    assert update({'window':'session','horizon':24})['StatusCode']==200
    result=update({'factor':0.5})
    saved=json.loads(base64.b64decode(result['Body']))['preferences']
    assert saved=={'window':'session','horizon':24,'factor':0.5}
    assert update({'managementKey':'must-not-be-saved'})['StatusCode']==400
    assert 'must-not-be-saved' not in Path(path).read_text()
    print('Native shared preferences passed: partial writes, durable file and secret-field rejection.')
plugin.shutdown()
assert not buffers
print('Native DLL ABI passed: metadata, resource registration, static panel, read-only GET, status and shutdown.')

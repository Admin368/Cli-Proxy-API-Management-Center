from contextlib import closing
"""Read-only EasyCLIProxyAPI history bridge. Python 3.10+, no dependencies."""
import argparse
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SAFE_SOURCE = re.compile(r'^[\w.@+() -]+\.json$', re.ASCII | re.IGNORECASE)
FIELDS = ('id', 'timestamp', 'timestamp_ms', 'model', 'provider', 'source', 'api_key_hash',
          'failed', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens',
          'cache_creation_tokens', 'total_tokens', 'latency_ms')
OPTIONAL = ('ttft_ms', 'canceled', 'reasoning_effort', 'response_model', 'generate', 'auth_index', 'request_id')


def read_records(path, after):
    # mode=ro prevents creation/mutation; normal SQLite locking sees the live WAL.
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        db.execute('PRAGMA query_only=ON')
        db.row_factory = sqlite3.Row
        columns = {r[1] for r in db.execute('PRAGMA table_info(usage_events)')}
        if not set(FIELDS) <= columns:
            raise ValueError('Unsupported desktop history schema')
        selected = list(FIELDS) + [f for f in OPTIONAL if f in columns]
        # Only project approved fields, never failure bodies, headers, raw keys or IPs.
        query = ','.join('"' + f + '"' for f in selected)
        rows = db.execute(f'SELECT {query} FROM (SELECT * FROM usage_events ORDER BY id DESC LIMIT 10000) '
                          'WHERE id > ? ORDER BY id LIMIT 501', (after,)).fetchall()
        items = []
        for row in rows[:500]:
            item = dict(row)
            row_id = item.pop('id')
            item.pop('timestamp_ms')
            request_id = str(item.pop('request_id', '') or '').strip()
            if re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', request_id):
                item['log_request_id'] = request_id
            item['id'] = hashlib.sha256(('desktop-row:' + str(row_id)).encode()).hexdigest()
            auth_index = str(item.pop('auth_index', '') or '').strip()
            if auth_index:
                item['account_id'] = hashlib.sha256(('auth:' + auth_index).encode()).hexdigest()
            item['source'] = item['source'] if SAFE_SOURCE.fullmatch(item['source']) else ''
            item['api_key_hash'] = item['api_key_hash'] if re.fullmatch(r'[a-fA-F0-9]{64}', item['api_key_hash']) else ''
            item['failed'] = bool(item['failed'])
            item['canceled'] = bool(item.get('canceled', False))
            item['resolved_model'] = item.pop('response_model', '') or item['model']
            if not item.pop('generate', True):
                for field in ('input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens'):
                    item[field] = None
            items.append(item)
        return {'items': items, 'cursor': str(rows[min(len(rows), 500)-1]['id']) if rows else str(after),
                'hasMore': len(rows) > 500}


def backend_identity(value):
    """Treat the two IPv4 loopback spellings as aliases; preserve scheme/port/path."""
    value = value.rstrip('/')
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError:
        return value
    if parsed.hostname in ('localhost', '127.0.0.1') and not parsed.username and not parsed.password:
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        return (parsed.scheme, '127.0.0.1', port, parsed.path, parsed.query, parsed.fragment)
    return value


def make_handler(database, token, origins, backend):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log credentials or request headers.

        def reply(self, status, payload=None):
            body = json.dumps(payload).encode() if payload is not None else b''
            self.send_response(status)
            origin = self.headers.get('Origin')
            if origin in origins:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, X-Usage-Backend')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            # Reject DNS-rebinding hosts and unapproved browser origins.
            return (self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'
                    and self.headers.get('Origin') in origins)

        def do_OPTIONS(self):
            self.reply(204 if self.allowed() else 403)

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, {'error': 'Origin or host is not allowed'})
            if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + token).encode()):
                return self.reply(401, {'error': 'Invalid helper token'})
            if backend_identity(self.headers.get('X-Usage-Backend', '')) != backend_identity(backend):
                return self.reply(409, {'error': 'Helper belongs to a different backend'})
            url = urlsplit(self.path)
            if url.path != '/records':
                return self.reply(404, {'error': 'Not found'})
            try:
                cursor = parse_qs(url.query).get('after', ['0'])[0]
                if not re.fullmatch(r'[0-9]{1,16}', cursor):
                    return self.reply(400, {'error': 'Invalid cursor'})
                self.reply(200, read_records(database, int(cursor)))
            except (sqlite3.Error, ValueError, OSError):
                self.reply(503, {'error': 'Desktop database unavailable or unsupported'})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--token-file', required=True, type=Path)
    parser.add_argument('--origin', required=True, action='append', help='Exact web origin; repeat for multiple origins')
    parser.add_argument('--backend', required=True, help='Backend URL used at web login')
    parser.add_argument('--port', type=int, default=8318)
    args = parser.parse_args()
    read_records(args.database, 0)  # Fail before listening if installation/schema is wrong.
    if not args.token_file.exists():
        args.token_file.parent.mkdir(parents=True, exist_ok=True)
        with args.token_file.open('x', encoding='utf-8') as file:
            file.write(secrets.token_urlsafe(32))
        args.token_file.chmod(0o600)
    token = args.token_file.read_text(encoding='utf-8').strip()
    if len(token) < 32 or not token.isascii():
        parser.error('Token file must contain at least 32 ASCII characters')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(args.database, token, args.origin, args.backend))
    print(f'Usage helper listening on http://127.0.0.1:{server.server_port}; token is in {args.token_file}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()

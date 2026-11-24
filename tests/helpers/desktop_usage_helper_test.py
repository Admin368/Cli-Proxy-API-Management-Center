from contextlib import closing
"""Integration tests invoked by the Bun test suite; only temporary fixture databases."""
import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('usage_bridge', Path(__file__).resolve().parents[2] / 'scripts/usage-helper/server.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'usage.db'
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            fields = ','.join('"'+f+'" '+('INTEGER' if f == 'id' else 'TEXT') for f in bridge.FIELDS)
            db.execute('CREATE TABLE usage_events ('+fields+', failure_body TEXT)')
            values = {f: 0 for f in bridge.FIELDS}
            values.update(timestamp='2026-11-03T12:00:00Z', model='fixture-model', provider='fixture', source='secret-api-key', api_key_hash='not-a-hash')
            fields = ','.join('"'+f+'"' for f in bridge.FIELDS)
            for i in range(1, 503):
                values['id'] = i
                db.execute('INSERT INTO usage_events ('+fields+',failure_body) VALUES ('+','.join('?' for _ in range(len(bridge.FIELDS)+1))+')', [values[f] for f in bridge.FIELDS]+['private failure'])
            db.commit()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.make_handler(self.db, 'fixture-token', ['http://allowed.test'], 'http://backend.test'))
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, path='/records', **headers):
        base = {'Origin': 'http://allowed.test', 'Authorization': 'Bearer fixture-token', 'X-Usage-Backend': 'http://backend.test'}
        base.update(headers)
        return urlopen(Request(f'http://127.0.0.1:{self.server.server_port}'+path, headers=base))

    def test_pagination_sanitization_and_non_destructive_reads(self):
        before = self.db.read_bytes()
        with self.request() as response:
            first = json.load(response)
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'http://allowed.test')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(len(first['items']), 500)
        self.assertTrue(first['hasMore'])
        self.assertEqual(first['cursor'], '500')
        serialized = json.dumps(first)
        self.assertNotIn('secret-api-key', serialized)
        self.assertNotIn('private failure', serialized)
        self.assertNotIn('failure_body', serialized)
        with self.request('/records?after=500') as response:
            last = json.load(response)
        self.assertEqual(len(last['items']), 2)
        self.assertFalse(last['hasMore'])
        self.assertEqual(self.db.read_bytes(), before)
        with self.request() as response:
            self.assertEqual(json.load(response), first)
        readonly = sqlite3.connect(self.db.as_uri()+'?mode=ro', uri=True)
        self.assertEqual(readonly.execute('select count(*) from usage_events').fetchone()[0], 502)
        readonly.close()

    def test_auth_origin_host_backend_and_cursor_guards(self):
        for headers, status in [({'Authorization': 'Bearer wrong'}, 401), ({'Origin': 'http://evil.test'}, 403), ({'Host': 'evil.test'}, 403), ({'X-Usage-Backend': 'http://other.test'}, 409)]:
            with self.assertRaises(HTTPError) as error:
                self.request(**headers)
            self.assertEqual(error.exception.code, status)
        with self.assertRaises(HTTPError) as error:
            self.request('/records?after=-1')
        self.assertEqual(error.exception.code, 400)

    def test_live_wal_writes_and_schema_failure(self):
        with closing(sqlite3.connect(self.db)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute("INSERT INTO usage_events SELECT 503," + ','.join('"'+f+'"' for f in bridge.FIELDS[1:]) + ",failure_body FROM usage_events WHERE id=502")
            writer.commit()
            with self.request('/records?after=502') as response:
                self.assertEqual(len(json.load(response)['items']), 1)
            writer.execute('DROP TABLE usage_events')
            writer.commit()
            with self.assertRaises(HTTPError) as error:
                self.request()
            self.assertEqual(error.exception.code, 503)

    def test_loopback_backend_alias_preserves_connection_isolation(self):
        canonical = bridge.backend_identity('http://127.0.0.1:8317')
        self.assertEqual(canonical, bridge.backend_identity('http://localhost:8317/'))
        for other in ['http://localhost:8318', 'https://localhost:8317', 'http://localhost:8317/other', 'http://example.com:8317', 'http://user@localhost:8317', 'http://localhost:bad']:
            self.assertNotEqual(canonical, bridge.backend_identity(other))

    def test_account_and_request_identity_recovery_does_not_change_record_ids(self):
        before = bridge.read_records(self.db, 0)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('ALTER TABLE usage_events ADD COLUMN auth_index TEXT')
            db.execute('ALTER TABLE usage_events ADD COLUMN request_id TEXT')
            db.execute("UPDATE usage_events SET auth_index = 'fixture-account-a', request_id = 'fixture-request-1' WHERE id <= 250")
            db.execute("UPDATE usage_events SET auth_index = 'fixture-account-b', request_id = 'fixture-request-2' WHERE id > 250")
            db.commit()
        after = bridge.read_records(self.db, 0)
        self.assertEqual([r['id'] for r in before['items']], [r['id'] for r in after['items']])
        self.assertEqual(len({r['account_id'] for r in after['items']}), 2)
        self.assertNotIn('fixture-account-a', json.dumps(after))
        self.assertEqual(after['items'][0]['log_request_id'], 'fixture-request-1')

    def test_missing_database_is_not_created(self):
        missing = Path(self.tmp.name) / 'missing.db'
        with self.assertRaises(sqlite3.Error):
            bridge.read_records(missing, 0)
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()

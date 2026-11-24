import datetime as dt
import unittest
import seed
from install import replace_plugins
import yaml

class ResetToolsTest(unittest.TestCase):
    def test_seed_keeps_only_reset_metadata(self):
        now = 1800000000
        record = {'provider': 'claude', 'auth_index': 'private-index',
                  'timestamp': dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(),
                  'api_key': 'private-key', 'body': 'private-body',
                  'response_headers': {'Anthropic-Ratelimit-Unified-7d-Reset': [str(now+3600)],
                                       'Authorization': ['private-secret']}}
        key, value = seed.observation(record, now)
        self.assertEqual(len(key), 64)
        self.assertEqual(set(value), {'observed', 'reset', 'provider'})
        self.assertNotIn('private', str((key, value)))
        self.assertIsNone(seed.observation(record, now+90000))

    def test_codex_requires_weekly_window(self):
        now = 1800000000
        record = {'provider': 'codex', 'auth_index': 'index',
                  'timestamp': dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(),
                  'response_headers': {'X-Codex-Primary-Window-Minutes': ['300'],
                                       'X-Codex-Primary-Reset-After-Seconds': ['3600']}}
        self.assertIsNone(seed.observation(record, now))
        record['response_headers']['X-Codex-Primary-Window-Minutes'] = ['10080']
        self.assertIsNotNone(seed.observation(record, now))

    def test_config_patch_preserves_other_sections(self):
        text = 'routing:\n  strategy: round-robin\n  session-affinity: true\nplugins:\n  enabled: false\n  configs:\n    other:\n      enabled: false\n# next section\napi-keys:\n  sample: secret\n'
        before = yaml.safe_load(text)
        plugins = before['plugins']
        plugins['enabled'] = True
        plugins['configs']['soonest-reset'] = {'enabled': True}
        after = yaml.safe_load(replace_plugins(text, plugins))
        self.assertEqual(after['routing'], before['routing'])
        self.assertEqual(after['api-keys'], before['api-keys'])
        self.assertFalse(after['plugins']['configs']['other']['enabled'])
        self.assertTrue(after['plugins']['configs']['soonest-reset']['enabled'])

if __name__ == '__main__':
    unittest.main()

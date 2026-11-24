import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('seed_history', Path(__file__).with_name('seed_history.py'))
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)

class QuotaRecoveryTests(unittest.TestCase):
    def test_reads_only_quota_headers_not_body_or_credentials(self):
        text = ('=== API RESPONSE 1 ===\nTimestamp: fixture\nStatus: 200\nHeaders:\n'
                'Authorization: secret-value\nAnthropic-Ratelimit-Unified-5h-Reset: 1800000000\n'
                'Anthropic-Ratelimit-Unified-5h-Utilization: 0.25\n\nBody:\n'
                'Anthropic-Ratelimit-Unified-5h-Utilization: 0.99\n')
        self.assertEqual(seed.response_quota_headers(text), {
            'anthropic-ratelimit-unified-5h-reset': 1800000000.0,
            'anthropic-ratelimit-unified-5h-utilization': 0.25,
        })
    def test_retry_attempts_are_not_attributed_to_an_unverified_account(self):
        self.assertIsNone(seed.response_quota_headers('=== API RESPONSE 1 ===\nHeaders:\n\n=== API RESPONSE 2 ===\nHeaders:\n'))
    def test_non_response_content_is_not_imported(self):
        self.assertIsNone(seed.response_quota_headers('=== REQUEST BODY ===\nAnthropic-Ratelimit-Unified-5h-Utilization: 0.9\n'))

if __name__ == '__main__':
    unittest.main()

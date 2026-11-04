"""Deterministic policy validation; no namespaces or host changes."""
import copy
import datetime
import importlib.util
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('owner', ROOT / 'src/main/experimental/network_owner.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
POLICY = json.loads((ROOT / 'src/main/workspaceNetworkAddressPolicy.json').read_text())
TODAY = datetime.date(2026, 11, 3)

class PolicyTests(unittest.TestCase):
    def test_current_and_inclusive_deadline(self):
        self.assertEqual(owner.validate_address_policy(POLICY, TODAY), owner.SPECIAL4)
        owner.validate_address_policy(POLICY, datetime.date(2026, 12, 3))

    def test_invalid_and_broadened_policy(self):
        changes = [dict(version=True), dict(externalIpv6='allow'),
                   dict(reviewDue='garbage'), dict(reviewDue='2027-01-01'),
                   dict(reviewed='2026-12-04'), dict(deniedIpv4=[]),
                   dict(deniedIpv4=list(owner.SPECIAL4)[1:]),
                   dict(deniedIpv4=[*owner.SPECIAL4, '::ffff:127.0.0.1/128']),
                   dict(deniedIpv4=[*owner.SPECIAL4, '10.0.0.1/8']),
                   dict(deniedIpv4=[*owner.SPECIAL4, owner.SPECIAL4[0]])]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(owner.NetworkError):
                owner.validate_address_policy({**copy.deepcopy(POLICY), **change}, TODAY)

    def test_expiration(self):
        with self.assertRaisesRegex(owner.NetworkError, 'NETWORK_ADDRESS_POLICY_REVIEW_REQUIRED'):
            owner.validate_address_policy(POLICY, datetime.date(2026, 12, 4))

    def test_conservative_addition(self):
        owner.validate_address_policy({**POLICY, 'deniedIpv4': [*owner.SPECIAL4, '8.8.8.0/24']}, TODAY)

if __name__ == '__main__':
    unittest.main(verbosity=2)

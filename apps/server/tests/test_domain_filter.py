import tempfile
import unittest
from pathlib import Path

from apps.server.app.privacy.domain_filter import (
    SensitiveDomainRules,
    drop_decision_for_url,
    load_sensitive_domain_rules,
    should_drop_host,
)


class DomainFilterTest(unittest.TestCase):
    def test_exact_and_subdomain_hosts_are_blocked(self) -> None:
        rules = SensitiveDomainRules(blocked_hosts=["chase.com"], blocked_host_keywords=[])

        self.assertTrue(drop_decision_for_url("https://chase.com/accounts", rules).should_drop)
        self.assertTrue(drop_decision_for_url("https://secure.chase.com/accounts", rules).should_drop)
        self.assertFalse(drop_decision_for_url("https://notchase.example/accounts", rules).should_drop)

    def test_host_path_entries_only_block_that_path_prefix(self) -> None:
        rules = SensitiveDomainRules(blocked_hosts=["github.com/settings"], blocked_host_keywords=[])

        self.assertTrue(drop_decision_for_url("https://github.com/settings/tokens", rules).should_drop)
        self.assertFalse(drop_decision_for_url("https://github.com/openai/codex", rules).should_drop)

    def test_keyword_hosts_are_blocked(self) -> None:
        rules = SensitiveDomainRules(blocked_hosts=[], blocked_host_keywords=["billing"])

        decision = drop_decision_for_url("https://billing.example.com/invoices", rules)

        self.assertTrue(decision.should_drop)
        self.assertEqual(decision.host, "billing.example.com")
        self.assertEqual(decision.reason, "blocked_keyword:billing")

    def test_legacy_host_helper_keeps_exact_and_subdomain_behavior(self) -> None:
        self.assertTrue(should_drop_host("secure.paypal.com", ["paypal.com"], []))
        self.assertFalse(should_drop_host("github.com", ["github.com/settings"], []))
        self.assertTrue(should_drop_host("auth.example.com", [], ["auth"]))

    def test_load_sensitive_domain_rules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "sensitive.yaml"
            config.write_text(
                "blocked_hosts:\n  - example.com\nblocked_host_keywords:\n  - secret\n",
                encoding="utf-8",
            )

            rules = load_sensitive_domain_rules(config)

        self.assertEqual(rules.blocked_hosts, ["example.com"])
        self.assertEqual(rules.blocked_host_keywords, ["secret"])


if __name__ == "__main__":
    unittest.main()

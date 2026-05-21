#!/usr/bin/env python3
"""Tests for iterate_cross_email_filter.py."""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from iterate_cross_email_filter import classify_email, filter_signups, gmail_normalize, redact_email  # noqa: E402


CFG = {
    "email_filter": {
        "rules": {
            "test_tlds": [".test", ".example", ".invalid", ".localhost", ".local"],
            "test_domains": ["example.com", "example.org", "example.net", "test.com", "email.com", "verify.com"],
            "test_suffixes": [".internal"],
            "team_domains": ["magpiexyz.io", "draftlabs.org"],
        },
        "team_emails": ["oculusmetaverse21@gmail.com", "anuragiitjee@gmail.com"],
        "plus_alias_team_prefixes": ["oculusmetaverse21"],
        "test_emails": ["known.real.looking@gmail.com"],
    }
}


def test_rfc_reserved_and_placeholder_domains_are_test():
    assert classify_email("a@test.example", CFG) == ("test", "rfc-reserved-tld")
    assert classify_email("a@site.local", CFG) == ("test", "rfc-reserved-tld")
    assert classify_email("a@example.com", CFG) == ("test", "placeholder-domain")


def test_team_domains_include_subdomains():
    assert classify_email("dev@magpiexyz.io", CFG) == ("team", "team-domain")
    assert classify_email("dev@gapsmith.draftlabs.org", CFG) == ("team", "team-domain")


def test_gmail_normalization_and_operator_overrides():
    assert gmail_normalize("anurag.iitj.ee@gmail.com") == "anuragiitjee@gmail.com"
    assert classify_email("anurag.iitj.ee@gmail.com", CFG) == ("team", "operator-team-email")
    assert classify_email("known.real.looking@gmail.com", CFG) == ("test", "operator-test-email")


def test_plus_alias_for_team_prefix_is_test():
    assert classify_email("oculusmetaverse21+foundry@gmail.com", CFG) == ("test", "team-plus-alias")


def test_redact_email_never_keeps_full_local_part():
    assert redact_email("anything@x.com") == "any***@x.com"
    assert redact_email("ab@x.com") == "ab***@x.com"


def test_filter_signups_counts_and_redacts():
    rows = [
        {"email": "real.user@example.org", "signup_at": "2026-05-01T00:00:00Z"},
        {"email": "customer@company.com", "signup_at": "2026-05-03T00:00:00Z"},
        {"email": "dev@magpiexyz.io", "signup_at": "2026-05-02T00:00:00Z"},
    ]
    result = filter_signups(rows, CFG)
    assert result["raw"] == 3
    assert result["real"] == 1
    assert result["team"] == 1
    assert result["test"] == 1
    assert result["first_real_signup_at"] == "2026-05-03T00:00:00Z"
    dumped = json.dumps(result)
    assert "customer@company.com" not in dumped
    assert "cus***@company.com" in dumped

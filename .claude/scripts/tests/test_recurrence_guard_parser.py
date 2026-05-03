#!/usr/bin/env python3
"""test_recurrence_guard_parser.py — RMG v2 Phase A.

Exercises `.claude/scripts/lib/recurrence_guard_parser.py` across full-mode
dict, light-mode bullet, list-of-bullets, legacy free-text, and invalid
shapes. Tolerant mode is toggled via the RMG_V2_TOLERANT env var.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / ".claude" / "scripts" / "lib"))

from recurrence_guard_parser import (  # noqa: E402
    KIND_VALUES,
    LEGACY_KIND,
    RATIONALE_MAX,
    UNGUARDABILITY_MIN,
    RecurrenceGuardParseError,
    parse,
)


def _strict_env(monkeypatch_value: str = "0"):
    """Context manager-ish helper that sets RMG_V2_TOLERANT to the given value."""

    class _Env:
        def __enter__(self):
            self.prev = os.environ.get("RMG_V2_TOLERANT")
            os.environ["RMG_V2_TOLERANT"] = monkeypatch_value
            return self

        def __exit__(self, *_):
            if self.prev is None:
                os.environ.pop("RMG_V2_TOLERANT", None)
            else:
                os.environ["RMG_V2_TOLERANT"] = self.prev

    return _Env()


class FullModeDictTests(unittest.TestCase):
    def test_each_kind_with_artifact(self):
        for kind in ("test", "lint", "hook", "invariant"):
            value = {
                "kind": kind,
                "artifact": f"path/to/{kind}.py",
                "rationale": f"covers the {kind} regression vector",
            }
            result = parse(value)
            self.assertEqual(result["kind"], kind)
            self.assertEqual(result["artifact"], f"path/to/{kind}.py")
            self.assertEqual(result["rationale"], f"covers the {kind} regression vector")
            self.assertNotIn("unguardability_rationale", result)

    def test_artifact_null_allowed_for_lint(self):
        # Lint kinds may point at a rule id rather than a path; null is also OK
        result = parse({"kind": "lint", "artifact": None, "rationale": "uses existing AOC rule"})
        self.assertIsNone(result["artifact"])

    def test_kind_none_requires_unguardability(self):
        rationale = "audit-by-review only"
        unguard = (
            "no executable check expresses this invariant because it is prose; "
            "human reviewers must inspect every PR for drift and observability "
            "monitors the docs site"
        )
        result = parse({
            "kind": "none",
            "artifact": None,
            "rationale": rationale,
            "unguardability_rationale": unguard,
        })
        self.assertEqual(result["kind"], "none")
        self.assertEqual(result["unguardability_rationale"], unguard)

    def test_kind_none_missing_unguardability_raises(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse({"kind": "none", "artifact": None, "rationale": "no check"})

    def test_kind_none_unguardability_too_short_raises(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse({
                "kind": "none",
                "artifact": None,
                "rationale": "rfc",
                "unguardability_rationale": "too short",
            })

    def test_kind_none_unguardability_missing_review_hint_raises(self):
        # Missing the (b) requirement: must mention a review/observ/monitor process
        unguard = (
            "no executable check expresses this invariant because it is prose. "
            "We will rely on developer discipline."
        )
        with self.assertRaises(RecurrenceGuardParseError):
            parse({
                "kind": "none",
                "artifact": None,
                "rationale": "n/a",
                "unguardability_rationale": unguard,
            })

    def test_unknown_kind_raises(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse({"kind": "manual", "artifact": "x", "rationale": "y"})

    def test_rationale_too_long_raises(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse({
                "kind": "test",
                "artifact": "x.py",
                "rationale": "a" * (RATIONALE_MAX + 1),
            })

    def test_rationale_empty_raises(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse({"kind": "test", "artifact": "x.py", "rationale": "   "})

    def test_artifact_blank_normalised_to_none(self):
        result = parse({"kind": "lint", "artifact": "  ", "rationale": "empty path"})
        self.assertIsNone(result["artifact"])


class LightModeBulletTests(unittest.TestCase):
    def test_single_bullet(self):
        text = "- kind=test | artifact=tests/foo_test.py | rationale=guards null path"
        result = parse(text)
        self.assertEqual(result["kind"], "test")
        self.assertEqual(result["artifact"], "tests/foo_test.py")
        self.assertEqual(result["rationale"], "guards null path")

    def test_artifact_null_token(self):
        text = "- kind=lint | artifact=null | rationale=existing AOC rule covers this"
        result = parse(text)
        self.assertIsNone(result["artifact"])

    def test_leading_whitespace_tolerated(self):
        text = "   - kind=hook | artifact=hooks/foo.sh | rationale=cli safety"
        result = parse(text)
        self.assertEqual(result["kind"], "hook")

    def test_list_with_one_bullet(self):
        result = parse([
            "- kind=invariant | artifact=type-system | rationale=enum exhaustiveness",
        ])
        self.assertEqual(result["kind"], "invariant")

    def test_multiple_bullets_rejected(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse([
                "- kind=test | artifact=a | rationale=x",
                "- kind=lint | artifact=b | rationale=y",
            ])

    def test_kind_none_in_light_mode_rejected(self):
        # Light mode cannot embed unguardability_rationale on the same bullet
        with self.assertRaises(RecurrenceGuardParseError):
            parse("- kind=none | artifact=null | rationale=no check")

    def test_extra_pipes_rejected(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse("- kind=test | artifact=a | rationale=b | extra=c")

    def test_unknown_kind_rejected(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse("- kind=manual | artifact=x | rationale=y")


class TolerantModeTests(unittest.TestCase):
    """Post-cutover: tolerant mode is OFF by default.

    `RMG_V2_TOLERANT=1` re-enables the legacy free-text escape hatch as an
    emergency-only switch. The default behavior rejects free-text entirely.
    """

    def test_legacy_freetext_tolerant_when_explicitly_enabled(self):
        with _strict_env("1"):
            result = parse("we will add a regression test in a follow-up PR")
            self.assertEqual(result["kind"], LEGACY_KIND)
            self.assertIsNone(result["artifact"])
            self.assertTrue(result["rationale"].startswith("we will add"))

    def test_legacy_freetext_default_off_rejects(self):
        # Clear the env var so the default (off) takes effect.
        prev = os.environ.pop("RMG_V2_TOLERANT", None)
        try:
            with self.assertRaises(RecurrenceGuardParseError):
                parse("we will add a regression test in a follow-up PR")
        finally:
            if prev is not None:
                os.environ["RMG_V2_TOLERANT"] = prev

    def test_legacy_freetext_explicit_off_rejects(self):
        with _strict_env("0"):
            with self.assertRaises(RecurrenceGuardParseError):
                parse("we will add a regression test in a follow-up PR")

    def test_dict_still_strict_under_tolerant(self):
        with _strict_env("1"):
            with self.assertRaises(RecurrenceGuardParseError):
                parse({"kind": "manual", "artifact": "x", "rationale": "y"})

    def test_long_legacy_truncated_when_tolerant(self):
        with _strict_env("1"):
            long_text = "x" * (RATIONALE_MAX + 50)
            result = parse(long_text)
            self.assertEqual(len(result["rationale"]), RATIONALE_MAX)


class TypeRejectionTests(unittest.TestCase):
    def test_none_value_rejected(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse(None)

    def test_int_value_rejected(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse(42)

    def test_empty_list_rejected(self):
        with self.assertRaises(RecurrenceGuardParseError):
            parse([])


class ConstantsTests(unittest.TestCase):
    def test_kinds_are_canonical(self):
        self.assertEqual(KIND_VALUES, ("test", "lint", "hook", "invariant", "none"))
        self.assertEqual(LEGACY_KIND, "legacy_freetext")
        self.assertEqual(RATIONALE_MAX, 200)
        self.assertGreaterEqual(UNGUARDABILITY_MIN, 80)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/ads_ready_static.py."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import ads_ready_static as S  # noqa: E402


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


class AdsReadyStaticOrchestratorTests(unittest.TestCase):
    def run_static(self, checks):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            context = root / "context.json"
            output = root / "result.json"
            write_json(context, {"mvp_root": str(root), "marker": "ctx"})
            with patch.object(S, "CHECKS", checks), patch("sys.stderr", new=io.StringIO()):
                rc = S.main(["--context", str(context), "--output", str(output)])
            return rc, json.loads(output.read_text(encoding="utf-8"))

    def test_all_checks_pass(self):
        calls = []

        def helper(ctx):
            calls.append(ctx["marker"])
            return True, "ok", None

        rc, result = self.run_static([(1, "one", helper, None), (2, "two", helper, None)])

        self.assertEqual(rc, 0)
        self.assertTrue(result["overall_pass"])
        self.assertEqual(result["passed_count"], 2)
        self.assertEqual(result["failed_count"], 0)
        self.assertEqual(calls, ["ctx", "ctx"])

    def test_some_checks_fail_and_results_accumulate(self):
        ran = []

        def passes(_ctx):
            ran.append("pass")
            return True, "ok", None

        def fails(_ctx):
            ran.append("fail")
            return False, "src/app/page.tsx:12 missing event", "Fix src/app/page.tsx:12"

        def applies_false(_ctx):
            ran.append("predicate")
            return False

        checks = [
            (1, "pass", passes, None),
            (2, "fail", fails, None),
            (3, "skip", passes, applies_false),
            (4, "pass again", passes, None),
        ]
        _rc, result = self.run_static(checks)

        self.assertFalse(result["overall_pass"])
        self.assertEqual(result["passed_count"], 2)
        self.assertEqual(result["failed_count"], 1)
        self.assertEqual(result["skipped_count"], 1)
        self.assertEqual(ran, ["pass", "fail", "predicate", "pass"])

    def test_internal_error_does_not_crash(self):
        def raises(_ctx):
            raise RuntimeError("boom")

        def passes(_ctx):
            return True, "still ran", None

        rc, result = self.run_static([(1, "raises", raises, None), (2, "passes", passes, None)])

        self.assertEqual(rc, 0)
        self.assertFalse(result["overall_pass"])
        self.assertEqual(result["failed_count"], 1)
        self.assertEqual(result["passed_count"], 1)
        self.assertIn("INTERNAL ERROR: boom", result["checks"][0]["details"])

    def test_schema_conformance(self):
        def helper(_ctx):
            return True, "ok", None

        _rc, result = self.run_static([(1, "one", helper, None)])

        self.assertEqual(result["skill"], "ads-ready")
        self.assertEqual(result["layer"], "A")
        for key in (
            "timestamp",
            "checks",
            "overall_pass",
            "applicable_count",
            "passed_count",
            "failed_count",
            "skipped_count",
        ):
            self.assertIn(key, result)
        self.assertEqual(
            set(result["checks"][0]),
            {"id", "name", "applicable", "passed", "details", "fix"},
        )


if __name__ == "__main__":
    unittest.main()

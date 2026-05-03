#!/usr/bin/env python3
"""test_dossier_builder.py — RMG v2 Phase C.

Exercises `.claude/scripts/lib/dossier_builder.py`:
  * Phase 1a withholds failure_mode / what_was_missed / prior_commit_sha
  * Phase 4b is a strict superset of phase_1a fields
  * Rows outside the divergence file set OR composite_hash match are skipped
  * Window cutoff drops old rows
  * Template-edit ledger rows are skipped
  * Multiple runs with same composite get the same occurrence_count_60d
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / ".claude" / "scripts" / "lib"))

from dossier_builder import DOSSIER_WINDOW_DAYS_DEFAULT, build_dossier  # noqa: E402


def _row(**kwargs):
    base = {
        "fix_id": "x:1",
        "agent": "resolve-fixer",
        "run_id": "run-1",
        "file": "foo/bar.ts",
        "symptom": "undefined is not a function at bar.ts:10",
        "fix": "add null check",
        "timestamp": "2026-04-15T10:00:00Z",
        "batch_id": "b1",
        "batch_size": 1,
        "provenance": "agent",
        "severity": "high",
    }
    base.update(kwargs)
    return base


class DossierShapeTests(unittest.TestCase):
    """Assert the contract: phase_1a is minimal, phase_4b is the superset."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rmg-dossier-")
        self.runs = Path(self.tmp) / ".runs"
        self.runs.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_ledger(self, rows):
        with (self.runs / "fix-ledger.jsonl").open("w") as fh:
            for row in rows:
                fh.write(json.dumps(row) + "\n")

    def test_phase_1a_withholds_prose(self):
        self._write_ledger([
            _row(run_id="r1", timestamp="2026-04-15T10:00:00Z"),
            _row(run_id="r2", timestamp="2026-04-20T10:00:00Z"),
        ])
        d = build_dossier(
            divergence_files=["foo/bar.ts"],
            symptom_signature="undefined",
            project_dir=self.tmp,
            since_days=3650,
        )
        self.assertEqual(len(d["phase_1a"]), 2)
        for entry in d["phase_1a"]:
            self.assertNotIn("failure_mode", entry)
            self.assertNotIn("what_was_missed", entry)
            self.assertNotIn("prior_commit_sha", entry)
            for key in ("prior_run_id", "files_touched", "regression_test_present", "occurrence_count_60d"):
                self.assertIn(key, entry)

    def test_phase_4b_is_superset(self):
        self._write_ledger([
            _row(run_id="r1", timestamp="2026-04-15T10:00:00Z"),
            _row(run_id="r2", timestamp="2026-04-20T10:00:00Z"),
        ])
        d = build_dossier(
            divergence_files=["foo/bar.ts"],
            symptom_signature="undefined",
            project_dir=self.tmp,
            since_days=3650,
        )
        for slim, full in zip(d["phase_1a"], d["phase_4b"]):
            self.assertEqual(slim["prior_run_id"], full["prior_run_id"])
            self.assertEqual(slim["files_touched"], full["files_touched"])
            self.assertEqual(slim["regression_test_present"], full["regression_test_present"])
            self.assertEqual(slim["occurrence_count_60d"], full["occurrence_count_60d"])
            self.assertIn("failure_mode", full)
            self.assertIn("what_was_missed", full)
            self.assertIn("prior_commit_sha", full)

    def test_files_outside_divergence_skipped(self):
        self._write_ledger([
            _row(run_id="r1", file="other/elsewhere.ts"),
            _row(run_id="r2", file="foo/bar.ts"),
        ])
        d = build_dossier(
            divergence_files=["foo/bar.ts"],
            symptom_signature="undefined",
            project_dir=self.tmp,
            since_days=3650,
        )
        run_ids = {e["prior_run_id"] for e in d["phase_1a"]}
        self.assertEqual(run_ids, {"r2"})

    def test_window_cutoff(self):
        self._write_ledger([
            _row(run_id="ancient", timestamp="2024-01-01T00:00:00Z"),
            _row(run_id="recent", timestamp="2026-04-20T10:00:00Z"),
        ])
        d = build_dossier(
            divergence_files=["foo/bar.ts"],
            symptom_signature="undefined",
            project_dir=self.tmp,
            since_days=60,
            now=datetime(2026, 5, 1, tzinfo=timezone.utc),
        )
        run_ids = {e["prior_run_id"] for e in d["phase_1a"]}
        self.assertEqual(run_ids, {"recent"})

    def test_template_edit_rows_skipped(self):
        self._write_ledger([
            {
                "fix_id": "te:1",
                "agent": "lead",
                "run_id": "te-run",
                "file": "foo/bar.ts",
                "entry_type": "template-edit",
                "before_hash": "a",
                "after_hash": "b",
                "timestamp": "2026-04-20T10:00:00Z",
                "batch_id": "b",
                "batch_size": 1,
                "provenance": "lead",
                "severity": "warn",
            },
        ])
        d = build_dossier(
            divergence_files=["foo/bar.ts"],
            symptom_signature="x",
            project_dir=self.tmp,
            since_days=3650,
        )
        self.assertEqual(d["phase_1a"], [])

    def test_occurrence_count_60d_per_composite(self):
        self._write_ledger([
            _row(run_id="r1", timestamp="2026-04-15T10:00:00Z", symptom="undefined at bar.ts:10"),
            _row(run_id="r2", timestamp="2026-04-20T10:00:00Z", symptom="undefined at bar.ts:11"),
            _row(run_id="r3", timestamp="2026-04-25T10:00:00Z", symptom="undefined at bar.ts:99"),
        ])
        d = build_dossier(
            divergence_files=["foo/bar.ts"],
            symptom_signature="undefined",
            project_dir=self.tmp,
            since_days=3650,
        )
        # All three rows canonicalize equal → same composite, occurrence_count = 3 each
        self.assertTrue(all(e["occurrence_count_60d"] == 3 for e in d["phase_1a"]))

    def test_no_ledger_returns_empty(self):
        d = build_dossier(
            divergence_files=["foo/bar.ts"],
            symptom_signature="x",
            project_dir=self.tmp,
            since_days=3650,
        )
        self.assertEqual(d, {"phase_1a": [], "phase_4b": []})


class DefaultsTests(unittest.TestCase):
    def test_default_window_60_days(self):
        self.assertEqual(DOSSIER_WINDOW_DAYS_DEFAULT, 60)


if __name__ == "__main__":
    unittest.main()

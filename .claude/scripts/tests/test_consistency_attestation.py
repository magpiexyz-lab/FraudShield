#!/usr/bin/env python3
"""test_consistency_attestation.py — #1257 closure-criterion helper tests.

Exercises .claude/scripts/check-1257-attestation.py:
  * exit 0 + ATTESTED when at least one record satisfies the 4-field criterion
    (provenance=lead-merge AND csi_count>=2 AND pages>=12 AND status=completed).
  * exit 1 + NOT ATTESTED when csi_count below threshold.
  * exit 1 + NOT ATTESTED when pages_reviewed_total below threshold.
  * exit 1 + 'no telemetry yet' when file is absent or empty.

The helper applies the predicate at READ time — these tests lock that behavior
so future criterion changes do not strand existing telemetry records.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import subprocess as _sp


REPO_ROOT = Path(__file__).resolve().parents[3]
HELPER = REPO_ROOT / ".claude" / "scripts" / "check-1257-attestation.py"


def _run_helper(telemetry_path: Path) -> tuple[int, str, str]:
    proc = _sp.run(
        ["python3", str(HELPER), "--telemetry-path", str(telemetry_path)],
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _write_jsonl(path: Path, records: list[dict]) -> None:
    with open(path, "w") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")


def _attesting_record(**overrides) -> dict:
    """Baseline record that satisfies the criterion. Tests override one field
    at a time to verify each gate."""
    base = {
        "provenance": "lead-merge",
        "contributing_spawn_indexes_count": 2,
        "contributing_spawn_indexes": [0, 1],
        "pages_reviewed_total": 12,
        "status": "completed",
        "partition_size": 2,
        "verdict": "pass",
        "run_id": "test",
        "timestamp": "2026-05-12T00:00:00+00:00",
    }
    base.update(overrides)
    return base


class TestAttestationHelper(unittest.TestCase):
    def test_attested_when_record_satisfies_criterion(self):
        """All 4 criterion fields match -> exit 0, stdout 'ATTESTED'."""
        with TemporaryDirectory() as td:
            path = Path(td) / "telemetry.jsonl"
            _write_jsonl(path, [_attesting_record()])
            rc, out, err = _run_helper(path)
            self.assertEqual(rc, 0, f"expected exit 0; got {rc}; stderr={err}")
            self.assertIn("ATTESTED", out)

    def test_not_attested_by_csi_count(self):
        """csi_count below threshold (1<2) -> exit 1."""
        with TemporaryDirectory() as td:
            path = Path(td) / "telemetry.jsonl"
            _write_jsonl(path, [
                _attesting_record(
                    contributing_spawn_indexes_count=1,
                    contributing_spawn_indexes=[0],
                ),
            ])
            rc, _, err = _run_helper(path)
            self.assertEqual(rc, 1)
            self.assertIn("NOT ATTESTED", err)

    def test_not_attested_by_pages_count(self):
        """pages_reviewed_total below threshold (10<12) -> exit 1."""
        with TemporaryDirectory() as td:
            path = Path(td) / "telemetry.jsonl"
            _write_jsonl(path, [_attesting_record(pages_reviewed_total=10)])
            rc, _, err = _run_helper(path)
            self.assertEqual(rc, 1)
            self.assertIn("NOT ATTESTED", err)

    def test_not_attested_when_no_telemetry_file(self):
        """File absent -> exit 1, 'no telemetry yet' diagnostic."""
        with TemporaryDirectory() as td:
            path = Path(td) / "nonexistent.jsonl"
            rc, _, err = _run_helper(path)
            self.assertEqual(rc, 1)
            self.assertIn("no telemetry yet", err)


if __name__ == "__main__":
    unittest.main()

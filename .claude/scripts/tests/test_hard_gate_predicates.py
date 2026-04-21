#!/usr/bin/env python3
"""test_hard_gate_predicates.py — exercise check_hard_gate_predicates in lib-verdict.sh.

Each test constructs a trace + a synthetic verify-report.md CONTENT
(simulating the Write payload) and invokes the function from lib-verdict.sh.
Validates the predicate semantics that ultimately decide whether
verify-report-gate.sh allows `hard_gate_failure:false`.

Predicates covered:
  - pass_self_pass_or_fail
  - validated_fallback
  - aggregate_ok (lead-merge + contributing_spawn_indexes count match)
  - legacy_pass_no_recovery
  - additional_block_conditions (eq, gt, all)

Run: python3 .claude/scripts/tests/test_hard_gate_predicates.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
LIB = ROOT / ".claude/hooks/lib.sh"


class TestHardGatePredicates(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="test_hgp_"))
        subprocess.run(["git", "init", "-q", str(self.tmp)], check=True)
        shutil.copytree(ROOT / ".claude", self.tmp / ".claude", dirs_exist_ok=True)
        self.runs = self.tmp / ".runs"
        self.runs.mkdir()
        self.traces = self.runs / "agent-traces"
        self.traces.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_trace(self, name: str, data: dict):
        (self.traces / f"{name}.json").write_text(json.dumps(data, indent=2))

    def _invoke(self, agent: str, report_content: str) -> tuple[str, int]:
        """Source lib.sh, set CONTENT + ERRORS, call check_hard_gate_predicates,
        print ERRORS array. Returns (stderr_joined, exit_code)."""
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(self.tmp)
        trace_dir = str(self.traces)
        # We quote the content carefully via bash heredoc
        script = f"""
source '{LIB}'
CONTENT={json.dumps(report_content)}
ERRORS=()
check_hard_gate_predicates '{agent}' '{trace_dir}'
if (( ${{#ERRORS[@]}} > 0 )); then
  for e in "${{ERRORS[@]}}"; do printf 'ERR: %s\\n' "$e"; done
fi
"""
        proc = subprocess.run(
            ["bash", "-c", script],
            capture_output=True, text=True, env=env, timeout=15,
        )
        return proc.stdout + proc.stderr, proc.returncode

    # ---- pass_self_pass_or_fail ----

    def test_pass_self_allows_pass_without_gate_flag(self):
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "pass",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out, f"pass_self=pass should allow without gate flag, got {out}")

    def test_pass_self_allows_fail(self):
        # design-critic allow_predicates includes pass_self_pass_or_fail, so
        # verdict:fail provenance:self should still pass (caller records fail elsewhere)
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "fail",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out)

    def test_pass_self_rejects_unresolved(self):
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "unresolved",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertIn("ERR:", out)
        self.assertIn("no allow_predicate satisfied", out)

    def test_pass_self_accepts_when_report_sets_gate_true(self):
        # Same failing trace, but report declares hard_gate_failure:true → no error
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "unresolved",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: true\n")
        self.assertNotIn("ERR:", out)

    # ---- validated_fallback ----

    def test_recovery_validated_allows(self):
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "recovery",
            "provenance": "recovery",
            "partial": True,
            "recovery": True,
            "recovery_validated": True,
            "checks_performed": ["exhaustion-recovery"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out, f"recovery+validated should allow, got {out}")

    def test_recovery_not_validated_blocks(self):
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "recovery",
            "provenance": "recovery",
            "partial": True,
            "recovery": True,
            "recovery_validated": False,
            "checks_performed": ["exhaustion-recovery"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertIn("ERR:", out)

    def test_self_degraded_validated_allows(self):
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "degraded",
            "provenance": "self-degraded",
            "partial": True,
            "degraded_reason": "image limit",
            "recovery_validated": True,
            "checks_performed": ["layer1"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out)

    # ---- aggregate_ok (lead-merge) ----

    def test_lead_merge_allows_when_siblings_pass(self):
        # Aggregate
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "pass",
            "provenance": "lead-merge",
            "partial": True,
            "contributing_spawn_indexes": [1, 2],
            "checks_performed": ["merge"],
        })
        # Two sibling traces, both self+pass
        self._write_trace("design-critic-landing", {
            "agent": "design-critic",
            "verdict": "pass",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        self._write_trace("design-critic-pricing", {
            "agent": "design-critic",
            "verdict": "pass",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out, f"lead-merge with good siblings should allow, got {out}")

    def test_lead_merge_blocks_when_sibling_unresolved(self):
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "pass",
            "provenance": "lead-merge",
            "partial": True,
            "contributing_spawn_indexes": [1, 2],
            "checks_performed": ["merge"],
        })
        self._write_trace("design-critic-landing", {
            "agent": "design-critic",
            "verdict": "pass",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        # sibling with unresolved + self — not satisfying pass_self_pass_or_fail
        self._write_trace("design-critic-pricing", {
            "agent": "design-critic",
            "verdict": "unresolved",
            "provenance": "self",
            "partial": False,
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertIn("ERR:", out)

    def test_lead_merge_blocks_when_csi_missing(self):
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "pass",
            "provenance": "lead-merge",
            "partial": True,
            "checks_performed": ["merge"],
            # contributing_spawn_indexes absent
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertIn("ERR:", out)

    # ---- legacy_pass_no_recovery ----

    def test_legacy_pass_no_recovery_allows_unmigrated(self):
        # Legacy trace: no provenance field, verdict=pass, recovery absent
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "pass",
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out, "legacy pass+no-recovery should allow without gate flag")

    def test_legacy_recovery_true_blocks_without_gate_flag(self):
        # Legacy recovery-tainted trace
        self._write_trace("design-critic", {
            "agent": "design-critic",
            "verdict": "recovery",
            "recovery": True,
            "checks_performed": ["x"],
        })
        out, _ = self._invoke("design-critic", "hard_gate_failure: false\n")
        self.assertIn("ERR:", out)

    # ---- additional_block_conditions ----

    def test_ux_journeyer_unresolved_dead_ends_blocks(self):
        # ux-journeyer has additional_block_conditions: unresolved_dead_ends > 0
        self._write_trace("ux-journeyer", {
            "agent": "ux-journeyer",
            "verdict": "pass",
            "provenance": "self",
            "partial": False,
            "unresolved_dead_ends": 3,
            "checks_performed": ["journey"],
        })
        out, _ = self._invoke("ux-journeyer", "hard_gate_failure: false\n")
        self.assertIn("ERR:", out, "unresolved_dead_ends>0 must block even with pass verdict")

    def test_ux_journeyer_pass_zero_dead_ends_allows(self):
        self._write_trace("ux-journeyer", {
            "agent": "ux-journeyer",
            "verdict": "pass",
            "provenance": "self",
            "partial": False,
            "unresolved_dead_ends": 0,
            "checks_performed": ["journey"],
        })
        out, _ = self._invoke("ux-journeyer", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out)

    def test_security_fixer_partial_with_unresolved_critical_blocks(self):
        # security-fixer additional_block_conditions uses all: [verdict=partial, unresolved_critical>0]
        self._write_trace("security-fixer", {
            "agent": "security-fixer",
            "verdict": "partial",
            "provenance": "self",
            "partial": False,
            "unresolved_critical": 2,
            "checks_performed": ["fix"],
        })
        out, _ = self._invoke("security-fixer", "hard_gate_failure: false\n")
        self.assertIn("ERR:", out)

    def test_no_trace_file_is_noop(self):
        out, _ = self._invoke("nonexistent-agent", "hard_gate_failure: false\n")
        self.assertNotIn("ERR:", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)

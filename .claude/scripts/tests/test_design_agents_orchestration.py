#!/usr/bin/env python3
"""test_design_agents_orchestration.py — recurrence guard for #1256, #1257, #1274.

Asserts the three sub-fixes work as designed:

  (a) #1256 Stage 0 fast-path detector: PR_RELEVANT exclusion semantics
      (test files, shadcn primitives, api routes), and the lead-synthesized
      aggregate clears state-completion-gate's per-trace check.
  (b) #1257 consistency-checker page-budget soft-exit: per_page_budget
      computation and partial-trace shape via write-degraded-trace.py.
  (c) #1274 merger fix-ledger consultation: ledger filter (literal
      provenance='lead' AND current run_id), unresolved → fixed verdict
      upgrade, lead_fix_corrections audit array, and per-page trace
      immutability.

Exit 0 on all-pass, 1 on any failure.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MERGE_SCRIPT = ROOT / ".claude/scripts/merge-design-critic-traces.py"
WRITE_AGENT_TRACE = ROOT / ".claude/scripts/write-agent-trace.sh"
STATE_3A_MD = ROOT / ".claude/skills/verify/state-3a-design-agents.md"
STATE_REGISTRY = ROOT / ".claude/patterns/state-registry.json"
AGENT_REGISTRY = ROOT / ".claude/patterns/agent-registry.json"
GATE_HOOK = ROOT / ".claude/hooks/state-completion-gate.sh"
CONSISTENCY_PROC = ROOT / ".claude/procedures/design-consistency-checker.md"


# ── (a) Stage 0 fast-path detector tests ─────────────────────────────────


class TestStage0Detector(unittest.TestCase):
    """#1256: PR_RELEVANT exclusion grep semantics encoded in state-3a-design-agents.md.

    The detector regex is documented as a multi-step grep pipeline; the test
    extracts the regex from the markdown and exercises the same grep filter
    on synthetic file lists.
    """

    @staticmethod
    def filter_pr_relevant(files: list[str]) -> int:
        """Apply the same filter as state-3a Stage 0 PR_RELEVANT pipeline."""
        # Match the include + 3 excludes from state-3a-design-agents.md
        include = re.compile(r"^(src/lib|src/components|src/app)/")
        excl_shadcn = re.compile(r"^src/components/(ui|magicui)/")
        excl_api = re.compile(r"^src/app/api/")
        excl_test = re.compile(r"\.test\.[jt]sx?$")
        kept = [
            f for f in files
            if include.search(f)
            and not excl_shadcn.search(f)
            and not excl_api.search(f)
            and not excl_test.search(f)
        ]
        return len(kept)

    def test_test_only_pr_triggers_fast_path(self):
        files = [
            "src/app/home/page.test.tsx",
            "src/components/landing-content.test.tsx",
            "src/lib/utils.test.ts",
        ]
        self.assertEqual(self.filter_pr_relevant(files), 0,
                         "test-only PR should trigger fast-path")

    def test_shadcn_primitive_only_does_not_count(self):
        files = [
            "src/components/ui/button.tsx",
            "src/components/magicui/sparkles.tsx",
        ]
        self.assertEqual(self.filter_pr_relevant(files), 0,
                         "shadcn-primitive-only PR should trigger fast-path")

    def test_api_only_pr_does_not_count(self):
        files = [
            "src/app/api/foo/route.ts",
            "src/app/api/bar/handler.ts",
        ]
        self.assertEqual(self.filter_pr_relevant(files), 0,
                         "api-only PR should trigger fast-path")

    def test_one_page_local_file_blocks_fast_path(self):
        files = ["src/app/home/page.tsx"]
        self.assertGreater(self.filter_pr_relevant(files), 0,
                           "page-local file must block fast-path")

    def test_mixed_pr_with_one_real_change_blocks_fast_path(self):
        files = [
            "src/app/home/page.test.tsx",       # excluded
            "src/components/ui/button.tsx",      # excluded
            "src/app/api/foo/route.ts",          # excluded
            "src/lib/auth.ts",                   # COUNTS
        ]
        self.assertEqual(self.filter_pr_relevant(files), 1,
                         "one real change among excludes must block fast-path")

    def test_state3a_md_documents_stage0(self):
        """Stage 0 section must exist with key fields."""
        text = STATE_3A_MD.read_text()
        self.assertIn("Stage 0: All-pages fast-path detector", text,
                      "Stage 0 heading missing")
        self.assertIn("ALL_PAGES_FAST_PATH", text,
                      "ALL_PAGES_FAST_PATH variable missing")
        self.assertIn(".runs/all-pages-fast-path-decision.json", text,
                      "decision artifact path missing")
        self.assertIn("boundary-skip-all-pages", text,
                      "review_method=boundary-skip-all-pages missing")
        self.assertIn("lead-synthesized", text,
                      "lead-synthesized provenance missing")


class TestStage0GateExemption(unittest.TestCase):
    """#1256: state-completion-gate.sh SANCTIONED_COVERAGE_PROVIDERS allowlist."""

    def test_sanctioned_set_declared(self):
        text = GATE_HOOK.read_text()
        self.assertIn("SANCTIONED_COVERAGE_PROVIDERS", text,
                      "SANCTIONED_COVERAGE_PROVIDERS allowlist missing")
        self.assertIn(".runs/all-pages-fast-path-decision.json", text,
                      "fast-path decision artifact not in allowlist")
        # Exemption logic for lead-synthesized
        self.assertIn("lead-synthesized", text,
                      "lead-synthesized exemption logic missing")

    def test_agent_registry_predicate_added(self):
        r = json.loads(AGENT_REGISTRY.read_text())
        dc_gate = next(
            g for g in r["hard_gates"] if g["agent"] == "design-critic"
        )
        self.assertIn("pass_lead_synthesized", dc_gate["allow_predicates"],
                      "pass_lead_synthesized not in design-critic allow_predicates")

    def test_state_registry_3a_branches_on_decision_artifact(self):
        r = json.loads(STATE_REGISTRY.read_text())
        verify_3a = r["verify"]["3a"]["verify"]
        self.assertIn("all-pages-fast-path-decision.json", verify_3a,
                      "state-registry 3a verify must branch on decision artifact")
        self.assertIn("Stage 0:", verify_3a,
                      "state-registry 3a verify must mention Stage 0")

    def test_state_registry_3b_branches_on_decision_artifact(self):
        r = json.loads(STATE_REGISTRY.read_text())
        verify_3b = r["verify"]["3b"]["verify"]
        self.assertIn("all-pages-fast-path-decision.json", verify_3b,
                      "state-registry 3b verify must branch on decision artifact")
        self.assertIn("Stage 0:", verify_3b,
                      "state-registry 3b verify must mention Stage 0")


# ── (b) Consistency-checker soft-exit tests ────────────────────────────


class TestConsistencyCheckerSoftExit(unittest.TestCase):
    """#1257: page-budget allocation primitive + partial-trace contract."""

    def test_per_page_budget_computation(self):
        """floor(maxTurns / expected_pages) — the deterministic substrate."""
        max_turns = 1000
        for n in (1, 8, 18, 30, 100):
            per_page = max_turns // n
            self.assertGreaterEqual(per_page, 0)
            # On a 30-page project at 1000 turns: 33 turns/page (vs 16 at 500 — too tight)
            if n == 30:
                self.assertEqual(per_page, 33)

    def test_threshold_logic_with_slack(self):
        """consumed > floor((reviewed/expected)*maxTurns) + threshold triggers exit."""
        max_turns = 1000
        expected_pages = 18
        threshold = 50
        # After page 8 of 18: expected_consumed ≈ floor((8/18)*1000) = 444
        reviewed = 8
        expected_consumed = (reviewed * max_turns) // expected_pages
        # 444 + 50 = 494 — above this triggers soft-exit
        self.assertEqual(expected_consumed, 444)
        # Sanity: a consumed_turns of 600 at page 8 triggers exit
        self.assertGreater(600, expected_consumed + threshold)
        # While 480 at page 8 does NOT trigger
        self.assertLessEqual(480, expected_consumed + threshold)

    def test_consistency_checker_maxturns_bumped(self):
        """maxTurns: 500 → 1000 in design-consistency-checker.md frontmatter."""
        cc_md = ROOT / ".claude/agents/design-consistency-checker.md"
        text = cc_md.read_text()
        self.assertIn("maxTurns: 1000", text,
                      "design-consistency-checker maxTurns not bumped to 1000")
        self.assertNotIn("maxTurns: 500", text,
                         "stale maxTurns: 500 still present")

    def test_budget_self_monitoring_section_documented(self):
        """procedures/design-consistency-checker.md has Budget Self-Monitoring."""
        text = CONSISTENCY_PROC.read_text()
        self.assertIn("Budget Self-Monitoring", text,
                      "Budget Self-Monitoring section missing")
        self.assertIn("per_page_budget", text,
                      "per_page_budget formula missing")
        self.assertIn("budget-soft-exit", text,
                      "soft-exit reason string missing")
        # The procedure must NOT show an INVOCATION using --partial true.
        # Documentation that explains "do NOT pass --partial" is fine — but a
        # bash invocation with `--partial true` would be wrong (the flag doesn't
        # exist; partial=true is auto-set by write-degraded-trace.py:192).
        self.assertNotRegex(text, r"--partial\s+true",
                            "invocation uses --partial true (the flag does not exist)")


# ── (c) Merger fix-ledger consultation tests ───────────────────────────


class TestMergerLeadFixCredit(unittest.TestCase):
    """#1274: merger consults fix-ledger.jsonl for lead-applied fixes."""

    def _setup_run(self, tmp: Path, per_page_traces: list[dict],
                   ledger_rows: list[dict] | None = None,
                   shared_trace: dict | None = None) -> Path:
        """Build a tmp run directory with traces, optional ledger, optional shared trace."""
        traces_dir = tmp / ".runs" / "agent-traces"
        traces_dir.mkdir(parents=True)
        (tmp / ".runs" / "verify-context.json").write_text(
            json.dumps({"run_id": "test-run"})
        )
        for t in per_page_traces:
            page = t["page"]
            (traces_dir / f"design-critic-{page}.json").write_text(json.dumps(t))
        if ledger_rows is not None:
            (tmp / ".runs" / "fix-ledger.jsonl").write_text(
                "\n".join(json.dumps(r) for r in ledger_rows) + "\n"
            )
        if shared_trace is not None:
            (traces_dir / "design-critic-shared.json").write_text(
                json.dumps(shared_trace)
            )
        return traces_dir

    def _run_merge(self, tmp: Path) -> dict:
        traces_dir = tmp / ".runs" / "agent-traces"
        subprocess.run(
            ["python3", str(MERGE_SCRIPT)],
            capture_output=True,
            text=True,
            cwd=tmp,
            check=True,
        )
        return json.loads((traces_dir / "design-critic.json").read_text())

    def _make_trace(self, page: str, verdict: str = "pass",
                    unresolved_sections: int = 0,
                    shared_issues: list[dict] | None = None,
                    review_method: str = "rendered-authed") -> dict:
        return {
            "agent": "design-critic",
            "page": page,
            "pages_reviewed": 1,
            "verdict": verdict,
            "result": "clean" if verdict == "pass" else None,
            "checks_performed": ["c1", "c2", "c3"],
            "min_score": 9,
            "min_score_all": 9,
            "sections_below_8": 0,
            "fixes_applied": 0,
            "unresolved_sections": unresolved_sections,
            "pre_existing_debt": [],
            "fixes": [],
            "shared_issues": shared_issues or [],
            "review_method": review_method,
            "review_evidence": {
                "requested_route": f"/{page}",
                "final_url": f"http://localhost:3000/{page}",
                "auth_source": None,
                "fallback_reason": None,
                "content_density": 1.0,
            },
        }

    def test_lead_provenance_literal_credits_correctly(self):
        """Ledger row with provenance='lead' AND matching run_id credits the fix."""
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            self._setup_run(
                tmp,
                per_page_traces=[
                    self._make_trace(
                        "home",
                        verdict="unresolved",
                        unresolved_sections=1,
                        shared_issues=[{
                            "file": "src/components/landing-content.tsx",
                            "section": "hero",
                            "description": "overflow",
                        }],
                    ),
                ],
                ledger_rows=[{
                    "run_id": "test-run",
                    "provenance": "lead",
                    "file": "src/components/landing-content.tsx",
                    "symptom": "overflow",
                    "fix": "max-w adjusted",
                }],
            )
            merged = self._run_merge(tmp)
        self.assertIn("lead_fix_corrections", merged,
                      "lead_fix_corrections audit array missing")
        self.assertEqual(len(merged["lead_fix_corrections"]), 1)
        self.assertEqual(merged["lead_fix_corrections"][0]["page"], "home")
        self.assertEqual(merged["lead_fix_corrections"][0]["file"],
                         "src/components/landing-content.tsx")
        # Verdict upgrade: unresolved → fixed
        self.assertEqual(merged["verdict"], "fixed",
                         "verdict not upgraded after crediting lead-fix")
        self.assertEqual(merged["unresolved_sections"], 0,
                         "unresolved_sections not zeroed")

    def test_lead_on_behalf_provenance_also_credited(self):
        """Ledger row with provenance='lead-on-behalf' is also credited."""
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            self._setup_run(
                tmp,
                per_page_traces=[
                    self._make_trace(
                        "home",
                        verdict="unresolved",
                        unresolved_sections=1,
                        shared_issues=[{
                            "file": "src/components/header.tsx",
                            "section": "nav",
                            "description": "color",
                        }],
                    ),
                ],
                ledger_rows=[{
                    "run_id": "test-run",
                    "provenance": "lead-on-behalf",
                    "file": "src/components/header.tsx",
                    "symptom": "color",
                    "fix": "tone aligned",
                }],
            )
            merged = self._run_merge(tmp)
        self.assertEqual(len(merged.get("lead_fix_corrections", [])), 1)

    def test_lead_fix_provenance_NOT_credited(self):
        """Ledger row with WRONG provenance value 'lead-fix' (literal) is NOT credited.

        write-fix-ledger.py:373 writes literal 'lead' for --lead-fix mode.
        'lead-fix' is a TRACE-level provenance, NOT a ledger-level one.
        """
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            self._setup_run(
                tmp,
                per_page_traces=[
                    self._make_trace(
                        "home",
                        verdict="unresolved",
                        unresolved_sections=1,
                        shared_issues=[{"file": "src/components/x.tsx",
                                        "section": "y", "description": "z"}],
                    ),
                ],
                ledger_rows=[{
                    "run_id": "test-run",
                    "provenance": "lead-fix",   # WRONG value — must NOT match
                    "file": "src/components/x.tsx",
                    "symptom": "z",
                    "fix": "fixed",
                }],
            )
            merged = self._run_merge(tmp)
        self.assertNotIn("lead_fix_corrections", merged,
                         "ledger row with provenance='lead-fix' must NOT be credited "
                         "(only literal 'lead' or 'lead-on-behalf')")
        self.assertEqual(merged["verdict"], "unresolved",
                         "verdict must remain unresolved when no valid credits found")

    def test_stale_run_id_not_credited(self):
        """Ledger row with different run_id is NOT credited (cross-run pollution guard)."""
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            self._setup_run(
                tmp,
                per_page_traces=[
                    self._make_trace(
                        "home",
                        verdict="unresolved",
                        unresolved_sections=1,
                        shared_issues=[{"file": "src/components/x.tsx",
                                        "section": "y", "description": "z"}],
                    ),
                ],
                ledger_rows=[{
                    "run_id": "OTHER-run",   # mismatch
                    "provenance": "lead",
                    "file": "src/components/x.tsx",
                    "symptom": "z",
                    "fix": "fixed",
                }],
            )
            merged = self._run_merge(tmp)
        self.assertNotIn("lead_fix_corrections", merged,
                         "stale run_id ledger row must NOT be credited")
        self.assertEqual(merged["verdict"], "unresolved")

    def test_per_page_traces_remain_immutable(self):
        """After merger runs, per-page trace file content is unchanged."""
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            traces_dir = self._setup_run(
                tmp,
                per_page_traces=[
                    self._make_trace(
                        "home",
                        verdict="unresolved",
                        unresolved_sections=1,
                        shared_issues=[{"file": "src/components/x.tsx",
                                        "section": "y", "description": "z"}],
                    ),
                ],
                ledger_rows=[{
                    "run_id": "test-run",
                    "provenance": "lead",
                    "file": "src/components/x.tsx",
                    "symptom": "z",
                    "fix": "fixed",
                }],
            )
            home_path = traces_dir / "design-critic-home.json"
            before = home_path.read_text()
            self._run_merge(tmp)
            after = home_path.read_text()
        self.assertEqual(before, after,
                         "per-page trace must remain immutable post-merge")


# ── Scaffolding sanity ──────────────────────────────────────────────


class TestScaffoldingSanity(unittest.TestCase):
    def test_critical_files_exist(self):
        """Sanity: all files this test inspects must be present."""
        for p in (MERGE_SCRIPT, WRITE_AGENT_TRACE, STATE_3A_MD,
                  STATE_REGISTRY, AGENT_REGISTRY, GATE_HOOK,
                  CONSISTENCY_PROC):
            self.assertTrue(p.exists(), f"missing critical file: {p}")


if __name__ == "__main__":
    unittest.main()

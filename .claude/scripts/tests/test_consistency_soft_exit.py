"""#1257 regression test — design-consistency-checker soft-exit primitive.

Unit-tests the canonical writer (write-degraded-trace.py) the agent invokes
when consumed_turns crosses the per_page_budget threshold. Asserts the
contract that verify state-3b VERIFY consumes:
  - partial: True (set unconditionally for self-degraded traces)
  - provenance: "self-degraded"
  - degraded_reason: "budget-soft-exit"
  - extra-json fields (pages_reviewed, pages_remaining, inconsistent_count)
    flow through to the trace

This is the structural guard that prevents #1257 from silently regressing:
if the writer's output shape changes (e.g., partial flag flipped, provenance
key renamed), this test fails and the regression is caught at CI time
rather than after the next /verify run on a > 8-page web-app project.

Per the user's design choice (Phase 4 plan, AskUserQuestion answer):
unit-test the primitive in isolation. No production env-var scaffolding
(DESIGN_CONSISTENCY_TEST_MAX_PAGES); no synthetic 18-page fixture; no
agent spawn. The test exercises only the writer + the verify gate's
consumed contract.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WRITER = REPO_ROOT / ".claude" / "scripts" / "write-degraded-trace.py"
HOOKS_DIR = REPO_ROOT / ".claude" / "hooks"
SCRIPTS_LIB_DIR = REPO_ROOT / ".claude" / "scripts" / "lib"


def _setup_run(tmp: Path, *, run_id: str, skill: str, agent: str) -> None:
    """Build a tmpdir mini-repo so write-degraded-trace.py's identity
    resolution succeeds AND R2/R3 validators pass.

    Identity path: lib.sh::resolve_active_identity reads .runs/*-context.json
    and returns the latest non-completed entry whose branch matches the
    current git branch. So we git-init, set the branch, and write a
    non-completed context with branch matching.

    R2 needs .runs/<skill>-context.json with matching run_id + skill.
    R3 needs an entry in .runs/agent-spawn-log.jsonl with hook=skill-agent-gate
    for the (agent, run_id) pair.
    """
    # Copy minimal hook + lib infra so `bash -c "source .claude/hooks/lib.sh
    # && resolve_active_identity"` succeeds inside the tempdir.
    shutil.copytree(HOOKS_DIR, tmp / ".claude" / "hooks")
    shutil.copytree(SCRIPTS_LIB_DIR, tmp / ".claude" / "scripts" / "lib")

    # Initialize git so get_branch returns a real branch name.
    subprocess.run(["git", "init", "-q", "-b", "test-branch"],
                   cwd=str(tmp), check=True)
    subprocess.run(["git", "config", "user.email", "test@test"],
                   cwd=str(tmp), check=True)
    subprocess.run(["git", "config", "user.name", "test"],
                   cwd=str(tmp), check=True)

    runs = tmp / ".runs"
    runs.mkdir(parents=True)
    (runs / "agent-traces").mkdir()
    # Recent (non-stale, non-completed) timestamp so resolve_active_identity
    # picks this context up.
    fresh_ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (runs / f"{skill}-context.json").write_text(json.dumps({
        "skill": skill, "run_id": run_id, "completed": False,
        "timestamp": fresh_ts, "completed_states": [],
        "branch": "test-branch",
    }))
    (runs / "agent-spawn-log.jsonl").write_text(json.dumps({
        "agent": agent, "run_id": run_id,
        "hook": "skill-agent-gate", "degraded": False,
        "timestamp": fresh_ts,
    }) + "\n")


class TestConsistencyCheckerSoftExitPrimitive(unittest.TestCase):
    """Lock the contract between the agent's soft-exit invocation and the
    state-3b VERIFY gate that accepts partial:true as valid completion."""

    AGENT = "design-consistency-checker"
    SKILL = "verify"
    RUN_ID = "verify-2026-05-06T00:00:00Z"

    def _invoke_writer(self, tmp: Path, *, verdict: str, extra: dict) -> subprocess.CompletedProcess:
        """Invoke write-degraded-trace.py with the canonical soft-exit args
        the agent procedure prescribes (procedures/design-consistency-checker.md
        Step 2.5, Soft-exit invocation). No --source-* flags — this exercises
        the same identity-resolution path the agent uses mid-flight."""
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(tmp)
        return subprocess.run(
            ["python3", str(WRITER), self.AGENT,
             "--reason", "budget-soft-exit",
             "--verdict", verdict,
             "--checks-performed", "C1-color,C2-typography,C3-spacing,C4-component,C5-layout",
             "--extra-json", json.dumps(extra)],
            cwd=str(tmp), env=env, capture_output=True, text=True, timeout=30,
        )

    def test_soft_exit_emits_canonical_partial_trace(self):
        """Pass-verdict path: 12/18 pages reviewed, 0 inconsistencies."""
        tmp = Path(__file__).parent / "_tmp_softexit_pass"
        if tmp.exists():
            shutil.rmtree(tmp)
        try:
            _setup_run(tmp, run_id=self.RUN_ID, skill=self.SKILL, agent=self.AGENT)
            extra = {
                "inconsistent_count": 0,
                "pages_reviewed": 12,
                "pages_remaining": ["p13", "p14", "p15", "p16", "p17", "p18"],
                "inconsistencies": [],
            }
            r = self._invoke_writer(tmp, verdict="pass", extra=extra)
            self.assertEqual(r.returncode, 0,
                f"writer should succeed; stderr={r.stderr!r}")

            trace_path = tmp / ".runs" / "agent-traces" / f"{self.AGENT}.json"
            self.assertTrue(trace_path.exists(),
                f"trace should be written; ls={list((tmp/'.runs'/'agent-traces').iterdir())}")
            trace = json.loads(trace_path.read_text())

            # Canonical contract — these MUST be true for state-3b VERIFY to
            # accept the trace as valid completion (per #1257's soft-exit
            # protocol; see procedures/design-consistency-checker.md Step 2.5).
            self.assertIs(trace.get("partial"), True,
                "partial must be True for self-degraded traces (set by writer:192)")
            self.assertEqual(trace.get("provenance"), "self-degraded",
                "provenance must be 'self-degraded' for agent-emitted partial traces")
            self.assertEqual(trace.get("degraded_reason"), "budget-soft-exit",
                "degraded_reason must echo --reason exactly so state-3b can match")
            self.assertEqual(trace.get("verdict"), "pass",
                "verdict must reflect findings from completed pages only")
            self.assertEqual(trace.get("agent"), self.AGENT)

            # Extra-json fields flow through to the trace (the agent uses
            # these to communicate coverage to the user via state-7a report).
            self.assertEqual(trace.get("pages_reviewed"), 12)
            self.assertEqual(trace.get("inconsistent_count"), 0)
            self.assertEqual(trace.get("pages_remaining"),
                             ["p13", "p14", "p15", "p16", "p17", "p18"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_soft_exit_fail_verdict_when_inconsistencies_found(self):
        """Fail-verdict path: invariant verdict==fail iff inconsistent_count>0
        must hold under partial completion (see procedures Step 2.5
        'Verdict semantics' contract)."""
        tmp = Path(__file__).parent / "_tmp_softexit_fail"
        if tmp.exists():
            shutil.rmtree(tmp)
        try:
            _setup_run(tmp, run_id=self.RUN_ID, skill=self.SKILL, agent=self.AGENT)
            extra = {
                "inconsistent_count": 3,
                "pages_reviewed": 10,
                "pages_remaining": ["p11", "p12", "p13", "p14", "p15", "p16", "p17", "p18"],
                "inconsistencies": [
                    {"id": "C4-1", "severity": "major", "page": "p3"},
                    {"id": "C4-2", "severity": "minor", "page": "p7"},
                    {"id": "C4-3", "severity": "minor", "page": "p9"},
                ],
            }
            r = self._invoke_writer(tmp, verdict="fail", extra=extra)
            self.assertEqual(r.returncode, 0,
                f"writer should succeed; stderr={r.stderr!r}")

            trace = json.loads(
                (tmp / ".runs" / "agent-traces" / f"{self.AGENT}.json").read_text())

            self.assertIs(trace.get("partial"), True)
            self.assertEqual(trace.get("verdict"), "fail")
            self.assertEqual(trace.get("inconsistent_count"), 3)
            self.assertEqual(len(trace.get("inconsistencies", [])), 3)
            # pages_remaining count = 18 - pages_reviewed when total is 18
            self.assertEqual(len(trace.get("pages_remaining", [])), 8)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_partial_flag_is_not_a_writer_arg(self):
        """Regression guard: the writer MUST set partial:true unconditionally
        for self-degraded traces. Passing --partial would be wrong (the flag
        does not exist; partial is set by writer:192 based on provenance).
        This test enforces that callers don't accidentally rely on a
        --partial flag."""
        # Writer's --help should NOT mention --partial as a flag.
        r = subprocess.run(
            ["python3", str(WRITER), "--help"],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("--partial", r.stdout,
            "--partial should NOT be a documented flag (partial is set by "
            "writer based on provenance:self-degraded; see writer:192).")


if __name__ == "__main__":
    unittest.main()

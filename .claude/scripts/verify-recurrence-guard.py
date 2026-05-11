#!/usr/bin/env python3
"""verify-recurrence-guard.py — RMG v2 Phase A.

Standalone verifier callable from state-registry.json VERIFY blocks.

Reads `.runs/solve-trace.json`, asserts the structural fields required by all
three callers, and — when `prevention_analysis.recurrence_risk != "none"` —
parses `prevention_analysis.recurrence_guard` via
`.claude/scripts/lib/recurrence_guard_parser.py`. Tolerant mode is honored
(legacy free-text guards become `kind="legacy_freetext"` and pass; this is
intentional during the soak window).

Optional flags:
  --require-prevention    assert prevention_analysis is present (resolve)
  --require-phase-3-gaps  assert phase_3_gaps is present and non-empty in full mode (solve)
  --require-run-id        assert solve-trace run_id matches a sibling context.json
  --require-falsification assert prevention_analysis.falsification is present and
                          parses under recurrence_guard_parser.parse_falsification
                          when problem_type=defect. Strict: missing or invalid
                          falsification returns exit 1 immediately.
  --context-path PATH     explicit context json (default: auto-detect by skill)
  --skill {resolve,solve,change}  influences default context-path
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / ".claude" / "scripts" / "lib"))

from recurrence_guard_parser import (  # noqa: E402
    FalsificationParseError,
    RecurrenceGuardParseError,
    parse,
    parse_falsification,
)

REQUIRED_TRACE_FIELDS = (
    "mode",
    "problem_decomposition",
    "constraint_enumeration",
    "solution_design",
    "self_check",
    "output",
)


def _load(path: str) -> dict:
    with open(path) as fh:
        return json.load(fh)


def _default_context_path(skill: str) -> str:
    return f".runs/{skill}-context.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-prevention", action="store_true")
    parser.add_argument("--require-phase-3-gaps", action="store_true")
    parser.add_argument("--require-run-id", action="store_true")
    parser.add_argument("--require-falsification", action="store_true")
    parser.add_argument("--context-path")
    parser.add_argument("--skill", choices=("resolve", "solve", "change"))
    args = parser.parse_args(argv)

    trace_path = ".runs/solve-trace.json"
    if not os.path.isfile(trace_path):
        print(f"VERIFY FAIL: {trace_path} missing", file=sys.stderr)
        return 1

    trace = _load(trace_path)
    if trace.get("mode") not in ("light", "full"):
        print(f"VERIFY FAIL: mode={trace.get('mode')!r} (must be light or full)", file=sys.stderr)
        return 1

    missing = [k for k in REQUIRED_TRACE_FIELDS if not trace.get(k)]
    if missing:
        print(f"VERIFY FAIL: solve-trace.json empty fields: {missing}", file=sys.stderr)
        return 1

    if args.require_phase_3_gaps:
        if "phase_3_gaps" not in trace:
            print("VERIFY FAIL: phase_3_gaps field missing", file=sys.stderr)
            return 1
        if trace["mode"] == "full" and not trace.get("phase_3_gaps"):
            print("VERIFY FAIL: phase_3_gaps empty in full mode", file=sys.stderr)
            return 1

    if args.require_run_id:
        ctx_path = args.context_path or (
            _default_context_path(args.skill) if args.skill else None
        )
        if not ctx_path or not os.path.isfile(ctx_path):
            print(f"VERIFY FAIL: context json {ctx_path!r} missing", file=sys.stderr)
            return 1
        ctx = _load(ctx_path)
        if trace.get("run_id") != ctx.get("run_id"):
            print(
                f"VERIFY FAIL: run_id mismatch trace={trace.get('run_id')!r} "
                f"context={ctx.get('run_id')!r}",
                file=sys.stderr,
            )
            return 1

    pa = trace.get("prevention_analysis")
    if args.require_prevention:
        if pa is None:
            print("VERIFY FAIL: prevention_analysis required", file=sys.stderr)
            return 1
        if not isinstance(pa, dict):
            print("VERIFY FAIL: prevention_analysis must be a dict", file=sys.stderr)
            return 1
        for field in ("root_cause_addressed", "recurrence_risk", "scope"):
            if field not in pa:
                print(
                    f"VERIFY FAIL: prevention_analysis missing {field}",
                    file=sys.stderr,
                )
                return 1

    if isinstance(pa, dict):
        risk = pa.get("recurrence_risk")
        if risk and risk not in ("none", "guarded", "unguarded"):
            print(
                f"VERIFY FAIL: recurrence_risk invalid: {risk!r}",
                file=sys.stderr,
            )
            return 1
        if risk and risk != "none":
            guard = pa.get("recurrence_guard")
            if guard is None:
                print(
                    "VERIFY FAIL: recurrence_guard required when "
                    "recurrence_risk != 'none' (RMG v2)",
                    file=sys.stderr,
                )
                return 1
            try:
                parse(guard)
            except RecurrenceGuardParseError as exc:
                print(
                    f"VERIFY FAIL: recurrence_guard rejected by RMG v2 parser: "
                    f"{exc} (raw={getattr(exc, 'raw_value', guard)!r})",
                    file=sys.stderr,
                )
                return 1

    # Falsification Gate (sibling of recurrence_guard inside prevention_analysis).
    # Fires only when problem_type=defect to keep non-defect runs unaffected.
    if args.require_falsification and isinstance(pa, dict):
        if pa.get("problem_type") == "defect":
            falsi = pa.get("falsification")
            if falsi is None:
                print(
                    "VERIFY FAIL: prevention_analysis.falsification required "
                    "when problem_type=defect (Falsification Gate). See "
                    ".claude/patterns/solve-reasoning.md 'Falsification Schema'.",
                    file=sys.stderr,
                )
                return 1
            try:
                parse_falsification(falsi)
            except FalsificationParseError as exc:
                print(
                    f"VERIFY FAIL: falsification rejected: {exc} "
                    f"(raw={getattr(exc, 'raw_value', falsi)!r})",
                    file=sys.stderr,
                )
                return 1

    # #1331 runtime guard: when /solve full-mode runs round 2, the orchestrator
    # must have archived round-1 to the sidecar. Read solve-critic.json.round
    # directly as the signal channel — when round == 2, the archive at
    # .runs/solve-critic-round1.json must exist with round=1 + non-empty
    # concerns[]. This mirrors the resolve/change guards in
    # verify-resolve-challenge.py and verify-change-solve.py.
    if args.skill == "solve":
        sc_path = ".runs/agent-traces/solve-critic.json"
        if os.path.exists(sc_path):
            try:
                sc = _load(sc_path)
            except Exception:
                sc = {}
            if sc.get("round") == 2:
                archive_path = ".runs/solve-critic-round1.json"
                if not os.path.exists(archive_path):
                    print(
                        f"VERIFY FAIL: solve-critic.json has round=2 but round-1 "
                        f"archive missing at {archive_path} — orchestrator must "
                        "archive solve-critic.json to this sidecar BEFORE spawning "
                        "round 2 (see solve-reasoning.md Phase 5 / "
                        "solve/state-1-execute.md)",
                        file=sys.stderr,
                    )
                    return 1
                try:
                    archive = _load(archive_path)
                except Exception as exc:
                    print(
                        f"VERIFY FAIL: {archive_path} not parseable as JSON: {exc}",
                        file=sys.stderr,
                    )
                    return 1
                if archive.get("round") != 1:
                    print(
                        f"VERIFY FAIL: {archive_path} has round={archive.get('round')!r}, "
                        "expected 1 — sidecar should be the archived round-1 trace",
                        file=sys.stderr,
                    )
                    return 1
                arc_concerns = archive.get("concerns") or []
                if not (isinstance(arc_concerns, list) and len(arc_concerns) > 0):
                    print(
                        f"VERIFY FAIL: {archive_path} has no concerns[] — round-2 "
                        "vector 5 cannot fire without round-1 concern_ids",
                        file=sys.stderr,
                    )
                    return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())

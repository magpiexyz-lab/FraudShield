#!/usr/bin/env python3
"""VERIFY for verify.7b (COMPUTE_QSCORE).

Extracted from the inline state-registry.json command. The original was a
multi-line, single-quoted `python3 -c` chained after `head -1 ... | grep -q`.
advance-state.sh runs VERIFY through Python subprocess with shell=True, which
on Windows dispatches to cmd.exe; cmd.exe does not strip single quotes and
cannot carry embedded newlines, so the original command could never pass on
Windows. Semantics here are unchanged from that command.
"""
import glob
import json
import os
import subprocess
import sys

REPORT = ".runs/verify-report.md"
HISTORY = ".runs/verify-history.jsonl"


def fail(msg):
    raise AssertionError(msg)


def main():
    with open(REPORT) as fh:
        if fh.readline().strip() != "---":
            fail("verify-report.md missing frontmatter")

    last = ""
    with open(HISTORY) as fh:
        for line in fh:
            if line.strip():
                last = line
    if not last:
        fail("verify-history.jsonl is empty")
    entry = json.loads(last)

    scores = entry.get("dimension_scores", {})

    if scores.get("Q_build", 0) > 0:
        ok = os.path.exists(".runs/build-result.json") and             json.load(open(".runs/build-result.json")).get("exit_code") == 0
        if not ok:
            fail("Q_build>0 but build failed")

    if scores.get("Q_security", 0) > 0 and not glob.glob(".runs/agent-traces/security-*.json"):
        fail("Q_security>0 but no security traces")

    if scores.get("Q_design", 0) > 0 and not os.path.exists(".runs/agent-traces/design-critic.json"):
        fail("Q_design>0 but no design-critic trace")

    hard_gate_failure = entry.get("hard_gate_failure", False)

    checks = [
        (".runs/agent-traces/design-critic.json", "verdict", ["unresolved"], None),
        (".runs/agent-traces/ux-journeyer.json", "verdict", ["blocked"], [("unresolved_dead_ends", 0)]),
        (".runs/agent-traces/security-fixer.json", "verdict", ["partial"], [("unresolved_critical", 0)]),
        (".runs/agent-traces/quality-fixer.json", "verdict", ["partial"], [("unresolved_critical", 0)]),
    ]

    for path, key, bad_values, extras in checks:
        if not os.path.exists(path):
            continue
        trace = json.load(open(path))
        needs_gate = (
            trace.get(key) in bad_values
            or trace.get("recovery", False)
            or any(trace.get(ek, 0) > ev for ek, ev in (extras or []))
        )
        if not needs_gate:
            continue
        if path.endswith("design-critic.json"):
            sanctioned = subprocess.run(
                ["python3", ".claude/scripts/check-design-critic-sanctioned.py", path],
                capture_output=True,
            ).returncode == 0
            if sanctioned:
                continue
        if not hard_gate_failure:
            fail(path + " requires hard_gate_failure=true")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        sys.stderr.write(str(exc) + "
")
        sys.exit(1)

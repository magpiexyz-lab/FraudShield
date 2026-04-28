#!/usr/bin/env python3
"""Append one hook-friction row to .runs/hook-friction.jsonl (#1128 Layer 2).

Inputs from environment variables (avoids shell-quoting injection — R2.1 fix):
  HOOK_FRICTION_HOOK         hook script basename (e.g., "fix-ledger-write-guard.sh")
  HOOK_FRICTION_REASON       deny() message
  HOOK_FRICTION_TOOL_NAME    Bash | Edit | Write | ...
  HOOK_FRICTION_BLOCKED_CMD  first 200 chars of tool_input (sanitized)

Reads run_id and skill from the active context file (.runs/<skill>-context.json,
same scheme used by scan-template-edits.sh and aggregate-hook-friction.py).

Fail-open: never raises. Any error → exit 0 silently. The caller's deny()
contract (stderr + exit 2) is preserved verbatim.
"""
import datetime
import glob
import json
import os
import sys


def _active_context():
    best = None
    best_ts = ''
    try:
        for f in glob.glob('.runs/*-context.json'):
            if 'epilogue' in f:
                continue
            try:
                d = json.load(open(f))
            except Exception:
                continue
            if d.get('completed') is True:
                continue
            ts = d.get('timestamp') or ''
            if ts >= best_ts:
                best = d
                best_ts = ts
    except Exception:
        pass
    return best or {}


def main():
    try:
        ctx = _active_context()
        row = {
            "hook": os.environ.get("HOOK_FRICTION_HOOK", "unknown"),
            "tool_name": os.environ.get("HOOK_FRICTION_TOOL_NAME", ""),
            "blocked_command": os.environ.get("HOOK_FRICTION_BLOCKED_CMD", "")[:200],
            "reason": os.environ.get("HOOK_FRICTION_REASON", "")[:500],
            "run_id": ctx.get("run_id", ""),
            "skill": ctx.get("skill", ""),
            "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        os.makedirs('.runs', exist_ok=True)
        with open('.runs/hook-friction.jsonl', 'a') as f:
            f.write(json.dumps(row) + '\n')
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

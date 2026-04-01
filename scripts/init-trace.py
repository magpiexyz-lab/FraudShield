#!/usr/bin/env python3
"""Initialize agent trace with started status.

Usage:
    python3 scripts/init-trace.py <agent-name>
    python3 scripts/init-trace.py <agent-name> <trace-filename>

Args:
    agent-name:     Required. E.g. "design-critic"
    trace-filename: Optional. Defaults to "<agent-name>.json".
                    Use for per-page traces: "design-critic-landing.json"

Writes: .runs/agent-traces/<trace-filename>
Schema: {"agent": str, "status": "started", "timestamp": str, "run_id": str}
"""
import json
import os
import sys
from datetime import datetime, timezone

if len(sys.argv) < 2:
    print("Usage: init-trace.py <agent-name> [trace-filename]", file=sys.stderr)
    sys.exit(1)

agent = sys.argv[1]
trace_file = sys.argv[2] if len(sys.argv) > 2 else f"{agent}.json"

run_id = ""
try:
    with open(".runs/verify-context.json") as f:
        run_id = json.load(f).get("run_id", "")
except Exception:
    pass

os.makedirs(".runs/agent-traces", exist_ok=True)

trace = {
    "agent": agent,
    "status": "started",
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "run_id": run_id,
}

with open(f".runs/agent-traces/{trace_file}", "w") as f:
    json.dump(trace, f, indent=2)
    f.write("\n")

#!/usr/bin/env python3
"""One-shot migration of pre-v2 agent traces to the unified schema.

Legacy traces (written before the agent-trace lifecycle contract) lack the
`provenance` field. This script walks .runs/agent-traces/, derives missing
fields from the legacy `recovery` boolean, and writes a .runs/trace-migration.json
receipt so downstream gates know migration has run.

Called from:
  - lifecycle-init.sh (primary and --embed paths — R2 C4 fix, so embed runs
    also trigger migration rather than carrying unmigrated traces forward)
  - verify-report-gate.sh self-heal mode (R2 C4 alternative fix, logs a
    WARN and continues rather than hard-refusing a multi-hour workflow)

Idempotent: writes a receipt and checks it on subsequent invocations.

Migration rules:
  - No `provenance` field AND `recovery: true`       → provenance="recovery"
  - No `provenance` field AND no `recovery` (or false) → provenance="self"
  - `status` missing → "completed" (unless verdict missing, then "started")
  - `partial` missing → True when provenance in {recovery, self-degraded}, else False
  - `no_fixes_claimed` missing → True when fixes array empty or absent
  - `recovery_validated` missing → False (validate-recovery.sh can stamp later)

Usage:
    python3 .claude/scripts/migrate-legacy-traces.py [--dry-run]
"""
import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone


RECEIPT_PATH = ".runs/trace-migration.json"


def derive_fields(trace):
    """Derive missing v2 fields from a legacy trace. Returns (updated_trace, changed).

    Invariant: if `provenance` is already present, the trace is considered
    already-migrated and is left entirely untouched. Per-field back-fills
    would otherwise mutate post-migration traces (e.g., add no_fixes_claimed
    to a fixer trace that intentionally omits it), violating idempotency.
    """
    if trace.get("provenance") is not None:
        return trace, False

    prov = "recovery" if trace.get("recovery") else "self"
    trace["provenance"] = prov

    if "status" not in trace:
        trace["status"] = "completed" if "verdict" in trace else "started"

    if "partial" not in trace:
        trace["partial"] = prov in ("recovery", "self-degraded")

    if "no_fixes_claimed" not in trace:
        fixes = trace.get("fixes")
        trace["no_fixes_claimed"] = not isinstance(fixes, list) or len(fixes) == 0

    if "recovery_validated" not in trace:
        trace["recovery_validated"] = False

    if "recovery" not in trace:
        trace["recovery"] = prov == "recovery"

    # Provenance != self requires degraded_reason
    if prov in ("recovery", "self-degraded") and not trace.get("degraded_reason"):
        trace["degraded_reason"] = "legacy-migrated (reason unrecorded)"

    return trace, True


def already_migrated():
    if not os.path.isfile(RECEIPT_PATH):
        return False
    try:
        json.load(open(RECEIPT_PATH))
        return True
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate legacy agent traces to v2 schema")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would change without writing")
    parser.add_argument("--force", action="store_true",
                        help="Re-run even if receipt exists")
    args = parser.parse_args()

    if already_migrated() and not args.force:
        # Idempotent no-op — the receipt says we already ran.
        return 0

    traces_dir = ".runs/agent-traces"
    if not os.path.isdir(traces_dir):
        # Nothing to migrate — write receipt anyway so downstream gates are satisfied.
        if not args.dry_run:
            os.makedirs(".runs", exist_ok=True)
            json.dump({
                "migrated_at": datetime.now(timezone.utc).isoformat(),
                "traces_dir_existed": False,
                "processed": 0,
                "changed": 0,
            }, open(RECEIPT_PATH, "w"), indent=2)
        return 0

    processed = 0
    changed_files = 0
    for path in sorted(glob.glob(os.path.join(traces_dir, "*.json"))):
        try:
            trace = json.load(open(path))
        except Exception as exc:
            sys.stderr.write(f"WARN: migrate-legacy-traces: cannot parse {path}: {exc}\n")
            continue
        processed += 1
        trace_updated, changed = derive_fields(trace)
        if changed:
            changed_files += 1
            if not args.dry_run:
                json.dump(trace_updated, open(path, "w"), indent=2)

    if not args.dry_run:
        os.makedirs(".runs", exist_ok=True)
        json.dump({
            "migrated_at": datetime.now(timezone.utc).isoformat(),
            "traces_dir_existed": True,
            "processed": processed,
            "changed": changed_files,
        }, open(RECEIPT_PATH, "w"), indent=2)
    print(f"migrate-legacy-traces: processed={processed} changed={changed_files} "
          f"{'(dry-run)' if args.dry_run else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

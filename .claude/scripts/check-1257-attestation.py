#!/usr/bin/env python3
"""check-1257-attestation.py — Operator helper for issue #1257 closure attestation.

Reads .runs/consistency-soak-telemetry.jsonl (raw-fields records appended by
merge-design-consistency-checker-traces.py on every multi-batch run) and
applies the 3-tuple closure criterion documented in PR #1357 + step55-evidence-rollout.md:

  * provenance == "lead-merge"
  * contributing_spawn_indexes_count >= 2
  * pages_reviewed_total >= 12
  * status == "completed"

The predicate is evaluated at READ time (NOT precomputed at WRITE time) so future
criterion changes (e.g., raising the page threshold) do NOT strand existing records.

Exit codes:
  0 — ATTESTED: at least one telemetry record satisfies the criterion.
  1 — NOT ATTESTED: telemetry exists but no record attests, OR no telemetry yet.

Usage:
  python3 .claude/scripts/check-1257-attestation.py
  python3 .claude/scripts/check-1257-attestation.py --telemetry-path /path/to/file.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


DEFAULT_TELEMETRY = ".runs/consistency-soak-telemetry.jsonl"


def is_attesting(rec: dict[str, Any]) -> bool:
    """Apply the #1257 closure criterion at READ time.

    The criterion mirrors PR #1357 body verbatim — see step55-evidence-rollout.md
    section "#1257 Attestation Telemetry" for the canonical declaration."""
    return (
        rec.get("provenance") == "lead-merge"
        and rec.get("contributing_spawn_indexes_count", 0) >= 2
        and rec.get("pages_reviewed_total", 0) >= 12
        and rec.get("status") == "completed"
    )


def _read_records(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return []
    records: list[dict[str, Any]] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                records.append(rec)
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check issue #1257 production attestation status from telemetry.",
    )
    parser.add_argument(
        "--telemetry-path",
        default=DEFAULT_TELEMETRY,
        help=f"Telemetry JSONL path (default: {DEFAULT_TELEMETRY})",
    )
    args = parser.parse_args(argv)

    records = _read_records(args.telemetry_path)
    if not records:
        print(
            f"NOT ATTESTED: no telemetry yet ({args.telemetry_path} absent or empty)",
            file=sys.stderr,
        )
        return 1

    for rec in records:
        if is_attesting(rec):
            print(f"ATTESTED: {json.dumps(rec, sort_keys=True)}")
            return 0

    print(
        f"NOT ATTESTED: {len(records)} records inspected; "
        f"latest={json.dumps(records[-1], sort_keys=True)}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())

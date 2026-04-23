#!/usr/bin/env python3
"""Consolidate agent trace fixes[] arrays into .runs/fix-ledger.jsonl.

AOC v1 FLS v1 consolidator. One authoritative per-fix ledger replaces the
prose-count drift between .runs/fix-log.md and agent trace fixes[].

Contract:
  - One JSON object per line.
  - Fields per AOC v1 FLS v1: fix_id, agent, source_trace, run_id, file,
    symptom, fix, timestamp, batch_id, batch_size.
  - fix_id = <source_trace_basename>:<fix_array_index> (stable identity).
  - batch_id = source_trace_basename (groups fixes committed in the same
    trace write session).
  - batch_size = len(trace.fixes) at consolidation time.
  - Atomic write: tempfile + os.rename (POSIX-atomic).
  - Idempotent: existing fix_ids are skipped.

Invocation: run unconditionally at every state-completion-gate advance;
idempotency makes repeat runs cheap.

Usage:
    python3 .claude/scripts/write-fix-ledger.py [--run-id <id>]
    python3 .claude/scripts/write-fix-ledger.py --dry-run

Exit 0 if ledger successfully written or up-to-date; exit non-zero on
fatal error (e.g., write failure).
"""
import argparse
import glob
import json
import os
import sys
import tempfile
from datetime import datetime, timezone


LEDGER_PATH = ".runs/fix-ledger.jsonl"
TRACES_DIR = ".runs/agent-traces"
AGENT_REGISTRY = ".claude/patterns/agent-registry.json"


def _load_lead_merge_aggregate_agents():
    """Return the list of agents with sub-trace merging semantics.
    Used to dedupe ledger rows: when <agent>.json exists alongside
    <agent>-*.json, only <agent>.json is authoritative (post-merge).
    Falls back to a hard-coded list if the registry is unreadable."""
    try:
        with open(AGENT_REGISTRY) as f:
            reg = json.load(f)
        agents = reg.get("lead_merge_aggregate_agents")
        if isinstance(agents, list) and agents:
            return list(agents)
    except (OSError, json.JSONDecodeError):
        pass
    return [
        "design-critic",
        "scaffold-pages",
        "scaffold-images",
        "implementer",
        "visual-implementer",
    ]


def load_existing_ledger(path=LEDGER_PATH):
    if not os.path.isfile(path):
        return []
    rows = []
    with open(path) as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except json.JSONDecodeError:
                # Preserve malformed lines by ignoring — they will be
                # overwritten on next full write. Do not silently drop
                # valid rows.
                continue
    return rows


def agent_name_from_trace(trace, trace_path):
    name = trace.get("agent")
    if name:
        return name
    return os.path.basename(trace_path).replace(".json", "")


def _should_skip_as_submerged(trace_path, aggregate_agents, all_paths):
    """AOC v1 FLS v1 dedup: for each lead_merge_aggregate_agent, if the
    aggregate `<agent>.json` exists, sub-traces `<agent>-*.json` are
    intermediate and MUST NOT emit ledger rows (their fixes are already
    concatenated into the aggregate's fixes[] by merge-<agent>-traces.py).
    Without this skip, every per-page fix doubles: once in the sub-trace
    row and once in the aggregate row."""
    basename = os.path.basename(trace_path).replace(".json", "")
    for agent in aggregate_agents:
        if basename.startswith(agent + "-"):
            aggregate_path = os.path.join(TRACES_DIR, agent + ".json")
            if aggregate_path in all_paths:
                return True
    return False


def collect_rows(existing_ids, caller_run_id):
    """Walk trace directory, extract fixes[] from each trace, yield FLS v1
    records for fix_ids not yet in the ledger.

    Dedup: skip sub-traces of lead_merge_aggregate_agents when the aggregate
    trace is present. Prevents double-counting per-page fixes that are
    concatenated into the merged aggregate's fixes[] array.
    """
    aggregate_agents = _load_lead_merge_aggregate_agents()
    all_paths = set(glob.glob(os.path.join(TRACES_DIR, "*.json")))
    new_rows = []
    for trace_path in sorted(all_paths):
        if _should_skip_as_submerged(trace_path, aggregate_agents, all_paths):
            continue
        try:
            trace = json.load(open(trace_path))
        except Exception:
            continue
        fixes = trace.get("fixes", [])
        if not isinstance(fixes, list) or not fixes:
            continue
        basename = os.path.basename(trace_path).replace(".json", "")
        agent = agent_name_from_trace(trace, trace_path)
        trace_run_id = trace.get("run_id") or caller_run_id or ""
        ts = trace.get("timestamp") or datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        batch_size = len(fixes)
        for idx, fix in enumerate(fixes):
            fix_id = f"{basename}:{idx}"
            if fix_id in existing_ids:
                continue
            # Accept loose shapes in the source fixes[] array: {file, symptom, fix}
            # is canonical but some agents write {file, desc, action} etc.
            file_val = None
            symptom_val = None
            fix_val = None
            if isinstance(fix, dict):
                file_val = fix.get("file") or fix.get("path")
                symptom_val = fix.get("symptom") or fix.get("desc") or fix.get("description")
                fix_val = fix.get("fix") or fix.get("action") or fix.get("change")
            elif isinstance(fix, str):
                fix_val = fix
            new_rows.append({
                "fix_id": fix_id,
                "agent": agent,
                "source_trace": trace_path,
                "run_id": trace_run_id,
                "file": file_val,
                "symptom": symptom_val,
                "fix": fix_val,
                "timestamp": ts,
                "batch_id": basename,
                "batch_size": batch_size,
            })
    return new_rows


def atomic_write(rows, path=LEDGER_PATH):
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(
        prefix=".fix-ledger-", suffix=".jsonl.tmp", dir=parent
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            for row in rows:
                f.write(json.dumps(row, sort_keys=True) + "\n")
        os.rename(tmp_path, path)  # POSIX-atomic
    except Exception:
        if os.path.isfile(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise


def main():
    ap = argparse.ArgumentParser(
        description="Consolidate agent trace fixes[] into fix-ledger.jsonl"
    )
    ap.add_argument("--run-id", default=None,
                    help="Fallback run_id when source trace lacks one")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show counts without writing")
    args = ap.parse_args()

    if not os.path.isdir(TRACES_DIR):
        # Nothing to consolidate — create empty ledger for presence checks.
        if not args.dry_run:
            atomic_write([])
        print("write-fix-ledger: no traces dir, wrote empty ledger")
        return 0

    existing = load_existing_ledger()
    existing_ids = {r.get("fix_id") for r in existing if isinstance(r, dict)}
    new_rows = collect_rows(existing_ids, args.run_id)

    total = len(existing) + len(new_rows)
    if args.dry_run:
        print(f"write-fix-ledger (dry-run): existing={len(existing)} "
              f"new={len(new_rows)} total={total}")
        return 0

    if new_rows:
        atomic_write(existing + new_rows)
        print(f"write-fix-ledger: added {len(new_rows)} rows (total {total})")
    else:
        # Up-to-date; still ensure file exists (empty is valid).
        if not os.path.isfile(LEDGER_PATH):
            atomic_write([])
        print(f"write-fix-ledger: up-to-date ({total} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

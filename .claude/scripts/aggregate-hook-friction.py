#!/usr/bin/env python3
"""Aggregate .runs/hook-friction.jsonl into .runs/hook-friction-summary.json.

Per-hook block counts + sample reasons (max 3 unique). Filters to the
current run_id when one is resolvable from .runs/<skill>-context.json.

Used as Step 5a Q2 evidence (#1128 Layer 6). The summary is what the
Step 5a evaluator reads; the raw .jsonl stays as audit trail.

Fail-open: missing/empty input → empty summary written; never raises.
"""
import glob
import json
import os
import sys
from collections import defaultdict


def _active_run_id():
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
    return (best or {}).get('run_id', '')


def main():
    rid = _active_run_id()
    summary = defaultdict(lambda: {"count": 0, "sample_reasons": [], "_seen": set()})
    path = '.runs/hook-friction.jsonl'
    out_path = '.runs/hook-friction-summary.json'

    if not os.path.isfile(path):
        try:
            os.makedirs('.runs', exist_ok=True)
            with open(out_path, 'w') as f:
                json.dump({"run_id": rid, "hooks": {}, "total": 0}, f, indent=2)
        except Exception:
            pass
        return 0

    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if rid and e.get('run_id') and e.get('run_id') != rid:
                    continue
                h = e.get('hook', 'unknown')
                r = (e.get('reason') or '')[:300]
                summary[h]["count"] += 1
                if r and r not in summary[h]["_seen"] and len(summary[h]["sample_reasons"]) < 3:
                    summary[h]["sample_reasons"].append(r)
                    summary[h]["_seen"].add(r)
    except Exception:
        pass

    out = {"run_id": rid, "hooks": {}, "total": 0}
    for h, v in summary.items():
        out["hooks"][h] = {"count": v["count"], "sample_reasons": v["sample_reasons"]}
        out["total"] += v["count"]
    try:
        os.makedirs('.runs', exist_ok=True)
        with open(out_path, 'w') as f:
            json.dump(out, f, indent=2)
    except Exception:
        pass
    print(f"aggregate-hook-friction: {out['total']} entries across {len(out['hooks'])} hooks")
    return 0


if __name__ == "__main__":
    sys.exit(main())

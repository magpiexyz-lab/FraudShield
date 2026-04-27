#!/usr/bin/env python3
"""merge-scaffold-pages-traces.py — Official merge script for bootstrap STATE 11c.

Merges per-page `.runs/agent-traces/scaffold-pages-*.json` traces into the
aggregate `.runs/agent-traces/scaffold-pages.json`. Previously inlined in
state-11c-page-scaffold.md but extracted to this dedicated script so the
agent-trace-write-guard.sh allowlist can authorise exactly this write
(mirrors the #1045 resolution for merge-design-critic-traces.py). The
script's invocation pattern is tied to the guard's
ALLOWED_REGEX_MERGE_SCAFFOLD_PAGES — do not rename or move.

Behavior matches the prior inline merge:
  - Globs `.runs/agent-traces/scaffold-pages-*.json`
  - Counts batches as `pages_created`
  - Concatenates `files_created[]` and `issues[]` from each batch
  - Writes aggregate with `agent="scaffold-pages"` plus the merged fields

This is a "legacy aggregate" in the AOC v1.1 sense — it does not yet emit
`provenance:"lead-merge"`, `partial:true`, or `contributing_spawn_indexes`.
state-completion-gate.sh accepts unprovenanced aggregates for backward
compatibility (see lead-merge exemption block in that hook). Adding full
AOC v1.1 lead-merge invariants is a follow-up.

Exit codes:
  0 — merge succeeded, aggregate trace written
  1 — no per-page traces found (nothing to merge)
  2 — per-page trace parse error

Usage:
  python3 .claude/scripts/merge-scaffold-pages-traces.py
"""
import datetime
import glob
import json
import os
import sys


def main() -> int:
    traces_dir = ".runs/agent-traces"
    per_page_pattern = os.path.join(traces_dir, "scaffold-pages-*.json")
    aggregate_path = os.path.join(traces_dir, "scaffold-pages.json")

    batches = sorted(glob.glob(per_page_pattern))
    # Filter out the aggregate path itself in case it matches the glob
    # (shouldn't, since the suffix differs, but defensive).
    batches = [b for b in batches if b != aggregate_path]

    if not batches:
        sys.stderr.write(
            f"merge-scaffold-pages-traces: no per-page traces at {per_page_pattern}\n"
        )
        return 1

    run_id = ""
    try:
        with open(".runs/bootstrap-context.json") as f:
            run_id = json.load(f).get("run_id", "")
    except Exception:
        pass

    merged = {
        "agent": "scaffold-pages",
        "pages_created": 0,
        "files_created": [],
        "issues": [],
        "run_id": run_id,
    }

    for b in batches:
        try:
            with open(b) as f:
                d = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            sys.stderr.write(
                f"merge-scaffold-pages-traces: cannot parse {b}: {exc}\n"
            )
            return 2
        merged["pages_created"] += 1
        merged["files_created"].extend(d.get("files_created", []))
        merged["issues"].extend(d.get("issues", []))

    merged["timestamp"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    with open(aggregate_path, "w") as f:
        json.dump(merged, f)
    print(
        f"merge-scaffold-pages-traces: wrote {aggregate_path} "
        f"(pages_created={merged['pages_created']})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

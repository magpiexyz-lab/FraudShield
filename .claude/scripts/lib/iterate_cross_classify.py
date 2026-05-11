#!/usr/bin/env python3
"""iterate_cross_classify.py — End-to-end signup classification pipeline for /iterate --cross x2.

Subcommands:
  prepare    Read data.json + issues.json + config → write classify-input.json
             (buckets: to_skip, to_auto with deterministic picks, to_llm with catalogs).
  persist    Read input.json + LLM proposals.json → filter hard-excluded events,
             merge with config (respecting `classified_by: operator` overrides),
             write config atomically.
  finalize   Read updated config + data.json + signup-counts.json (from PostHog query
             between persist and finalize) → fill data.json signup_events + signups,
             run sanity check, print summary, exit 1 if any suspect found.

Why a helper script (not inline state-file Python):

1. The full chain (filter → merge → write → query → update → sanity → summarize) is
   ~120 lines of code with multiple read/write contracts. Inline heredocs in the state
   file are read-only prose to the human reviewer; they're invisible to verify-linter
   and unrunnable without the agent's interpretation. A helper script makes the
   contract deterministic AND unit-testable.
2. Hard exclusion of UI events MUST be a code guard, not an LLM instruction. The
   `EXCLUDED_PATTERNS` list below is the source of truth — any event matching is
   stripped from any proposal regardless of source (LLM, whitelist, operator).
3. `classified_by: operator` lock MUST be enforced by the writer. Otherwise a
   silent overwrite breaks the user contract from PR #1375.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone


# Hard exclusion: events matching these regexes can NEVER be signup events
# regardless of source. This catches false positives from mistagged funnel_stage
# or LLM misclassification.
EXCLUDED_PATTERNS = [
    re.compile(r"^cta_click\w*$", re.IGNORECASE),     # cta_click, cta_clicked
    re.compile(r"^cta_clicked$", re.IGNORECASE),
    re.compile(r"^cta_\w*$", re.IGNORECASE),          # cta_<anything>
    re.compile(r"^landing_\w+$", re.IGNORECASE),      # landing_view, landing_viewed, landing_visit, landing_page_*
    re.compile(r"^lander_\w+$", re.IGNORECASE),
    re.compile(r"^visit_landing$", re.IGNORECASE),    # visit_landing IS a page event, not signup
    re.compile(r"\w+_view(ed)?$", re.IGNORECASE),     # *_view, *_viewed
    re.compile(r"\w+_visit$", re.IGNORECASE),
    re.compile(r"^scroll_\w*$", re.IGNORECASE),
    re.compile(r"^scroll_depth$", re.IGNORECASE),
    re.compile(r"^attribution_\w+$", re.IGNORECASE),
    re.compile(r"^ad_clicked$", re.IGNORECASE),
    re.compile(r"^pricing_view$", re.IGNORECASE),
    re.compile(r"^feed_view(ed)?$", re.IGNORECASE),    # feed_view, feed_viewed
    re.compile(r"^marketplace_view(ed)?$", re.IGNORECASE),
    re.compile(r"^\$\w+$"),                            # $pageview, $autocapture, $pageleave
    re.compile(r"^page_viewed$", re.IGNORECASE),
    re.compile(r"^outreach_click$", re.IGNORECASE),
    re.compile(r"^model_recommended$", re.IGNORECASE),  # UI suggestion, not commitment
]


def is_excluded(event_name: str) -> bool:
    """True if event_name matches any hard-exclusion pattern."""
    if not event_name:
        return True
    return any(p.search(event_name) for p in EXCLUDED_PATTERNS)


def filter_signup_events(events: list[str]) -> tuple[list[str], list[str]]:
    """Strip hard-excluded events from a proposed signup_events list.

    Returns (kept, removed). `removed` is for logging/audit.
    """
    kept = [e for e in events if not is_excluded(e)]
    removed = [e for e in events if is_excluded(e)]
    return kept, removed


def load_yaml(path: str) -> dict:
    try:
        import yaml
    except ImportError:
        if os.path.exists(path):
            print(f"ERROR: PyYAML required to read {path}", file=sys.stderr)
            sys.exit(2)
        return {}
    if not os.path.exists(path):
        return {}
    return yaml.safe_load(open(path)) or {}


def dump_yaml(data: dict, path: str) -> None:
    import yaml
    with open(path, "w") as f:
        yaml.safe_dump(data, f, sort_keys=False, default_flow_style=False)


# ---------- Subcommand: prepare ----------

def cmd_prepare(args) -> int:
    """Bucket MVPs into to_skip / to_auto / to_llm."""
    data = json.load(open(args.data))
    issues = json.load(open(args.issues))
    issues_by_name = {m["name"]: m for m in issues["mvps"]}
    config = load_yaml(args.config)
    mvp_mappings = config.get("mvp_mappings") or {}
    default_whitelist = config.get("signup_whitelist") or [
        "signup_complete", "waitlist_signup", "waitlist_submit",
        "early_access_signup", "activate", "form_submitted",
    ]

    to_skip = []
    to_auto = []
    to_llm = []

    for mvp in data["mvps"]:
        name = mvp["name"]
        flags = issues_by_name.get(name, {})

        if flags.get("signup_classified"):
            to_skip.append(name)
            continue

        if flags.get("no_event_data"):
            to_auto.append({
                "name": name,
                "signup_events": [],
                "confidence": "empty",
                "rationale": "No events in catalog",
            })
            continue

        cat_events = {e["event"] for e in mvp.get("event_catalog", [])}

        if flags.get("auto_default_match"):
            # Intersect catalog with whitelist; filter out excluded events
            chosen_raw = [e for e in default_whitelist if e in cat_events]
            chosen, removed = filter_signup_events(chosen_raw)
            to_auto.append({
                "name": name,
                "signup_events": chosen,
                "confidence": "whitelist",
                "rationale": (
                    f"Standard event(s): {', '.join(chosen)}"
                    + (f"; filtered out: {', '.join(removed)}" if removed else "")
                ),
            })
            continue

        if flags.get("needs_llm_classification"):
            # Pass top 20 events with stage hints for LLM context
            to_llm.append({
                "name": name,
                "event_catalog": mvp.get("event_catalog", [])[:20],
            })

    payload = {
        "to_skip": to_skip,
        "to_auto": to_auto,
        "to_llm": to_llm,
    }
    json.dump(payload, open(args.output, "w"), indent=2)
    print(
        f"prepare: {len(to_skip)} skip, {len(to_auto)} auto, {len(to_llm)} need LLM "
        f"→ {args.output}"
    )
    return 0


# ---------- Subcommand: persist ----------

def cmd_persist(args) -> int:
    """Merge proposals into config; respect operator overrides; filter excluded events."""
    input_data = json.load(open(args.input))
    proposals = json.load(open(args.proposals))
    proposals_by_name = {p["name"]: p for p in proposals}

    config = load_yaml(args.config)
    config.setdefault("mvp_mappings", {})
    mappings = config["mvp_mappings"]

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    skipped_operator = []
    written = []
    filtered_events_log = []  # for audit: which events got stripped

    def persist_one(name: str, signup_events: list[str], confidence: str, rationale: str):
        existing = mappings.get(name) or {}
        if existing.get("classified_by") == "operator":
            skipped_operator.append(name)
            return

        kept, removed = filter_signup_events(signup_events)
        if removed:
            filtered_events_log.append({"name": name, "removed": removed})

        # Preserve owner / deploy_domain / any operator metadata
        new_mapping = dict(existing)
        new_mapping["signup_events"] = kept
        new_mapping["classified_by"] = f"x2-{confidence}"
        new_mapping["classified_at"] = now_iso
        if rationale:
            new_mapping["rationale"] = rationale
        mappings[name] = new_mapping
        written.append(name)

    # Auto-classified entries
    for entry in input_data["to_auto"]:
        persist_one(
            entry["name"], entry["signup_events"], entry["confidence"], entry.get("rationale", "")
        )

    # LLM-classified entries (from proposals file)
    for entry in input_data["to_llm"]:
        name = entry["name"]
        proposal = proposals_by_name.get(name)
        if not proposal:
            print(f"WARN: LLM proposal missing for {name}; recording empty", file=sys.stderr)
            persist_one(name, [], "missing", "No LLM proposal in proposals.json")
            continue
        persist_one(
            name,
            proposal.get("signup_events") or [],
            proposal.get("confidence") or "strong",
            proposal.get("rationale") or "",
        )

    dump_yaml(config, args.config)

    summary = {
        "written": written,
        "skipped_operator": skipped_operator,
        "filtered_events": filtered_events_log,
    }
    json.dump(summary, open(args.summary, "w"), indent=2)

    print(
        f"persist: {len(written)} written, {len(skipped_operator)} preserved "
        f"(classified_by: operator), {len(filtered_events_log)} had excluded events stripped"
    )
    return 0


# ---------- Subcommand: finalize ----------

def cmd_finalize(args) -> int:
    """Update data.json with signup_events + signups; run sanity check; print summary."""
    data = json.load(open(args.data))
    config = load_yaml(args.config)
    mappings = config.get("mvp_mappings") or {}
    persist_summary = json.load(open(args.persist_summary)) if os.path.exists(args.persist_summary) else {}
    signup_counts_resp = (
        json.load(open(args.signup_counts))
        if os.path.exists(args.signup_counts)
        else {"results": []}
    )

    # Merge signup_events from config into data
    for mvp in data["mvps"]:
        mapping = mappings.get(mvp["name"]) or {}
        mvp["signup_events"] = mapping.get("signup_events") or []
        mvp.setdefault("signups", 0)

    # Apply signup counts (from PostHog UNION ALL query)
    counts = {row[0]: row[1] for row in signup_counts_resp.get("results", [])}
    for mvp in data["mvps"]:
        if mvp["name"] in counts:
            mvp["signups"] = counts[mvp["name"]]
        # If MVP not in counts (had empty signup_events), leave at 0

    # Sanity check: signups/visitors > 50% AND visitors >= 10 → suspect
    suspects = []
    for mvp in data["mvps"]:
        v = mvp.get("gclid_visitors", 0) or 0
        s = mvp.get("signups", 0) or 0
        if v >= 10 and (s / v) > 0.5:
            suspects.append({
                "name": mvp["name"],
                "visitors": v,
                "signups": s,
                "ratio": round(s / v, 2),
                "signup_events": mvp.get("signup_events", []),
            })

    # Write updated data
    with open(args.data, "w") as f:
        json.dump(data, f, indent=2)

    # Build summary counts by classified_by
    by_source = {}
    for mvp in data["mvps"]:
        src = (mappings.get(mvp["name"]) or {}).get("classified_by") or "unknown"
        by_source[src] = by_source.get(src, 0) + 1

    # Print human summary
    print()
    print(f"Classification summary ({len(data['mvps'])} MVPs):")
    for src, n in sorted(by_source.items()):
        print(f"  • {n}  {src}")
    print()

    if suspects:
        print(f"⚠ Suspect (signups/visitors > 50%; likely misclassification):")
        for s in suspects:
            print(
                f"  • {s['name']}: {s['visitors']}v / {s['signups']}sg "
                f"(ratio {s['ratio']}) — signup_events: {s['signup_events']}"
            )
        print()
        print("Action: edit experiment/iterate-cross-config.yaml — update signup_events for the")
        print("suspect MVP(s) and set `classified_by: operator` to lock it. Re-run /iterate --cross.")
        print()

    # Top inferred classifications (for review)
    inferred = [
        mvp for mvp in data["mvps"]
        if (mappings.get(mvp["name"]) or {}).get("classified_by", "").endswith("-inferred")
    ]
    if inferred:
        print(f"Top LLM-inferred classifications (review-recommended):")
        for mvp in inferred[:10]:
            mapping = mappings.get(mvp["name"]) or {}
            events = mvp.get("signup_events", [])
            rationale = mapping.get("rationale", "")
            print(f"  • {mvp['name']} → {events}")
            if rationale:
                print(f"       {rationale}")
        print()

    if persist_summary.get("filtered_events"):
        print(f"Hard-exclusion filter stripped events from {len(persist_summary['filtered_events'])} MVPs:")
        for entry in persist_summary["filtered_events"]:
            print(f"  • {entry['name']}: removed {entry['removed']}")
        print()

    print(
        f"Cached mappings live in {args.config}. To override, edit signup_events and"
    )
    print("set classified_by: operator to lock against future runs.")

    # Exit non-zero ONLY if suspects exist AND --strict-sanity flag passed
    # By default, suspects warn but don't block (operator can decide).
    if args.strict_sanity and suspects:
        return 1
    return 0


# ---------- Main ----------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prep = sub.add_parser("prepare")
    p_prep.add_argument("--data", default=".runs/iterate-cross-data.json")
    p_prep.add_argument("--issues", default=".runs/iterate-cross-data-issues.json")
    p_prep.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p_prep.add_argument("--output", default=".runs/_iterate-cross-classify-input.json")
    p_prep.set_defaults(func=cmd_prepare)

    p_persist = sub.add_parser("persist")
    p_persist.add_argument("--input", default=".runs/_iterate-cross-classify-input.json")
    p_persist.add_argument("--proposals", default=".runs/_iterate-cross-classify-proposals.json")
    p_persist.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p_persist.add_argument("--summary", default=".runs/_iterate-cross-classify-persist-summary.json")
    p_persist.set_defaults(func=cmd_persist)

    p_final = sub.add_parser("finalize")
    p_final.add_argument("--data", default=".runs/iterate-cross-data.json")
    p_final.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p_final.add_argument("--signup-counts", default=".runs/_iterate-cross-signups-out.json")
    p_final.add_argument("--persist-summary", default=".runs/_iterate-cross-classify-persist-summary.json")
    p_final.add_argument("--strict-sanity", action="store_true",
                         help="Exit non-zero if any suspect MVP detected (default: warn only).")
    p_final.set_defaults(func=cmd_finalize)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

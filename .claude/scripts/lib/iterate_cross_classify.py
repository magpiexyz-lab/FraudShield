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


def merge_mvp_aliases(
    discovery_rows: list[list],
    aliases: dict[str, list[str]],
) -> tuple[list[list], list[dict]]:
    """Merge aliased MVP rows into their canonical entry.

    Used by /iterate --cross state-x0 to dedup legacy duplicates — MVPs that
    were created before /bootstrap state-3 enforced kebab-case naming, so the
    same product exists in PostHog under two `project_name` values (e.g.
    `splitshare` and `split-share-neon`). The canonical form is named in
    `experiment/iterate-cross-config.yaml::mvp_aliases.<canonical>: [alias_a,
    alias_b, ...]`.

    Input rows follow the PostHog discovery query shape:
        [mvp_key, sample_utm_campaign, gclid_visitors, first_seen, last_seen]

    Merge semantics per canonical key:
    - gclid_visitors = sum of canonical row + all matched alias rows
    - first_seen = min, last_seen = max (across canonical + aliases)
    - sample_utm_campaign = pick from the row with the highest gclid_visitors
      (preserves the strongest signal for downstream filtering)

    Returns (merged_rows, audit). `audit` is a list of:
        {canonical, absorbed_aliases, absorbed_visitors, total_visitors}
    for the operator confirmation message.

    Rules:
    - Aliases referenced in config but absent from discovery are silently
      ignored (config can lag the data).
    - If a canonical key is absent from discovery but at least one alias is
      present, the canonical record is synthesized from the highest-visitor
      alias (so the merged row is still attributed to the canonical name).
    - If the SAME alias is listed under TWO different canonical keys, the
      function raises ValueError — that is a config-side mistake that should
      surface loudly, not be silently resolved.

    Idempotent: applying the merge to already-merged input is a no-op
    (aliases removed in the first pass aren't present in the input the
    second time).
    """
    if not aliases:
        return list(discovery_rows), []

    # Detect alias collisions across canonicals — fail loudly.
    reverse: dict[str, str] = {}
    for canonical, alias_list in aliases.items():
        for alias in (alias_list or []):
            if alias in reverse and reverse[alias] != canonical:
                raise ValueError(
                    f"merge_mvp_aliases: alias {alias!r} listed under both "
                    f"{reverse[alias]!r} and {canonical!r} — pick one canonical."
                )
            reverse[alias] = canonical

    # Index rows by mvp_key
    by_key: dict[str, list] = {}
    for row in discovery_rows:
        if not row:
            continue
        by_key[row[0]] = row

    merged: dict[str, list] = {}
    audit: list[dict] = []

    # First pass: copy non-alias canonical rows through.
    aliased_keys = set(reverse.keys())
    canonical_keys = set(aliases.keys())
    for key, row in by_key.items():
        if key in aliased_keys:
            continue  # handled in pass 2
        merged[key] = list(row)

    # Second pass: collapse aliases into canonicals.
    for canonical, alias_list in aliases.items():
        sources: list[list] = []
        canonical_row = by_key.get(canonical)
        if canonical_row is not None:
            sources.append(canonical_row)
        for alias in (alias_list or []):
            alias_row = by_key.get(alias)
            if alias_row is not None:
                sources.append(alias_row)

        if not sources:
            continue  # no rows touched — config refers to MVPs not in data

        # gclid_visitors = sum
        total_visitors = sum((r[2] or 0) for r in sources)
        # sample_utm_campaign = winner by visitor count
        winner = max(sources, key=lambda r: (r[2] or 0))
        sample_utm = winner[1]
        # first_seen = min, last_seen = max (handle None safely; strings sort by ISO)
        first_seens = [r[3] for r in sources if r[3]]
        last_seens = [r[4] for r in sources if r[4]]
        first_seen = min(first_seens) if first_seens else None
        last_seen = max(last_seens) if last_seens else None

        merged[canonical] = [
            canonical, sample_utm, total_visitors, first_seen, last_seen
        ]
        absorbed = [a for a in (alias_list or []) if a in by_key]
        if absorbed or canonical_row is not None:
            audit.append({
                "canonical": canonical,
                "absorbed_aliases": absorbed,
                "absorbed_visitors": sum(
                    (by_key[a][2] or 0) for a in absorbed
                ),
                "total_visitors": total_visitors,
            })

    # Preserve discovery order: canonical rows in original position, aliases
    # already absorbed. Synthesized canonicals (absent from discovery but
    # present via alias) are appended at the end.
    ordered: list[list] = []
    seen: set[str] = set()
    for row in discovery_rows:
        if not row:
            continue
        key = row[0]
        canon = reverse.get(key, key)
        if canon in seen:
            continue
        if canon in merged:
            ordered.append(merged[canon])
            seen.add(canon)
    # Append any synthesized canonicals not seen during ordering pass.
    for canon in canonical_keys:
        if canon in merged and canon not in seen:
            ordered.append(merged[canon])
            seen.add(canon)

    return ordered, audit


def kebab_normalize(s: str) -> str:
    """Normalize a name to kebab-case (preserves separators).

    Mirrors validate_experiment_yaml.kebab_suggest. Kept for any caller
    that wants the kebab-formatted form. For ORPHAN HOST MATCHING use
    `match_key` instead — orphan hosts come from URL domains (e.g.,
    `xpredict.draftlabs.org` -> `xpredict`) which lose kebab separators.
    """
    if not isinstance(s, str):
        return ""
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def match_key(s: str) -> str:
    """Produce a comparable key for canonical name <-> orphan host matching.

    Strips ALL non-alphanumeric characters (including hyphens). This is
    necessary because orphan host_prefix is the URL subdomain
    (e.g., `xpredict.draftlabs.org` -> `xpredict`) which never contains
    hyphens, while canonical project_name follows kebab-case
    (e.g., `x-predict`). Without this looser match, the two would never
    correspond and orphan merge could not detect partial-tracking deploys.
    """
    if not isinstance(s, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def merge_orphan_overlap(
    discovery_rows: list[list],
    orphan_rows: list[list],
    overlap_counts: dict[str, dict],
    threshold: float = 0.70,
) -> tuple[list[list], list[list], list[dict]]:
    """Merge orphan rows into canonical rows when gclid overlap exceeds threshold.

    Inputs:
      - discovery_rows: PostHog canonical-discovery shape:
          [mvp_key, sample_utm_campaign, gclid_visitors, first_seen, last_seen]
        Rows may have a 6th element (`partial_tracking_pct`) if previously merged.
      - orphan_rows: PostHog orphan-discovery shape:
          [host_prefix, gclid_visitors]
      - overlap_counts: dict[canonical_name -> {orphan_host, canonical_gclids,
          orphan_gclids, overlap}]  (queried serially in state-x0)
      - threshold: 0.70 default. Merge if `overlap / min(canonical, orphan) >= threshold`.

    Returns (merged_discovery, remaining_orphans, audit).
      - merged_discovery: canonical rows possibly augmented with
        `partial_tracking_pct` as 6th element
      - remaining_orphans: orphan rows whose overlap was below threshold OR
        had no matching canonical (kept as MISSING_PROJECT_NAME)
      - audit: per-merge record for the operator report

    Merge semantics for a high-overlap orphan -> canonical:
      - canonical.gclid_visitors stays as-is (canonical IS the authoritative
        count; orphan visitors are a subset of canonical via gclid overlap)
      - canonical row gets `partial_tracking_pct = (orphan_gclids - overlap) /
        orphan_gclids` (fraction of orphan visitors NOT in canonical -- i.e.,
        pages where project_name is missing AND distinct from any canonical-
        tracked page; this is the operator-actionable signal)
      - orphan row dropped from remaining_orphans

    Low-overlap orphans (< threshold) AND orphans with no matching canonical
    name pass through as remaining_orphans -> MISSING_PROJECT_NAME verdict.

    Idempotent: re-applying to already-merged input leaves the `partial_tracking_pct`
    field intact (since orphan row was already removed in the first pass).
    """
    merged: list[list] = []
    remaining: list[list] = []
    audit: list[dict] = []

    consumed_orphans: set[str] = set()
    for canonical_row in discovery_rows:
        if not canonical_row:
            continue
        canon_name = canonical_row[0]
        canon_norm = match_key(canon_name)
        # Find orphan with matching normalized name
        matched_orphan = None
        for orphan_row in orphan_rows:
            if not orphan_row:
                continue
            orphan_host = orphan_row[0]
            if match_key(orphan_host) == canon_norm:
                matched_orphan = orphan_row
                break

        if matched_orphan is None:
            merged.append(list(canonical_row))
            continue

        # We have a canonical + matching orphan; check overlap
        overlap_data = overlap_counts.get(canon_name) or overlap_counts.get(canon_norm)
        if not overlap_data:
            # No overlap data available -- conservative: keep separate
            merged.append(list(canonical_row))
            continue

        canon_gclids = overlap_data.get("canonical_gclids", 0) or 0
        orph_gclids = overlap_data.get("orphan_gclids", 0) or 0
        overlap = overlap_data.get("overlap", 0) or 0
        base = min(canon_gclids, orph_gclids)
        if base == 0:
            merged.append(list(canonical_row))
            continue

        if overlap / base >= threshold:
            # Merge: canonical gets partial_tracking_pct appended
            pct = (orph_gclids - overlap) / orph_gclids if orph_gclids > 0 else 0.0
            new_row = list(canonical_row)
            # Append 6th element: partial_tracking_pct. If row already has 6th
            # element (re-merge), overwrite (idempotent semantics).
            if len(new_row) >= 6:
                new_row[5] = round(pct, 4)
            else:
                new_row.append(round(pct, 4))
            merged.append(new_row)
            consumed_orphans.add(matched_orphan[0])
            audit.append({
                "canonical": canon_name,
                "orphan_host": matched_orphan[0],
                "canonical_gclids": canon_gclids,
                "orphan_gclids": orph_gclids,
                "overlap": overlap,
                "overlap_pct": round(overlap / base, 4),
                "partial_tracking_pct": round(pct, 4),
                "action": "merged",
            })
        else:
            merged.append(list(canonical_row))
            audit.append({
                "canonical": canon_name,
                "orphan_host": matched_orphan[0],
                "overlap_pct": round(overlap / base, 4) if base else 0,
                "action": "kept-separate-low-overlap",
            })

    # Remaining orphans: those not consumed
    for orphan_row in orphan_rows:
        if not orphan_row:
            continue
        if orphan_row[0] not in consumed_orphans:
            remaining.append(list(orphan_row))

    return merged, remaining, audit


def cmd_merge_orphan_overlap(args: argparse.Namespace) -> int:
    """CLI subcommand: merge orphan rows into canonicals where gclid overlap >= threshold.

    Reads discovery + orphan + overlap JSON; writes merged discovery (with
    `partial_tracking_pct` appended on absorbed rows) + remaining orphans.
    Idempotent.
    """
    for path in (args.discovery, args.orphan, args.overlap):
        if not os.path.exists(path):
            print(f"ERROR: input file not found: {path}", file=sys.stderr)
            return 1

    with open(args.discovery) as fh:
        disc = json.load(fh)
    with open(args.orphan) as fh:
        orph = json.load(fh)
    with open(args.overlap) as fh:
        overlap = json.load(fh)

    disc_rows = disc.get("results") or []
    orph_rows = orph.get("results") or []
    # overlap.json shape: {"by_canonical": {canon_name: {orphan_host, canonical_gclids, orphan_gclids, overlap}}}
    overlap_data = overlap.get("by_canonical") or {}

    config = load_yaml(args.config)
    threshold = (config or {}).get("orphan_merge_overlap_threshold", 0.70)

    merged, remaining, audit = merge_orphan_overlap(
        disc_rows, orph_rows, overlap_data, threshold=threshold
    )

    disc["results"] = merged
    disc["orphan_merge_audit"] = audit
    orph["results"] = remaining

    # Atomic writes
    for path, data in [(args.discovery, disc), (args.orphan, orph)]:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, path)

    merged_count = sum(1 for a in audit if a["action"] == "merged")
    print(
        f"merge-orphan-overlap: {len(disc_rows)} canonical / {len(orph_rows)} orphan -> "
        f"{len(merged)} canonical / {len(remaining)} orphan; "
        f"{merged_count} merge(s) at threshold {threshold}"
    )
    return 0


def cmd_merge_aliases(args: argparse.Namespace) -> int:
    """CLI subcommand: read discovery JSON + config, write merged discovery.

    Idempotent and safe to overwrite the same path (read entire input first).
    """
    if not os.path.exists(args.discovery):
        print(f"ERROR: discovery file not found: {args.discovery}",
              file=sys.stderr)
        return 1
    with open(args.discovery) as fh:
        raw = json.load(fh)
    rows = raw.get("results") or []

    config = load_yaml(args.config)
    aliases = (config or {}).get("mvp_aliases") or {}

    try:
        merged_rows, audit = merge_mvp_aliases(rows, aliases)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    raw["results"] = merged_rows
    # Stamp a small audit field so x0 can render the operator message.
    raw["alias_merge_audit"] = audit

    out_path = args.output
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(raw, fh, indent=2)
    os.replace(tmp, out_path)

    pairs = sum(1 for a in audit if a["absorbed_aliases"])
    n_before = len(rows)
    n_after = len(merged_rows)
    print(
        f"merge-aliases: {n_before} → {n_after} rows; "
        f"{pairs} canonical(s) absorbed alias data → {out_path}"
    )
    return 0


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

    p_merge = sub.add_parser(
        "merge-aliases",
        help="Merge MVP rows declared as aliases in iterate-cross-config.yaml into canonicals.",
    )
    p_merge.add_argument("--discovery", default=".runs/_iterate-cross-discover.json",
                         help="PostHog discovery output (read; safe to also be the --output path)")
    p_merge.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p_merge.add_argument("--output", default=".runs/_iterate-cross-discover.json",
                         help="Where to write the merged discovery (idempotent overwrite OK)")
    p_merge.set_defaults(func=cmd_merge_aliases)

    p_orph = sub.add_parser(
        "merge-orphan-overlap",
        help="Merge orphan host rows into canonical rows when gclid overlap >= threshold.",
    )
    p_orph.add_argument("--discovery", default=".runs/_iterate-cross-discover.json",
                        help="Canonical discovery JSON (modified in place with partial_tracking_pct field)")
    p_orph.add_argument("--orphan", default=".runs/_iterate-cross-orphan.json",
                        help="Orphan discovery JSON (modified in place; merged orphans removed)")
    p_orph.add_argument("--overlap", default=".runs/_iterate-cross-overlap.json",
                        help="Per-canonical overlap counts {by_canonical: {name: {canonical_gclids, orphan_gclids, overlap}}}")
    p_orph.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p_orph.set_defaults(func=cmd_merge_orphan_overlap)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

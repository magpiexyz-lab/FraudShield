#!/usr/bin/env python3
"""iterate_cross_ga.py — Bucket Google Ads campaigns into MVP records and merge clicks
into the iterate-cross context.

State-x0a runs this after the operator exports a CSV from Google Ads UI and saves it
at .runs/iterate-cross-ga-clicks.csv. It folds `ga_clicks` into the per-MVP records
produced by state-x0, creates `ga_only` records for campaigns with no PostHog MVP,
and emits warnings for genuinely unmatched campaigns.

Browser scraping was removed (PR fix/iterate-cross-csv-blocking). Rationale:
the scraper was brittle to Google Ads UI changes (column-position drift, render
timing, virtualization, anti-automation fallback page) and failed silently —
producing zero or junk `ga_clicks` values that masqueraded as real data. CSV
export is the only supported source; state-x0a halts loudly if the file is
missing or malformed.

Input shape (CSV at .runs/iterate-cross-ga-clicks.csv):
  Header row required. Required columns (case-insensitive substring match):
    Campaign, Clicks
  Optional columns: Account, Conversions (or Conv.), Impressions / Impr.
  Column order is irrelevant — the parser indexes by header.
  Thousands separators (1,082) are stripped.
  UTF-8 BOM is stripped. Summary footer rows (starting with "Total:") are skipped.

Subcommands:
  validate-csv — verify the CSV has required columns + at least one data row.
                 State-x0a calls this BEFORE merge to fail-fast with a clear
                 diagnostic when the operator's export is missing columns.
  merge        — fold CSV clicks into .runs/iterate-cross-context.json.

Bucketing algorithm (unchanged):
  1. Compute campaign-MVP-name by stripping ad-naming suffixes
     (-search-v1, _Search_V1, etc.).
  2. Try substring match of stripped name's match_key against existing MVP keys.
  3. If no PH match, check operator-declared `ga_campaign_aliases` in config
     (keyed by match_key of campaign name).
  4. If still no match AND the stripped name is alphabetic (not "Campaign #1"),
     auto-create a `ga_only` MVP record.
  5. Otherwise: stderr warning + emit to unmatched-out file.

Why match_key (alphanumeric-only normalizer): reused from iterate_cross_classify.py.
Operator-declared kebab/snake/camel variants of the same MVP-name all collapse to
one key. Same matcher used for the orphan-host merge in state-x0.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys

# Reuse the existing matcher to avoid drift between orphan-host merge and GA bucket logic.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iterate_cross_classify import match_key  # noqa: E402


# Patterns we strip from a GA campaign name to recover its MVP prefix.
# Stripped left-to-right; longest patterns first to avoid partial matches
# leaving residue (e.g., "search-v1" left over after stripping "v1").
#
# Separator class `[SEP]` covers whitespace, underscore, hyphen, em-dash,
# and en-dash (Google Ads name editor produces all four; the em-dash form
# appears in "NeuralPost — Phase 1 — Search").
_SEP = r"[\s_\-–—]"
_AD_SUFFIX_PATTERNS = [
    # Date-suffixed campaign variants (NeuralPost_5Day_Apr2026, etc.)
    rf"{_SEP}+\d+{_SEP}*day{_SEP}+\w{{3}}\d{{4}}\b.*",  # e.g. "_5Day_Apr2026"
    # Phase / Search / v-numbered suffixes
    rf"{_SEP}+search{_SEP}+validation{_SEP}+v\d+\b.*",   # "_Search_Validation_V1"
    rf"{_SEP}+search{_SEP}+v\d+(?:{_SEP}+\w+)?\b.*",      # "-search-v1", "_Search_V1", "-search-v1-manual"
    rf"{_SEP}+phase{_SEP}+\d+{_SEP}+search\b.*",          # "— Phase 1 — Search"
    rf"{_SEP}+search\b.*",                                # "-Search" (trailing)
    rf"{_SEP}+v\d+\b.*",                                   # bare "-v1"
    rf"{_SEP}+#\d+\b.*",                                   # "#1", "#2"
    # Trailing owner-suffix tokens (Lumen-Parth, StaylicaAi-Lew). These come AFTER
    # the prefix patterns above so they don't strip mid-name tokens.
    rf"{_SEP}+(?:parth|lew|lego|lee|radlin|anurag|karan|taran|pcentric|lathiya)\b.*",
    # Dubai-style geographic suffix (Handpick - Dubai Search)
    rf"{_SEP}+dubai\b.*",
    # Performance-max viral-traffic markers
    rf"{_SEP}*[—\-]{_SEP}+pmax\b.*",
]


def extract_mvp_name(campaign_name: str) -> str:
    """Strip GA suffix patterns to recover the underlying MVP name.

    Returns the stripped name (still original case + punctuation). Caller
    typically pipes through `match_key()` before comparison.
    """
    name = (campaign_name or "").strip()
    for pat in _AD_SUFFIX_PATTERNS:
        name = re.sub(pat, "", name, flags=re.IGNORECASE)
    return name.strip(" -_")


def is_placeholder_campaign(campaign_name: str) -> bool:
    """True when the campaign name is a generic Google Ads placeholder (no MVP signal).

    `Campaign #1`, `Campaign #2`, etc. are created by Google Ads as default names
    for new campaigns. Without a real name, we cannot bucket — operator must rename
    or add an alias.

    Also matches placeholder names with a trailing parenthetical disambiguator
    (e.g. "Campaign #1 (Parth)") — those are placeholders that operators have
    annotated with the owner's name but never renamed properly.
    """
    if not campaign_name:
        return True
    return bool(
        re.match(
            r"^\s*campaign\s*#?\d+(\s*\([^)]*\))?\s*$",
            campaign_name,
            flags=re.IGNORECASE,
        )
    )


def bucket_campaign(
    campaign_name: str,
    mvp_keys: set[str],
    aliases: dict[str, str] | None = None,
) -> tuple[str | None, str]:
    """Return (mvp_name, reason) for a single campaign.

    - mvp_name: the canonical MVP key this campaign belongs to (None if unmatched).
    - reason: short tag describing how the match was made
              ("ph-substring", "alias", "ga-only-auto", "unmatched", "placeholder").

    Strategy:
      1. If campaign is a placeholder ("Campaign #1") → unmatched.
      2. Extract candidate MVP-name by stripping ad suffixes.
      3. Substring match against existing PH MVP match_keys (longest match wins).
      4. Check operator-declared aliases (keyed by full campaign match_key).
      5. Otherwise auto-create a ga_only MVP using the stripped name.
    """
    aliases = aliases or {}

    if is_placeholder_campaign(campaign_name):
        return None, "placeholder"

    candidate = extract_mvp_name(campaign_name)
    candidate_key = match_key(candidate)

    # Step 1: substring match — longest match wins. Reverse-sorted by length so
    # "stylica-ai" matches before "stylica" (if both happened to exist).
    mvp_match_keys = sorted(
        ((k, match_key(k)) for k in mvp_keys if k and not k.startswith("__")),
        key=lambda kv: -len(kv[1]),
    )
    for k, mk in mvp_match_keys:
        if not mk:
            continue
        if mk in candidate_key:
            return k, "ph-substring"

    # Step 2: operator alias on the full (un-stripped) campaign name.
    full_key = match_key(campaign_name)
    if full_key in aliases:
        return aliases[full_key], "alias"

    # Also try the stripped key against aliases.
    if candidate_key in aliases:
        return aliases[candidate_key], "alias"

    # Step 3: auto-create ga_only MVP from the stripped candidate.
    if candidate_key and candidate_key.isalnum():
        # Use the stripped candidate (lowercased, hyphenated) as the new MVP name.
        # Don't kebab-case here — preserve a recognizable form.
        ga_only_name = re.sub(r"[\s_]+", "-", candidate).lower().strip("-")
        if ga_only_name:
            return ga_only_name, "ga-only-auto"

    return None, "unmatched"


def parse_ga_csv(csv_text: str) -> list[dict]:
    """Parse Google Ads CSV export.

    Header row REQUIRED. Columns matched by case-insensitive substring on header:
      - Campaign (required)
      - Clicks (required)
      - Conversions / Conv. (optional, defaults to 0)
      - Impressions / Impr. (optional, defaults to 0)
      - Account (optional, defaults to empty string)
    Column ORDER does not matter — the parser indexes by header position.

    Tolerances:
      - UTF-8 BOM at file start is stripped.
      - Summary footer rows (first cell starts with "Total") are skipped.
      - Thousands separators in numeric cells (1,082) are stripped.
      - Empty / whitespace-only rows are skipped.
      - Rows whose Campaign cell is empty are skipped.

    Returns an empty list when required columns are absent — state-x0a's
    `validate-csv` subcommand fails the gate before this is called, so
    reaching this path implies CSV is valid; the empty-list return is a
    defensive fallback.
    """
    if csv_text.startswith("﻿"):
        csv_text = csv_text[1:]  # strip UTF-8 BOM
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        return []
    header = [(h or "").strip().lower() for h in rows[0]]

    def find(*keys: str) -> int | None:
        for i, h in enumerate(header):
            for k in keys:
                if k in h:
                    return i
        return None

    i_name = find("campaign")
    i_clicks = find("clicks")
    if i_name is None or i_clicks is None:
        return []
    i_conv = find("conversions", "conv.")
    i_account = find("account")

    out: list[dict] = []
    for row in rows[1:]:
        if not row or i_name >= len(row):
            continue
        name = (row[i_name] or "").strip()
        if not name:
            continue
        if name.lower().startswith("total"):
            continue  # skip summary footer
        try:
            clicks_raw = (row[i_clicks] or "0").strip().replace(",", "") if i_clicks < len(row) else "0"
            clicks = int(clicks_raw or 0)
        except (ValueError, IndexError):
            continue
        conv = 0.0
        if i_conv is not None and i_conv < len(row):
            try:
                conv = float((row[i_conv] or "0").strip().replace(",", "") or 0)
            except ValueError:
                pass
        account = (row[i_account] or "").strip() if i_account is not None and i_account < len(row) else ""
        out.append({"name": name, "account": account, "type": "", "clicks": clicks, "conv": conv})
    return out


def merge_ga_clicks(
    campaigns: list[dict],
    mvp_records: list[dict],
    aliases: dict[str, str] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Fold GA clicks into MVP records.

    Returns (updated_mvps, unmatched).
      - updated_mvps: original list + any new ga_only MVPs, with ga_clicks set on each.
      - unmatched: list of campaign records that could not be bucketed (placeholder
        or below-threshold). Each entry: {name, clicks, account, reason}.

    Idempotent: re-applying with the same input produces the same output.
    Existing `ga_clicks` values are OVERWRITTEN (not accumulated) so re-runs
    reflect the latest scrape.
    """
    aliases = aliases or {}
    # Include MVP keys for substring matching but also build a parallel index
    # of orphan-host match_keys so a GA auto-create whose name collides with an
    # existing orphan (e.g. campaign "Hospitica-search-v2" while PH has
    # `__orphan_hospitica__`) attributes clicks to the orphan record, not a
    # parallel ga_only duplicate.
    real_keys = {
        m.get("name") or ""
        for m in mvp_records
        if isinstance(m, dict) and not (m.get("name") or "").startswith("__orphan_")
    }
    orphan_index: dict[str, str] = {}
    for m in mvp_records:
        if not isinstance(m, dict):
            continue
        name = m.get("name") or ""
        if name.startswith("__orphan_") and name.endswith("__"):
            host = name[len("__orphan_"):-len("__")]
            orphan_index[match_key(host)] = name

    bucket_totals: dict[str, dict] = {}
    unmatched: list[dict] = []

    for c in campaigns:
        bucket, reason = bucket_campaign(c["name"], real_keys, aliases)
        if bucket is None:
            unmatched.append({**c, "reason": reason})
            continue
        # ga-only-auto: check if it collides with an orphan record before creating
        # a separate ga_only MVP. Orphan record means "PH did see traffic for this
        # deploy but it had NULL project_name" — strictly more PH presence than
        # ga_only (which is "PH saw nothing"), so the orphan record absorbs the
        # ga_clicks signal.
        if reason == "ga-only-auto":
            if c["clicks"] == 0:
                continue  # skip noise
            cand_key = match_key(bucket)
            if cand_key in orphan_index:
                bucket = orphan_index[cand_key]
                reason = "orphan-via-ga"
        if bucket not in bucket_totals:
            bucket_totals[bucket] = {
                "clicks": 0,
                "conv": 0.0,
                "campaigns": [],
                "reason": reason,
            }
        bucket_totals[bucket]["clicks"] += c["clicks"]
        bucket_totals[bucket]["conv"] += c["conv"]
        bucket_totals[bucket]["campaigns"].append(c["name"])

    # Apply totals to existing MVP records (in place).
    by_name = {m.get("name"): m for m in mvp_records if isinstance(m, dict)}
    for m in mvp_records:
        m["ga_clicks"] = 0
        m["ga_conv"] = 0.0
        m["ga_campaigns"] = []

    new_records: list[dict] = []
    for bucket, totals in bucket_totals.items():
        if bucket in by_name:
            target = by_name[bucket]
            target["ga_clicks"] = totals["clicks"]
            target["ga_conv"] = totals["conv"]
            target["ga_campaigns"] = sorted(totals["campaigns"])
        else:
            # ga_only MVP — create a synthetic record using the same shape state-x0 produces.
            new_records.append({
                "name": bucket,
                "gclid_visitors": 0,
                "first_seen": None,
                "last_seen": None,
                "sample_utm_campaign": None,
                "owner": None,
                "deploy_domain": None,
                "phase_match": None,
                "orphan": False,
                "partial_tracking_pct": None,
                "ga_clicks": totals["clicks"],
                "ga_conv": totals["conv"],
                "ga_campaigns": sorted(totals["campaigns"]),
                "ga_only": True,
            })

    return mvp_records + new_records, unmatched


# ---------- CLI ----------

def _load_csv(args: argparse.Namespace) -> list[dict]:
    """Resolve the campaigns list from --ga-csv. Returns [] if missing or unreadable."""
    if args.ga_csv and os.path.exists(args.ga_csv):
        return parse_ga_csv(open(args.ga_csv, encoding="utf-8").read())
    return []


def _load_aliases(config_path: str | None) -> dict[str, str]:
    """Read `ga_campaign_aliases` from iterate-cross-config.yaml."""
    if not config_path or not os.path.exists(config_path):
        return {}
    try:
        import yaml
    except ImportError:
        return {}
    cfg = yaml.safe_load(open(config_path)) or {}
    aliases = cfg.get("ga_campaign_aliases") or {}
    # Normalize keys via match_key so operator can write them in any case/punct form.
    return {match_key(k): v for k, v in aliases.items() if v}


def cmd_validate_csv(args: argparse.Namespace) -> int:
    """Verify the CSV has required header columns. Exit non-zero on failure.

    Called by state-x0a Step 0 BEFORE merge to fail-fast with a clear diagnostic
    when the operator's export is missing columns. Soft-warns (still exits 0)
    on header-only CSV — that case can legitimately happen if the date window
    captured zero paid clicks.
    """
    if not args.ga_csv or not os.path.exists(args.ga_csv):
        print(f"ERROR: CSV not found at {args.ga_csv}", file=sys.stderr)
        return 2
    with open(args.ga_csv, encoding="utf-8") as f:
        text = f.read()
    if text.startswith("﻿"):
        text = text[1:]  # strip BOM before checking emptiness
    if not text.strip():
        print(f"ERROR: CSV is empty: {args.ga_csv}", file=sys.stderr)
        return 2
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        print(f"ERROR: CSV has no rows: {args.ga_csv}", file=sys.stderr)
        return 2
    header = [(h or "").strip().lower() for h in rows[0]]
    required = {"campaign": False, "clicks": False}
    for col in header:
        for key in required:
            if key in col:
                required[key] = True
    missing = [k for k, v in required.items() if not v]
    if missing:
        print(
            f"ERROR: CSV missing required columns: {missing}. "
            f"Header was: {rows[0]}. "
            f"Re-export from Google Ads UI with at least Campaign and Clicks columns.",
            file=sys.stderr,
        )
        return 2
    if len(rows) < 2:
        # Header-only: legitimate when the window has zero paid clicks. Warn only.
        print(
            f"WARN: CSV has header but zero data rows. If your date range had "
            f"zero paid clicks that is correct; otherwise re-export. Skill will "
            f"proceed with ga_clicks=0 on every MVP.",
            file=sys.stderr,
        )
    return 0


def cmd_merge(args: argparse.Namespace) -> int:
    campaigns = _load_csv(args)
    if not campaigns:
        print("merge: no GA campaigns provided (or all empty); writing pass-through.", file=sys.stderr)

    aliases = _load_aliases(args.config)

    # Load target context (state-x0 output)
    if not os.path.exists(args.context):
        print(f"ERROR: --context path does not exist: {args.context}", file=sys.stderr)
        return 2
    ctx = json.load(open(args.context))
    mvps = ctx.get("mvps") or []

    merged, unmatched = merge_ga_clicks(campaigns, mvps, aliases)
    ctx["mvps"] = merged
    # Record the CSV file's mtime as the data freshness stamp.
    ctx["ga_scraped_at"] = (
        __import__("datetime").datetime.fromtimestamp(
            os.path.getmtime(args.ga_csv),
            tz=__import__("datetime").timezone.utc,
        ).isoformat()
        if args.ga_csv and os.path.exists(args.ga_csv)
        else None
    )

    json.dump(ctx, open(args.context, "w"), indent=2)

    if args.unmatched_out:
        json.dump(unmatched, open(args.unmatched_out, "w"), indent=2)

    # Warn on stderr for the operator's attention.
    for u in unmatched:
        print(f"WARN: unmatched GA campaign '{u['name']}' ({u['clicks']} clicks, reason={u['reason']})", file=sys.stderr)

    ga_only_count = sum(1 for m in merged if m.get("ga_only"))
    augmented_count = sum(
        1 for m in merged if not m.get("ga_only") and m.get("ga_clicks", 0) > 0
    )
    print(
        f"merge: {len(campaigns)} campaigns → "
        f"{augmented_count} PH MVPs augmented, "
        f"{ga_only_count} ga_only MVPs added, "
        f"{len(unmatched)} unmatched."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bucket and merge Google Ads click data into /iterate --cross context.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_validate = sub.add_parser("validate-csv", help="Verify the GA CSV has required columns and at least one data row.")
    p_validate.add_argument("--ga-csv", default=".runs/iterate-cross-ga-clicks.csv", help="Input: operator-supplied CSV export from Google Ads.")
    p_validate.set_defaults(func=cmd_validate_csv)

    p_merge = sub.add_parser("merge", help="Fold GA clicks into iterate-cross-context.json.")
    p_merge.add_argument("--ga-csv", default=".runs/iterate-cross-ga-clicks.csv", help="Input: operator-supplied CSV export from Google Ads.")
    p_merge.add_argument("--context", default=".runs/iterate-cross-context.json", help="Target: state-x0 output to mutate.")
    p_merge.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p_merge.add_argument("--unmatched-out", default=".runs/_iterate-cross-ga-unmatched.json", help="Output: unmatched campaigns for operator triage.")
    p_merge.set_defaults(func=cmd_merge)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

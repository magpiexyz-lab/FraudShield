#!/usr/bin/env python3
"""Propagate iterate-cross context into data.json for state x1."""

from __future__ import annotations

import argparse
import json
import os


DB_FIELDS = [
    "db_signups", "db_signups_raw", "db_signups_real", "db_signups_team",
    "db_signups_test", "db_signups_filter_audit", "db_signups_real_windowed",
    "db_signups_table", "db_first_signup_at", "db_unmapped_reason", "db_source",
    "supabase_project_ref", "railway_project_id", "railway_project_name",
    "railway_service_name",
]


def build_records(
    ctx: dict,
    catalog_rows: list[list] | None = None,
    batch_status: dict | None = None,
) -> dict:
    if batch_status is None:
        raise RuntimeError("_x1_catalog_batches_status missing from catalog raw JSON — run_union_batches() must produce it")

    catalog_by_mvp: dict[str, list[dict]] = {}
    for row in catalog_rows or []:
        if len(row) < 6:
            continue
        mvp_key, event_name, stage, event_count, unique_users, gclid_users = row[:6]
        catalog_by_mvp.setdefault(mvp_key, []).append({
            "event": event_name,
            "event_count": event_count,
            "unique_users": unique_users,
            "gclid_users": gclid_users,
            "sample_stage": stage if stage else None,
        })

    records = []
    for m in ctx.get("mvps", []):
        name = m.get("name")
        catalog = sorted(catalog_by_mvp.get(name, []), key=lambda e: -(e.get("gclid_users") or 0))
        rec = {
            "name": name,
            "owner": m.get("owner"),
            "gclid_visitors": m.get("gclid_visitors", 0),
            "total_events_count": sum(e.get("event_count", 0) or 0 for e in catalog),
            "first_seen": m.get("first_seen"),
            "last_seen": m.get("last_seen"),
            "sample_utm_campaign": m.get("sample_utm_campaign"),
            "event_catalog": catalog[:30],
            "orphan": bool(m.get("orphan")),
            "ga_clicks": m.get("ga_clicks", 0),
            "ga_only": bool(m.get("ga_only")),
            "ga_campaigns": m.get("ga_campaigns") or [],
            "partial_tracking_pct": m.get("partial_tracking_pct"),
        }
        for field in DB_FIELDS:
            if field in m:
                rec[field] = m.get(field)
        rec.setdefault("db_signups", None)
        rec.setdefault("db_signups_raw", rec.get("db_signups"))
        rec.setdefault("db_signups_real", rec.get("db_signups"))
        rec.setdefault("db_signups_team", 0)
        rec.setdefault("db_signups_test", 0)
        rec.setdefault("db_signups_filter_audit", [])
        rec.setdefault("db_signups_real_windowed", None)
        records.append(rec)

    return {
        "mvps": records,
        "_x1_catalog_batches_status": batch_status,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--context", default=".runs/iterate-cross-context.json")
    p.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p.add_argument("--run-dir", default=".runs")
    p.add_argument("--catalog-raw", default=None)
    p.add_argument("--output", default=".runs/iterate-cross-data.json")
    p.add_argument("--dry-run", action="store_true", help="Compute and print summary without writing output.")
    args = p.parse_args(argv)

    ctx = json.load(open(args.context))
    raw_path = args.catalog_raw or os.path.join(args.run_dir, "_iterate-cross-catalog-raw.json")
    rows = []
    if os.path.exists(raw_path):
        raw = json.load(open(raw_path))
        rows = raw.get("results") or []
        batch_status = raw.get("_x1_catalog_batches_status")
    else:
        batch_status = None
    payload = build_records(ctx, rows, batch_status)
    if args.dry_run:
        print(f"DRY-RUN: would write {args.output} ({len(payload['mvps'])} MVPs)")
        return 0
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    json.dump(payload, open(args.output, "w"), indent=2)
    print(f"Wrote {args.output} ({len(payload['mvps'])} MVPs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

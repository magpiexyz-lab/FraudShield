#!/usr/bin/env python3
"""iterate_cross_verdicts.py — Pure-Python verdict computation for /iterate --cross.

PostHog-only. Reads:
  - .runs/iterate-cross-data.json     (gathered by state-x1, signups added in x2)
  - .runs/iterate-cross-data-issues.json (computed by state-x1a)
  - experiment/iterate-cross-config.yaml  (operator config; falls back to defaults)

Writes:
  - .runs/iterate-cross-scores.json   (consumed by state-x4)
  - .runs/iterate-cross-telegram.txt  (optional; --emit-telegram)

Verdict precedence (first match wins):
  0. MISSING_PROJECT_NAME    (issues.missing_project_name — orphan event stream)
  1. GA_NO_PH_TRACKING       (issues.ga_clicks_without_ph_traffic — GA has spend, PostHog blind)
  2. NO_DATA                 (issues.no_event_data)
  3. GO                      (signups >= signups_go)
  4. NO_GO                   (visitors >= visitors_floor AND signups == 0)
  5. WEAK                    (visitors >= visitors_floor AND 0 < signups < signups_go)
  6. INSUFFICIENT_DATA       (default; visitors_needed = visitors_floor - visitors)

Denominator rule: when mvp.ga_clicks > 0 (state-x0a merged Google Ads clicks),
`visitors = ga_clicks` (the more reliable signal — clicks are GA-counted directly,
not subject to PostHog SDK lazy-load failures). Otherwise fall back to PostHog
`gclid_visitors`. The score record exposes both numbers + `denominator_source`
so x4 can flag PH-overcount discrepancies (ph > ga * 1.10).
"""

from __future__ import annotations

import argparse
import json
import os
import sys


DEFAULT_CONFIG = {
    "signup_whitelist": [
        "signup_complete",
        "waitlist_signup",
        "waitlist_submit",
        "early_access_signup",
        "activate",
        "form_submitted",
    ],
    "mvp_mappings": {},
    "thresholds": {
        "signups_go": 3,
        "visitors_floor": 50,
    },
    "window_days": 90,
}

VERDICT_GO = "GO"
VERDICT_WEAK = "WEAK"
VERDICT_NO_GO = "NO_GO"
VERDICT_INSUFFICIENT = "INSUFFICIENT_DATA"
VERDICT_NO_DATA = "NO_DATA"
VERDICT_MISSING_PROJECT_NAME = "MISSING_PROJECT_NAME"
# GA campaign has paid clicks but PostHog has zero presence for this MVP (neither
# canonical events nor orphan rows). Strictly stricter than MISSING_PROJECT_NAME
# (which fires when PH SEES the traffic but project_name is NULL). This verdict
# surfaces deploys that the operator is paying for but cannot measure at all.
VERDICT_GA_NO_PH_TRACKING = "GA_NO_PH_TRACKING"

VERDICT_ENUM = {
    VERDICT_GO,
    VERDICT_WEAK,
    VERDICT_NO_GO,
    VERDICT_INSUFFICIENT,
    VERDICT_NO_DATA,
    VERDICT_MISSING_PROJECT_NAME,
    VERDICT_GA_NO_PH_TRACKING,
}


def load_config(path: str | None) -> dict:
    """Load YAML config; deep-merge with defaults so partial configs work."""
    config = {
        k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v)
        for k, v in DEFAULT_CONFIG.items()
    }
    if path and os.path.exists(path):
        try:
            import yaml
        except ImportError:
            print("WARN: PyYAML not installed; using defaults.", file=sys.stderr)
            return config
        user_config = yaml.safe_load(open(path)) or {}
        for key, default_value in DEFAULT_CONFIG.items():
            if key in user_config and user_config[key] is not None:
                if isinstance(default_value, dict) and isinstance(user_config[key], dict):
                    merged = dict(default_value)
                    merged.update(user_config[key])
                    config[key] = merged
                else:
                    config[key] = user_config[key]
        # Preserve user-supplied mvp_mappings (deep merge isn't appropriate; user controls)
        if "mvp_mappings" in user_config:
            config["mvp_mappings"] = user_config["mvp_mappings"] or {}
    return config


def compute_headline_verdict(mvp: dict, issues: dict, thresholds: dict) -> dict:
    """Apply precedence rules and return the score record for one MVP.

    Precedence (first match wins):
      0. missing_project_name → MISSING_PROJECT_NAME (orphan event stream — fix tracking)
      1. ga_clicks_without_ph_traffic → GA_NO_PH_TRACKING (paying for blind deploy)
      2. no_event_data → NO_DATA
      3. signups >= signups_go → GO
      4. visitors >= visitors_floor AND signups == 0 → NO_GO
      5. visitors >= visitors_floor AND 0 < signups < signups_go → WEAK
      6. (default) → INSUFFICIENT_DATA

    Denominator: ga_clicks when > 0 (state-x0a merged Google Ads data),
    else gclid_visitors. The PH count remains in metrics for diagnostics.
    """
    gclid_visitors = mvp.get("gclid_visitors", 0)
    ga_clicks = mvp.get("ga_clicks", 0) or 0
    signups = mvp.get("signups", 0)
    signup_events = mvp.get("signup_events") or []

    # Denominator selection: GA clicks override PH visitors when available.
    if ga_clicks > 0:
        visitors = ga_clicks
        denominator_source = "ga"
    else:
        visitors = gclid_visitors
        denominator_source = "ph"

    if issues.get("missing_project_name"):
        verdict = VERDICT_MISSING_PROJECT_NAME
    elif issues.get("ga_clicks_without_ph_traffic"):
        verdict = VERDICT_GA_NO_PH_TRACKING
    elif issues.get("no_event_data"):
        verdict = VERDICT_NO_DATA
    elif signups >= thresholds["signups_go"]:
        verdict = VERDICT_GO
    elif visitors >= thresholds["visitors_floor"] and signups == 0:
        verdict = VERDICT_NO_GO
    elif visitors >= thresholds["visitors_floor"]:
        verdict = VERDICT_WEAK
    else:
        verdict = VERDICT_INSUFFICIENT

    visitors_needed = (
        max(0, thresholds["visitors_floor"] - visitors)
        if verdict == VERDICT_INSUFFICIENT
        else 0
    )

    # PH conv_rate retained for back-compat with existing telegram/x4 consumers.
    conv_rate = (signups / gclid_visitors) if gclid_visitors > 0 else 0.0
    # True conv rate uses GA clicks when present — the operator-facing number.
    true_conv_rate = (signups / ga_clicks) if ga_clicks > 0 else conv_rate
    # Capture rate = how much of the paid traffic PostHog actually sees.
    # Null when no GA data available (we have no ground-truth denominator).
    capture_rate = (gclid_visitors / ga_clicks) if ga_clicks > 0 else None

    return {
        "name": mvp.get("name"),
        "owner": mvp.get("owner"),
        "headline_verdict": verdict,
        "visitors_needed": visitors_needed,
        "metrics": {
            "gclid_visitors": gclid_visitors,
            "ga_clicks": ga_clicks,
            "signups": signups,
            "conv_rate": round(conv_rate, 4),
            "true_conv_rate": round(true_conv_rate, 4),
            "capture_rate": round(capture_rate, 4) if capture_rate is not None else None,
            "denominator_source": denominator_source,
        },
        "signup_events": signup_events,
        # When state-x0 merged an orphan into this canonical record (high gclid
        # overlap = same deploy with partial page tracking), partial_tracking_pct
        # is the fraction of orphan visitors NOT covered by canonical tracking.
        # state-x4 renders a "⚠ partial tracking" marker on the row when set.
        "partial_tracking_pct": mvp.get("partial_tracking_pct"),
        "ga_only": bool(mvp.get("ga_only")),
        "ga_campaigns": mvp.get("ga_campaigns") or [],
    }


def parse_debug_prompts(content: str) -> dict:
    """Parse iterate-cross-debug-prompts.md into {HEADING: body_text}."""
    prompts: dict = {}
    current_key = None
    current_lines: list[str] = []
    for line in content.splitlines():
        if line.startswith("## "):
            if current_key:
                prompts[current_key] = "\n".join(current_lines).strip()
            current_key = line[3:].strip()
            current_lines = []
        elif current_key:
            current_lines.append(line)
    if current_key:
        prompts[current_key] = "\n".join(current_lines).strip()
    return prompts


ACTION_TEMPLATES = {
    VERDICT_GO: "Promote {name} to Phase 2 (run /iterate default mode for the deeper analysis).",
    VERDICT_WEAK: "{name}: above visitors floor but only {signups} signups. Investigate landing-page friction or extend campaign window before deciding.",
    VERDICT_NO_GO: "Stop {name}; document hypothesis rejection in retro.",
    VERDICT_INSUFFICIENT: "Keep {name} running until {visitors_needed} more visitors arrive (target: {visitors_floor}+).",
    VERDICT_NO_DATA: "Debug PostHog tracking for {name}. Run Claude Code in the MVP repo with the NO_DATA prompt below.",
    VERDICT_MISSING_PROJECT_NAME: "Fix {name} tracking: PostHog events arrived without `project_name`. Check `src/lib/analytics.ts` PROJECT_NAME constant — it must equal experiment.yaml.name (kebab-case). Re-run /verify in the MVP repo after fixing.",
    VERDICT_GA_NO_PH_TRACKING: "Fix {name}: Google Ads is serving paid traffic but PostHog records ZERO events. Either the deploy is missing src/lib/analytics.ts entirely, the ad's Final URL points to a page that doesn't import analytics, or PROJECT_NAME doesn't match what /iterate --cross expects. Check Final URL in Google Ads, then verify analytics.ts is imported on that page.",
}


def action_line(verdict: str, name: str, signups: int, visitors_needed: int, visitors_floor: int) -> str:
    template = ACTION_TEMPLATES.get(verdict, "Unknown verdict.")
    return template.format(
        name=name,
        signups=signups,
        visitors_needed=visitors_needed,
        visitors_floor=visitors_floor,
    )


def emit_telegram(scores: list, debug_prompts: dict, visitors_floor: int) -> str:
    """Group by owner; one block per owner; each block ≤ 4000 chars.

    If no MVP has owner set, all MVPs are grouped under 'unassigned'.
    """
    by_owner: dict = {}
    for s in scores:
        owner = s.get("owner") or "unassigned"
        by_owner.setdefault(owner, []).append(s)

    blocks = []
    for owner in sorted(by_owner):
        owner_scores = by_owner[owner]
        lines = [f"*Phase 1 cross-MVP update — {owner}*", ""]
        needed_prompts: set = set()
        for s in owner_scores:
            verdict = s["headline_verdict"]
            name = s.get("name") or "(unknown)"
            metrics = s["metrics"]
            action = action_line(
                verdict,
                name,
                metrics["signups"],
                s["visitors_needed"],
                visitors_floor,
            )
            # Visitor display: prefer ga_clicks when GA was the denominator.
            ga_clicks = metrics.get("ga_clicks", 0) or 0
            gclid_visitors = metrics.get("gclid_visitors", 0)
            if metrics.get("denominator_source") == "ga":
                line_metrics = (
                    f"({ga_clicks} GA-clicks / {gclid_visitors} PH-visit / "
                    f"{metrics['signups']} signups)"
                )
            else:
                line_metrics = f"({gclid_visitors} visitors / {metrics['signups']} signups)"
            # Partial-tracking suffix when state-x0 merged an orphan into this canonical.
            pt = s.get("partial_tracking_pct")
            pt_suffix = ""
            if isinstance(pt, (int, float)) and pt > 0:
                pt_suffix = f" ⚠ {round(pt * 100)}% pages w/o project_name"
            # Capture-rate warning: GA tracked many more clicks than PostHog visitors.
            cap = metrics.get("capture_rate")
            cap_suffix = ""
            if isinstance(cap, (int, float)) and cap < 0.5 and ga_clicks > 0:
                cap_suffix = f" ⚠ PH capturing only {round(cap * 100)}% of paid clicks"
            # PH-overcount: gclid_visitors > 1.10 * ga_clicks (distinct_id churn / multi-device).
            overcount_suffix = ""
            if ga_clicks > 0 and gclid_visitors > ga_clicks * 1.10:
                overcount_suffix = (
                    f" ⚠ PH-overcount {round(gclid_visitors / ga_clicks * 100)}% "
                    "(likely distinct_id churn)"
                )
            lines.append(
                f"• {name}{pt_suffix}{cap_suffix}{overcount_suffix} "
                f"{line_metrics} → {verdict}"
            )
            lines.append(f"  Action: {action}")
            # Verdicts that need an inline debug prompt for the operator to copy/paste:
            # NO_DATA and GA_NO_PH_TRACKING both require investigation in the MVP repo.
            if verdict in (VERDICT_NO_DATA, VERDICT_GA_NO_PH_TRACKING):
                needed_prompts.add(verdict)
        lines.append("")
        lines.append("Universal rule:")
        lines.append(f"• <{visitors_floor} visitors → keep running")
        lines.append(f"• ≥{visitors_floor} visitors with 0 signups → stop")
        lines.append(f"• ≥3 signups → promote to Phase 2")

        for prompt_name in sorted(needed_prompts):
            body = debug_prompts.get(prompt_name)
            if body:
                lines.append("")
                lines.append(f"--- {prompt_name} debug prompt ---")
                lines.append(body)

        block = "\n".join(lines)
        if len(block) > 4000:
            block = block[:3990] + "\n... (truncated)"
        blocks.append(block)

    return "\n\n---\n\n".join(blocks)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compute headline verdicts and/or emit Telegram artifact for /iterate --cross.",
    )
    parser.add_argument("--data", default=".runs/iterate-cross-data.json", help="Input: data + signups from x2")
    parser.add_argument("--issues", default=".runs/iterate-cross-data-issues.json", help="Input: integrity flags from x1a")
    parser.add_argument(
        "--scores",
        default=None,
        help="Optional input: pre-computed scores file. If provided, skip recomputation (used by x4 to avoid clobbering x3 output).",
    )
    parser.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    parser.add_argument(
        "--output",
        default=None,
        help="Output: write computed scores here. If omitted (and --scores not provided), scores stay in-memory only.",
    )
    parser.add_argument("--debug-prompts", default=".claude/patterns/iterate-cross-debug-prompts.md")
    parser.add_argument("--emit-telegram", default=None, help="Output: write Telegram-ready text here.")
    args = parser.parse_args(argv)

    if not args.output and not args.emit_telegram:
        print("ERROR: must specify at least one of --output or --emit-telegram.", file=sys.stderr)
        return 2

    config = load_config(args.config)
    thresholds = config["thresholds"]
    window_days = config.get("window_days", 90)

    if args.scores and os.path.exists(args.scores):
        score_data = json.load(open(args.scores))
        scores = score_data.get("mvps", [])
    else:
        data = json.load(open(args.data))
        issues_data = json.load(open(args.issues))
        issues_by_name = {m["name"]: m for m in issues_data.get("mvps", [])}

        scores = []
        for mvp in data.get("mvps", []):
            issues = issues_by_name.get(mvp["name"], {})
            scores.append(compute_headline_verdict(mvp, issues, thresholds))

    output = {"thresholds": thresholds, "window_days": window_days, "mvps": scores}

    if args.output:
        json.dump(output, open(args.output, "w"), indent=2)
        print(f"Wrote {args.output} ({len(scores)} MVPs)")

    if args.emit_telegram:
        debug_prompts = {}
        if args.debug_prompts and os.path.exists(args.debug_prompts):
            debug_prompts = parse_debug_prompts(open(args.debug_prompts).read())
        text = emit_telegram(scores, debug_prompts, thresholds["visitors_floor"])
        with open(args.emit_telegram, "w") as f:
            f.write(text)
        print(f"Wrote {args.emit_telegram}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""iterate_cross_verdicts.py — Pure-Python verdict computation for /iterate --cross.

Reads:
  - .runs/iterate-cross-data.json     (gathered by state-x1)
  - .runs/iterate-cross-data-issues.json (computed by state-x1a)
  - experiment/iterate-cross-config.yaml  (operator config; falls back to defaults)

Writes:
  - .runs/iterate-cross-scores.json   (consumed by state-x4)
  - .runs/iterate-cross-telegram.txt  (optional; --emit-telegram)

Verdict precedence (first match wins):
  1. STANDARD_VIOLATION  (issues.bid_strategy_violation)
  2. TRACKING_BROKEN     (issues.tracking_broken)
  3. NOT_DEPLOYED        (issues.not_deployed)
  4. GO                  (signups >= signups_go)
  5. NO_GO               (clicks >= clicks_floor AND signups < signups_go)
  6. INSUFFICIENT_DATA   (default)
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
    ],
    "conversion_action_whitelist": [
        "Sign-up",
        "Sign-ups",
        "MVP Signup",
        "Submit lead form",
        "Account creation",
        "Lead form",
    ],
    "mvp_mappings": {},
    "thresholds": {
        "signups_go": 3,
        "clicks_floor": 50,
        "click_window_days": 7,
    },
}

VERDICT_GO = "GO"
VERDICT_NO_GO = "NO_GO"
VERDICT_INSUFFICIENT = "INSUFFICIENT_DATA"
VERDICT_STD_VIOL = "STANDARD_VIOLATION"
VERDICT_TRACKING = "TRACKING_BROKEN"
VERDICT_NOT_DEPLOYED = "NOT_DEPLOYED"

VERDICT_ENUM = {
    VERDICT_GO,
    VERDICT_NO_GO,
    VERDICT_INSUFFICIENT,
    VERDICT_STD_VIOL,
    VERDICT_TRACKING,
    VERDICT_NOT_DEPLOYED,
}


def load_config(path: str | None) -> dict:
    """Load YAML config; deep-merge with defaults so partial configs work."""
    config = {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v) for k, v in DEFAULT_CONFIG.items()}
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
    return config


def compute_headline_verdict(mvp: dict, issues: dict, thresholds: dict) -> dict:
    """Apply precedence rules and return the score record for one MVP."""
    soft_warnings = []
    if issues.get("subaccount_conversion_misconfigured"):
        soft_warnings.append("subaccount_conversion_misconfigured")
    if issues.get("bid_strategy_unknown"):
        soft_warnings.append("bid_strategy_unknown")
    if issues.get("subaccount_conversion_unknown"):
        soft_warnings.append("subaccount_conversion_unknown")

    if issues.get("bid_strategy_violation"):
        verdict = VERDICT_STD_VIOL
    elif issues.get("tracking_broken"):
        verdict = VERDICT_TRACKING
    elif issues.get("not_deployed"):
        verdict = VERDICT_NOT_DEPLOYED
    else:
        signups = (mvp.get("tracking") or {}).get("signups", 0)
        clicks = (mvp.get("google_ads") or {}).get("clicks", 0)
        if signups >= thresholds["signups_go"]:
            verdict = VERDICT_GO
        elif clicks >= thresholds["clicks_floor"]:
            verdict = VERDICT_NO_GO
        else:
            verdict = VERDICT_INSUFFICIENT

    clicks = (mvp.get("google_ads") or {}).get("clicks", 0)
    signups = (mvp.get("tracking") or {}).get("signups", 0)
    spend = (mvp.get("google_ads") or {}).get("spend", 0)
    ctr = (mvp.get("google_ads") or {}).get("ctr", 0)

    clicks_needed = (
        max(0, thresholds["clicks_floor"] - clicks)
        if verdict == VERDICT_INSUFFICIENT
        else 0
    )

    return {
        "name": mvp.get("name"),
        "owner": mvp.get("owner"),
        "campaign_name": mvp.get("campaign_name"),
        "headline_verdict": verdict,
        "clicks_needed": clicks_needed,
        "soft_warnings": soft_warnings,
        "metrics": {
            "clicks": clicks,
            "signups": signups,
            "ctr": ctr,
            "spend": spend,
            "cpa": (spend / signups) if signups > 0 else None,
            "conv_rate": (signups / clicks) if clicks > 0 else 0.0,
        },
        "legacy_traction_score": None,
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
    VERDICT_GO: "Promote {campaign} to Phase 2 (run /iterate default mode for the deeper analysis).",
    VERDICT_NO_GO: "Stop {campaign}; document hypothesis rejection in retro.",
    VERDICT_INSUFFICIENT: "Keep running {campaign} until {clicks_needed} more clicks (target: 50+).",
    VERDICT_STD_VIOL: "Switch {campaign} bid strategy to Manual CPC and reset budget; re-launch under Phase 1 standard.",
    VERDICT_TRACKING: "Debug PostHog gclid capture for {campaign}. Run Claude Code in the MVP repo with the TRACKING_BROKEN prompt below.",
    VERDICT_NOT_DEPLOYED: "Confirm {campaign} deploy URL is live and PostHog snippet loads. Run Claude Code with the NOT_DEPLOYED prompt below.",
}


def action_line(verdict: str, campaign: str, clicks_needed: int) -> str:
    template = ACTION_TEMPLATES.get(verdict, "Unknown verdict.")
    return template.format(campaign=campaign, clicks_needed=clicks_needed)


def emit_telegram(scores: list, debug_prompts: dict) -> str:
    """Group by owner; one block per owner; each block ≤ 4000 chars."""
    by_owner: dict = {}
    for s in scores:
        owner = s.get("owner") or "unknown"
        by_owner.setdefault(owner, []).append(s)

    blocks = []
    for owner in sorted(by_owner):
        owner_scores = by_owner[owner]
        lines = [f"*Phase 1 Manual CPC update — {owner}*", ""]
        # Append debug prompts only when needed (avoid bloating every block).
        needed_prompts: set = set()
        for s in owner_scores:
            verdict = s["headline_verdict"]
            campaign = s.get("campaign_name") or s.get("name") or "(unknown)"
            metrics = s["metrics"]
            action = action_line(verdict, campaign, s["clicks_needed"])
            line_metrics = f"({metrics['clicks']} clicks / {metrics['signups']} signups)"
            lines.append(f"• {campaign} {line_metrics} → {verdict}")
            lines.append(f"  Action: {action}")
            if verdict in (VERDICT_TRACKING, VERDICT_NOT_DEPLOYED):
                needed_prompts.add(verdict)
        lines.append("")
        lines.append("Universal rule (all owners):")
        lines.append("• <50 clicks → keep the campaign running")
        lines.append("• ≥50 clicks → can stop (no need to spend full $140)")

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


def compute_legacy_traction_score(mvp: dict) -> float | None:
    """Phase 1 weighted Traction Score (deprecated; gated behind --legacy-score).

    Formula (from the pre-3/50 version of state-x3-compute-scores.md):
      conversion_signal = min(demand_users * 25, 100)
      ctr_signal        = min((ctr / industry_avg_ctr) * 50, 100)
      cost_signal       = max(100 - (spend / max(demand_users, 1) / 50 * 100), 0)
      qs_signal         = quality_score * 10
      score = 0.45*conv + 0.25*ctr + 0.20*cost + 0.10*qs       (when QS > 0)
            = 0.50*conv + 0.30*ctr + 0.20*cost                  (QS fallback)

    Returns None if input data is too sparse to compute meaningfully.
    """
    posthog = mvp.get("posthog") or {}
    google_ads = mvp.get("google_ads") or {}

    demand_users = posthog.get("demand", 0)
    ctr = google_ads.get("ctr", 0) or 0
    spend = google_ads.get("spend", 0) or 0
    quality_score = google_ads.get("quality_score", 0) or 0

    industry_avg_ctr = 0.025

    conversion_signal = min(demand_users * 25, 100)
    ctr_signal = min((ctr / industry_avg_ctr) * 50, 100) if industry_avg_ctr > 0 else 0
    cost_signal = max(100 - (spend / max(demand_users, 1) / 50 * 100), 0)
    qs_signal = quality_score * 10

    if quality_score > 0:
        score = (
            conversion_signal * 0.45
            + ctr_signal * 0.25
            + cost_signal * 0.20
            + qs_signal * 0.10
        )
    else:
        score = (
            conversion_signal * 0.50
            + ctr_signal * 0.30
            + cost_signal * 0.20
        )

    return round(score, 2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compute headline verdicts and/or emit Telegram artifact for /iterate --cross.",
    )
    parser.add_argument("--data", default=".runs/iterate-cross-data.json", help="Input: gathered data from x1")
    parser.add_argument("--issues", default=".runs/iterate-cross-data-issues.json", help="Input: issue flags from x1a")
    parser.add_argument(
        "--scores",
        default=None,
        help="Optional input: pre-computed scores file. If provided, skip recomputation from --data/--issues (used by x4 to avoid clobbering x3's output).",
    )
    parser.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    parser.add_argument(
        "--output",
        default=None,
        help="Output: write computed scores here. If omitted (and --scores not provided), scores stay in-memory only.",
    )
    parser.add_argument("--debug-prompts", default=".claude/patterns/iterate-cross-debug-prompts.md")
    parser.add_argument("--emit-telegram", default=None, help="Output: write Telegram-ready text here.")
    parser.add_argument(
        "--legacy-score",
        action="store_true",
        help="Also compute the deprecated Phase 1 Traction Score per MVP and attach as legacy_traction_score.",
    )
    args = parser.parse_args(argv)

    if not args.output and not args.emit_telegram:
        print("ERROR: must specify at least one of --output or --emit-telegram.", file=sys.stderr)
        return 2

    config = load_config(args.config)
    thresholds = config["thresholds"]

    if args.scores and os.path.exists(args.scores):
        score_data = json.load(open(args.scores))
        scores = score_data.get("mvps", [])
    else:
        data = json.load(open(args.data))
        issues_data = json.load(open(args.issues))
        issues_by_name = {m["name"]: m for m in issues_data.get("mvps", [])}

        # Build a quick lookup from name → mvp for legacy_score (needs full mvp record)
        mvp_by_name = {m["name"]: m for m in data.get("mvps", [])}

        scores = []
        for mvp in data.get("mvps", []):
            issues = issues_by_name.get(mvp["name"], {})
            score = compute_headline_verdict(mvp, issues, thresholds)
            if args.legacy_score:
                score["legacy_traction_score"] = compute_legacy_traction_score(mvp)
            scores.append(score)

    output = {"thresholds": thresholds, "mvps": scores}

    if args.output:
        json.dump(output, open(args.output, "w"), indent=2)
        print(f"Wrote {args.output} ({len(scores)} MVPs)")

    if args.emit_telegram:
        debug_prompts = {}
        if args.debug_prompts and os.path.exists(args.debug_prompts):
            debug_prompts = parse_debug_prompts(open(args.debug_prompts).read())
        text = emit_telegram(scores, debug_prompts)
        with open(args.emit_telegram, "w") as f:
            f.write(text)
        print(f"Wrote {args.emit_telegram}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

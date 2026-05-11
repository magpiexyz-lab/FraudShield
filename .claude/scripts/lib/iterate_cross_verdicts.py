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
  1. NO_DATA            (issues.no_event_data)
  2. GO                 (signups >= signups_go)
  3. NO_GO              (gclid_visitors >= visitors_floor AND signups == 0)
  4. WEAK               (gclid_visitors >= visitors_floor AND 0 < signups < signups_go)
  5. INSUFFICIENT_DATA  (default; visitors_needed = visitors_floor - gclid_visitors)
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

VERDICT_ENUM = {
    VERDICT_GO,
    VERDICT_WEAK,
    VERDICT_NO_GO,
    VERDICT_INSUFFICIENT,
    VERDICT_NO_DATA,
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
    """Apply precedence rules and return the score record for one MVP."""
    visitors = mvp.get("gclid_visitors", 0)
    signups = mvp.get("signups", 0)
    signup_events = mvp.get("signup_events") or []

    if issues.get("no_event_data"):
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

    conv_rate = (signups / visitors) if visitors > 0 else 0.0

    return {
        "name": mvp.get("name"),
        "owner": mvp.get("owner"),
        "headline_verdict": verdict,
        "visitors_needed": visitors_needed,
        "metrics": {
            "gclid_visitors": visitors,
            "signups": signups,
            "conv_rate": round(conv_rate, 4),
        },
        "signup_events": signup_events,
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
            line_metrics = f"({metrics['gclid_visitors']} visitors / {metrics['signups']} signups)"
            lines.append(f"• {name} {line_metrics} → {verdict}")
            lines.append(f"  Action: {action}")
            if verdict == VERDICT_NO_DATA:
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

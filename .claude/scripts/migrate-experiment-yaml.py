#!/usr/bin/env python3
"""Suggest behavior.pages backfill for existing experiments. Web-app only.

Wired into /upgrade state-1-merge-validate.md as sub-step 1c. Runs
post-template-sync. Suggests pages: [...] entries for behaviors that
lack them; never auto-applies (user reviews via Plan).

Heuristics (web-app + actor:user only):
  1. Read experiment/experiment.yaml
  2. If type != web-app, exit migration_status=not-applicable
  3. Discover existing pages on disk (src/app/<name>/page.tsx)
  4. For each behavior without pages:
     - Skip if actor in (system, cron) — no UI surface
     - Scan given/when/then text for page-name candidates
     - Constrain candidates to pages that exist on disk (avoid spurious
       generic-noun matches like "page", "view", "dashboard" when no
       such directory exists)
     - Tag REQUIRES_USER_REVIEW; never auto-apply

Output: .runs/upgrade-migration-applied.json (audit log)
        Also prints JSON summary to stdout for /upgrade Plan rendering.
"""
import datetime
import glob
import json
import os
import re
import sys


def _write_result(d: dict) -> None:
    os.makedirs(".runs", exist_ok=True)
    with open(".runs/upgrade-migration-applied.json", "w") as f:
        json.dump(d, f, indent=2)
    print(json.dumps(d, indent=2))


def main() -> None:
    if not os.path.isfile("experiment/experiment.yaml"):
        _write_result({
            "migration_status": "no-experiment",
            "suggestions": [],
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        })
        return

    try:
        import yaml
    except ImportError:
        _write_result({
            "migration_status": "error",
            "error_reason": "PyYAML not installed (pip install pyyaml)",
            "suggestions": [],
        })
        sys.exit(2)

    data = yaml.safe_load(open("experiment/experiment.yaml"))
    archetype = (data.get("type") or "web-app").lower()

    if archetype != "web-app":
        _write_result({
            "migration_status": "not-applicable",
            "archetype": archetype,
            "rationale": f"behavior.pages field only applies to web-app archetype (this is {archetype})",
            "suggestions": [],
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        })
        return

    # Discover pages on disk — constrain heuristic to real candidates.
    existing_pages = set()
    for d in glob.glob("src/app/*/page.tsx"):
        page_name = d.split("/")[-2]
        if page_name and page_name != "":
            existing_pages.add(page_name)

    suggestions = []
    behaviors = data.get("behaviors") or []
    for b in behaviors:
        if not isinstance(b, dict):
            continue
        if b.get("pages"):
            continue  # Already migrated
        actor = b.get("actor", "user")
        if actor in ("system", "cron"):
            continue  # No UI surface

        # Heuristic: scan text for page-name references that exist on disk
        text_parts = [
            str(b.get("given") or ""),
            str(b.get("when") or ""),
            str(b.get("then") or ""),
        ]
        text = " ".join(text_parts).lower()

        candidates = []
        for page in sorted(existing_pages):
            # Match page name as a whole word (avoid "dash" matching "dashboard")
            if re.search(rf"\b{re.escape(page.lower())}\b", text):
                candidates.append(page)

        if candidates:
            rationale = f"text mentions: {', '.join(candidates)}"
        else:
            rationale = "no automatic match — user must declare pages manually"

        suggestions.append({
            "behavior_id": b.get("id"),
            "current_pages": None,
            "suggested_pages": candidates,
            "requires_user_review": True,
            "rationale": rationale,
        })

    if not suggestions:
        _write_result({
            "migration_status": "clean",
            "archetype": archetype,
            "rationale": "all user-actor behaviors already have pages: field",
            "suggestions": [],
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        })
        return

    _write_result({
        "migration_status": "suggestions-pending",
        "archetype": archetype,
        "behaviors_to_migrate": len(suggestions),
        "suggestions": suggestions,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "instructions": (
            "Review each suggestion. For each behavior, either accept the "
            "suggested pages list, edit it, or reject (the behavior may need "
            "actor: system/cron instead). Apply approved changes to "
            "experiment/experiment.yaml. /upgrade will re-run validation after."
        ),
    })


if __name__ == "__main__":
    main()

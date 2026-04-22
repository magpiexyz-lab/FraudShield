#!/usr/bin/env python3
"""Canonical page-inventory derivation for experiment.yaml.

Single source of truth for "what pages must exist on disk" (SET semantics)
and "what is the user journey" (LIST semantics). All count-based and
inventory-based consumers MUST call these functions; raw access to
`golden_path` for these purposes is forbidden by `verify-linter.sh`
field_role_map rule.

See .claude/templates/experiment-yaml.md for the full schema.
"""
import json
import sys
from typing import Any


# Pages that scaffold-pages does NOT own (other agents handle them).
_EXCLUDED_FROM_SCOPE = {None, "", "landing"}


def derive_scope_pages(experiment: dict[str, Any]) -> list[str]:
    """Return the sorted set of pages that must exist on disk for web-app archetype.

    Set semantics: order does not matter. Use this for inventory counts,
    spawn lists, sitemap entries, and existence checks.

    Sources, in union:
      1. golden_path[*].page  (where present)
      2. behaviors[*].pages   (where present — required for web-app + actor:user)
      3. auth-derived         (login, signup if stack.auth is set)

    Excluded: None, empty string, and "landing" (scaffold-landing owns it).
    """
    pages: set[str] = set()

    for step in (experiment.get("golden_path") or []):
        if isinstance(step, dict):
            page = step.get("page")
            if page:
                pages.add(page)

    for behavior in (experiment.get("behaviors") or []):
        if not isinstance(behavior, dict):
            continue
        for page in (behavior.get("pages") or []):
            if page:
                pages.add(page)

    stack = experiment.get("stack") or {}
    if stack.get("auth"):
        pages.add("login")
        pages.add("signup")

    return sorted(p for p in pages if p not in _EXCLUDED_FROM_SCOPE)


def derive_funnel_steps(experiment: dict[str, Any]) -> list[dict]:
    """Return the ordered list of golden_path steps for sequence-based consumers.

    List semantics: order matters. Use this for nav-bar generation,
    funnel test sequences, sitemap ordering, and journey walkthroughs.

    Returns the raw list (each entry is a dict with `step`, `event`, `page`).
    Callers iterate in order; do not call set() or len() on this for inventory
    purposes — use derive_scope_pages() instead.
    """
    return list(experiment.get("golden_path") or [])


def _load_experiment() -> dict:
    """Load experiment.yaml from disk or stdin."""
    try:
        import yaml
    except ImportError:
        sys.stderr.write("ERROR: PyYAML not installed (pip install pyyaml)\n")
        sys.exit(2)

    if not sys.stdin.isatty():
        return yaml.safe_load(sys.stdin)
    try:
        return yaml.safe_load(open("experiment/experiment.yaml"))
    except FileNotFoundError:
        sys.stderr.write("ERROR: experiment/experiment.yaml not found and no stdin input\n")
        sys.exit(2)


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("scope", "funnel"):
        sys.stderr.write("usage: derive_pages.py {scope|funnel} [< experiment.yaml]\n")
        sys.exit(2)

    experiment = _load_experiment()
    if sys.argv[1] == "scope":
        result = derive_scope_pages(experiment)
    else:
        result = derive_funnel_steps(experiment)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

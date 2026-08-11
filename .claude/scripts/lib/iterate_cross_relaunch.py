#!/usr/bin/env python3
"""Per-MVP relaunch windows for /iterate --cross (Phase 1 and Phase 2).

When an MVP's flight fails (broken build, mid-run price change, NO_GO on a
polluted window) but the team fixes the product and wants to re-test, a
straight re-run would pool the new paid clicks with the old failed ones — the
stale denominator drags the rate forever. A relaunch date marks a cut:
evaluation then ignores everything before it and judges only the
relaunch-onward window.

Operator sets it per MVP in experiment/iterate-cross-config.yaml:

    mvp_mappings:
      mooncub:
        phase1_relaunch_at: "2026-07-25"   # ISO date (YYYY-MM-DD)
      neuralpost:
        phase2_relaunch_at: "2026-08-01"   # Phase 2 sibling (v{N+1} start date)

Semantics: the effective lower time bound for that MVP becomes
`max(now() - window_days, relaunch_at)`. Phase-1 consumers:
  - GA merge (iterate_cross_ga): a campaign counts toward ga_clicks/ga_cost only
    when its Start date is on/after the relaunch date. Relaunch REQUIRES a new
    campaign name (e.g. mooncub-search-v2) so the old flight's Start date sorts
    before the cut — documented in state-x0a.
  - PostHog signup count (state-x2): the per-MVP subquery lower bound is raised
    to the relaunch instant. (The state-x1 catalog is NOT re-scoped — it only
    selects which event names count, not how many.)
  - DB ground truth (state-x0b, iterate_cross_db): the windowed signup/auth
    queries raise their lower bound to the relaunch instant.

Phase-2 consumers of `phase2_relaunch_at` (state-x5): the phase-filtered GA
merge drops pre-relaunch campaigns (the phase-1 map never applies there — the
two keys are separate axes); the discovery / pay-intent / price-timeline
PostHog queries append `posthog_per_mvp_relaunch_clause`; the DB pay_intent
and gclid-no-utm fetchers raise their created_at lower bound. The wiring
liveness probes (PH last-pay_intent-ever, DB max(created_at)) are deliberately
NOT cut — proving the wiring is precisely about any-time evidence.

`gclid_visitors` from state-x0 discovery is deliberately NOT re-scoped (it is a
diagnostic + fallback denominator, computed by a single GROUP BY across all
MVPs); the verdict denominator uses the relaunch-scoped GA clicks. state-x4
renders a "relaunch <date>" marker and notes the raw PostHog visitor count spans
the pre-relaunch flight too.

This module is pure (no I/O) so it is unit-testable and shared by every site;
never inline the date math at a call site.
"""

from __future__ import annotations

import re
from datetime import date

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_relaunch_at(value: object) -> str | None:
    """Validate and normalize a `phase1_relaunch_at` config value.

    Accepts an ISO ``YYYY-MM-DD`` string (optionally with a trailing time that we
    drop to the date). Returns the normalized ``YYYY-MM-DD`` string, or None when
    the value is absent/empty. Raises ValueError on a malformed non-empty value
    so a typo surfaces loudly instead of silently disabling the window.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Tolerate a full ISO timestamp by taking the date part.
    s = s.split("T")[0].split(" ")[0]
    if not _ISO_DATE.match(s):
        raise ValueError(
            f"phase1_relaunch_at must be an ISO date (YYYY-MM-DD), got {value!r}"
        )
    try:
        date.fromisoformat(s)
    except ValueError as exc:
        raise ValueError(f"phase1_relaunch_at is not a real date: {value!r}") from exc
    return s


def relaunch_at_for(mvp_name: str, mvp_mappings: dict | None) -> str | None:
    """Read + validate the relaunch date for one MVP from mvp_mappings."""
    mapping = (mvp_mappings or {}).get(mvp_name) or {}
    if not isinstance(mapping, dict):
        return None
    return parse_relaunch_at(mapping.get("phase1_relaunch_at"))


def posthog_lower_bound_expr(window_days: int, relaunch_at: str | None) -> str:
    """HogQL time lower-bound expression for a per-MVP subquery.

    Without a relaunch date: ``now() - INTERVAL <window_days> DAY`` (unchanged
    behavior). With one: ``greatest(now() - INTERVAL <window_days> DAY,
    toDateTime('<relaunch_at> 00:00:00'))`` so the window never widens past the
    global window, only narrows to the relaunch onward.
    """
    base = f"now() - INTERVAL {int(window_days)} DAY"
    rel = parse_relaunch_at(relaunch_at)
    if rel is None:
        return base
    return f"greatest({base}, toDateTime('{rel} 00:00:00'))"


def postgres_lower_bound_expr(
    column: str, window_days: int, relaunch_at: str | None, alias: str = ""
) -> str:
    """Postgres WHERE lower-bound fragment for the windowed DB queries.

    Returns a boolean fragment (no leading AND) comparing `column` to the
    greater of the rolling window and the relaunch instant. `column` and
    `alias` must be trusted identifiers from the caller (table's timestamp
    column / query alias), not user input — quoted but not otherwise
    sanitized. Pass `alias` whenever the query joins another table that also
    has the column (e.g. pay_intent LEFT JOIN auth.users — both carry
    created_at, so the unqualified form is ambiguous and errors out).
    """
    qualified = f'{alias}."{column}"' if alias else f'"{column}"'
    base = f"{qualified} >= now() - INTERVAL '{int(window_days)} days'"
    rel = parse_relaunch_at(relaunch_at)
    if rel is None:
        return base
    return (
        f"{qualified} >= greatest("
        f"now() - INTERVAL '{int(window_days)} days', "
        f"timestamptz '{rel}')"
    )


def posthog_per_mvp_relaunch_clause(
    relaunch_map: dict[str, str] | None,
) -> tuple[str, dict[str, str]]:
    """Build a HogQL fragment excluding each relaunched MVP's pre-cut events.

    Returns ``(clause, values)`` where `clause` is either ``""`` (empty map) or
    a chain of ``AND NOT (properties.project_name = {rel_name_i} AND timestamp
    < toDateTime('<date> 00:00:00'))`` — one per relaunched MVP — and `values`
    holds the generated ``rel_name_i`` placeholder bindings. MVP names travel
    as placeholders (HogQL binds them server-side); dates are validated through
    parse_relaunch_at and inlined, same as posthog_lower_bound_expr.

    Non-relaunched MVPs are untouched: the NOT-clause only matches rows whose
    project_name equals a relaunched name. Append the clause BEFORE the query's
    trailing LIMIT, and never alongside `{limit}`/`{offset}` placeholders (the
    pagination shim would str.format the whole template).
    """
    if not relaunch_map:
        return "", {}
    parts: list[str] = []
    values: dict[str, str] = {}
    for i, (name, raw) in enumerate(sorted(relaunch_map.items())):
        rel = parse_relaunch_at(raw)
        if rel is None:
            continue
        key = f"rel_name_{i}"
        values[key] = name
        parts.append(
            f"AND NOT (properties.project_name = {{{key}}} "
            f"AND timestamp < toDateTime('{rel} 00:00:00')) "
        )
    return "".join(parts), values


def campaign_passes_relaunch(start_date: object, relaunch_at: str | None) -> bool:
    """True when a GA campaign's Start date qualifies under the relaunch cut.

    No relaunch date → always True (every campaign counts). With one, the
    campaign counts only if its Start date is a valid ISO date on/after the
    relaunch date. A missing/blank/malformed Start date under an ACTIVE relaunch
    is treated as NOT passing (conservative: an unattributable-age campaign must
    not silently re-pollute a relaunch denominator; the operator uses a fresh
    v2 campaign whose Start date is present and post-cut).
    """
    rel = parse_relaunch_at(relaunch_at)
    if rel is None:
        return True
    s = str(start_date or "").strip()
    if not _ISO_DATE.match(s):
        return False
    return s >= rel

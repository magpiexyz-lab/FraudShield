"""RMG v2 — Recurrence guard parser.

Single source of truth for the typed `recurrence_guard` field that lives in
`.runs/solve-trace.json[].prevention_analysis.recurrence_guard` and feeds the
Phase E artifact-existence gate at lifecycle-finalize.sh Step 4.6.

Two input shapes:
  * Full mode   — dict written by Phase 4 of solve-reasoning
  * Light mode  — single bullet string (or list of bullet strings) written by
                  the inline light-mode template

Tolerant mode is **off by default** post-cutover. Setting
`RMG_V2_TOLERANT=1` re-enables the legacy free-text escape hatch and
returns `{kind: "legacy_freetext"}` instead of raising. The escape
hatch is preserved for emergencies — e.g., an unforeseen agent prompt
regression that re-emits prose. Default off because no in-tree code
path writes legacy free-text after Phase A (all four writers emit
typed dicts or `None`), so soak protection has no real surface area
(see RMG v2 first-principles cutover analysis).

Public surface:
    parse(value)               -> dict canonical guard
    RecurrenceGuardParseError  -> raised when input is invalid (and tolerant=False)

The canonical guard shape is::

    {
      "kind": "test" | "lint" | "hook" | "invariant" | "none",
      "artifact": "<path-or-rule-id>" | None,
      "rationale": "<≤200ch>",
      "unguardability_rationale": "<≥80ch>"   # only when kind == "none"
    }
"""

from __future__ import annotations

import os
import re
from typing import Any

KIND_VALUES = ("test", "lint", "hook", "invariant", "none")
LEGACY_KIND = "legacy_freetext"
RATIONALE_MAX = 200
UNGUARDABILITY_MIN = 80

_LIGHT_BULLET_RE = re.compile(
    r"^\s*-\s*kind=([a-z]+)\s*\|\s*artifact=([^|]+?)\s*\|\s*rationale=([^|]{1,%d})\s*$"
    % RATIONALE_MAX
)
_UNGUARDABILITY_HINT_A = re.compile(r"\b(no|cannot|cant|can\s*not)\b", re.IGNORECASE)
_UNGUARDABILITY_HINT_B = re.compile(r"\b(review|observ|monitor|audit)", re.IGNORECASE)


class RecurrenceGuardParseError(ValueError):
    """Raised when a recurrence_guard value cannot be parsed under strict mode."""

    def __init__(self, message: str, raw_value: Any) -> None:
        super().__init__(message)
        self.raw_value = raw_value


def _tolerant_enabled() -> bool:
    # Default off post-cutover. Set RMG_V2_TOLERANT=1 to re-enable the
    # legacy free-text escape hatch in an emergency.
    return os.environ.get("RMG_V2_TOLERANT", "0") in ("1", "true", "True")


def _validate_kind(kind: str, raw: Any) -> str:
    if kind not in KIND_VALUES:
        raise RecurrenceGuardParseError(
            f"unknown kind={kind!r}; expected one of {KIND_VALUES}", raw
        )
    return kind


def _validate_rationale(rationale: str, raw: Any) -> str:
    if not isinstance(rationale, str) or not rationale.strip():
        raise RecurrenceGuardParseError("rationale empty", raw)
    if len(rationale) > RATIONALE_MAX:
        raise RecurrenceGuardParseError(
            f"rationale length {len(rationale)} exceeds {RATIONALE_MAX}", raw
        )
    return rationale


def _validate_unguardability(value: Any, raw: Any) -> str:
    if not isinstance(value, str) or len(value) < UNGUARDABILITY_MIN:
        raise RecurrenceGuardParseError(
            f"kind=none requires unguardability_rationale of at least "
            f"{UNGUARDABILITY_MIN} characters",
            raw,
        )
    if not _UNGUARDABILITY_HINT_A.search(value):
        raise RecurrenceGuardParseError(
            "unguardability_rationale must explain WHY no executable check "
            "expresses the invariant (use 'no'/'cannot'/'can not')",
            raw,
        )
    if not _UNGUARDABILITY_HINT_B.search(value):
        raise RecurrenceGuardParseError(
            "unguardability_rationale must name the human/observability process "
            "that catches the next instance (mention review/observ/monitor/audit)",
            raw,
        )
    return value


def _parse_dict(value: dict) -> dict:
    kind = _validate_kind(str(value.get("kind", "")).strip(), value)
    artifact = value.get("artifact")
    if artifact is not None and not isinstance(artifact, str):
        raise RecurrenceGuardParseError("artifact must be string or null", value)
    rationale = _validate_rationale(str(value.get("rationale", "")).strip(), value)
    canonical = {
        "kind": kind,
        "artifact": artifact if (artifact and artifact.strip()) else None,
        "rationale": rationale,
    }
    if kind == "none":
        canonical["unguardability_rationale"] = _validate_unguardability(
            value.get("unguardability_rationale"), value
        )
    return canonical


def _parse_bullet(text: str) -> dict:
    match = _LIGHT_BULLET_RE.match(text)
    if not match:
        raise RecurrenceGuardParseError(
            "light-mode bullet must match `- kind=<token> | artifact=<path|null> | "
            "rationale=<≤200ch>`",
            text,
        )
    kind = _validate_kind(match.group(1), text)
    artifact_raw = match.group(2).strip()
    artifact = None if artifact_raw.lower() in ("null", "none", "") else artifact_raw
    rationale = _validate_rationale(match.group(3).strip(), text)
    canonical = {"kind": kind, "artifact": artifact, "rationale": rationale}
    if kind == "none":
        # Light mode cannot embed unguardability_rationale on the same bullet;
        # callers MUST switch to dict shape when kind=none.
        raise RecurrenceGuardParseError(
            "kind=none requires the dict shape so unguardability_rationale can be set",
            text,
        )
    return canonical


def _parse_legacy(text: str, raw: Any) -> dict:
    if not _tolerant_enabled():
        raise RecurrenceGuardParseError(
            "legacy free-text recurrence_guard rejected (set RMG_V2_TOLERANT=1 to allow)",
            raw,
        )
    return {
        "kind": LEGACY_KIND,
        "artifact": None,
        "rationale": text.strip()[:RATIONALE_MAX],
    }


def parse(value: Any) -> dict:
    """Parse any supported recurrence_guard shape into the canonical dict."""
    if value is None:
        raise RecurrenceGuardParseError("recurrence_guard is null", value)

    if isinstance(value, dict):
        return _parse_dict(value)

    if isinstance(value, list):
        bullets = [item for item in value if isinstance(item, str) and item.strip()]
        if not bullets:
            raise RecurrenceGuardParseError("empty bullet list", value)
        if len(bullets) > 1:
            raise RecurrenceGuardParseError(
                "exactly one bullet expected in light-mode list", value
            )
        return _parse_bullet(bullets[0])

    if isinstance(value, str):
        text = value.strip()
        if text.startswith("- kind="):
            return _parse_bullet(text)
        return _parse_legacy(text, value)

    raise RecurrenceGuardParseError(
        f"unsupported recurrence_guard type {type(value).__name__}", value
    )

#!/usr/bin/env python3
"""Validate physical evidence for design-critic Step 5.5 candidate evaluation.

Issue context: #1272 — Step 5.5 has regressed 6 times despite schema-level
gates (#882, #898, #911, #881, #916, #1076, #1129). All prior gates were
bypassable because LLM agents satisfied the field shape (e.g.,
`candidates_tried: 8`) without performing the underlying physical action.

This validator enforces the converse — gate fires on SIDECAR state, not on
trace state (round-2 critic Concern 5: invert polarity so skipping the work
cannot satisfy the gate).

Triggering predicate:
    .runs/image-candidates.json exists AND any landing-owned slot has
    > 1 candidates AND any candidate has provenance.json sibling.

Required physical evidence per evaluated candidate:
  (1) Screenshot file at .runs/screenshots/candidates/<slot>-<candidate>.png
      exists AND has PNG/WebP magic bytes AND min dimensions 1280x720
  (2) Sibling <candidate>.provenance.json file with (model, prompt_hash, seed)
  (3) Provenance triple is UNIQUE across all evaluated candidates per slot
  (4) image-candidates.json sidecar shows score_in_context populated
      (not "?" or null) for each evaluated candidate
  (5) image-candidates.json shows evaluation_notes[] with text >= 50 chars
      per evaluated candidate (round-2 Concern 8: prevents sampling from
      becoming agent self-licensing skip)
  (6) Sampling rule: at minimum, min(N-1, 6) candidates per slot must have
      evidence files, where N = total candidates in slot

Sampling justification (round-2 Concern 8): the score-delta < 1 sampling
rule from the procedure is itself an LLM-written claim. By requiring a
floor of min(N-1, 6) evidence files PER SLOT, we make the sampling
budget structurally observable.

MODE controlled by STEP55_EVIDENCE_MODE env var (default warn during rollout).
Schema-version backwards compat: skips when the active run's required
schema version < 2 (pre-cutoff runs grandfathered).
"""

from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.phash import (  # type: ignore
    check_image_magic,
    check_image_min_dimensions,
    read_provenance,
    validate_provenance_triple_unique,
    DEFAULT_MIN_WIDTH,
    DEFAULT_MIN_HEIGHT,
)
from lib.schema_version_gate import required_schema_version  # type: ignore

SIDECAR = ".runs/image-candidates.json"
SCREENSHOT_DIR = ".runs/screenshots/candidates"
LANDING_OWNED_SLOTS_EXCLUDE = {"empty-state"}
EVALUATION_NOTES_MIN_LEN = 50


def _active_run_id() -> str:
    best = None
    best_ts = ""
    for f in glob.glob(".runs/*-context.json"):
        if "epilogue" in f:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("completed") is True:
            continue
        ts = d.get("timestamp") or ""
        if ts >= best_ts:
            best = d
            best_ts = ts
    return (best or {}).get("run_id", "")


def _mode() -> str:
    return os.environ.get("STEP55_EVIDENCE_MODE", "warn").lower()


def _is_landing_owned(slot_name: str) -> bool:
    return slot_name not in LANDING_OWNED_SLOTS_EXCLUDE


def _expected_evidence_path(slot: str, candidate_basename: str) -> str:
    """Compute expected evidence screenshot path."""
    safe_basename = candidate_basename.rsplit(".", 1)[0]
    return os.path.join(SCREENSHOT_DIR, f"{slot}-{safe_basename}.png")


def _validate_slot(slot_name: str, slot_data: dict) -> list[str]:
    candidates = slot_data.get("candidates") or []
    if not isinstance(candidates, list):
        return [f"slot {slot_name!r}: candidates is not a list"]
    if len(candidates) <= 1:
        return []  # nothing to compare

    if not _is_landing_owned(slot_name):
        return []  # empty-state etc. excluded

    errors: list[str] = []
    n = len(candidates)
    required_evidence_count = min(n - 1, 6)  # round-2 Concern 8 floor

    evidence_seen = 0
    provs: list[dict] = []
    for idx, cand in enumerate(candidates):
        if not isinstance(cand, dict):
            errors.append(f"slot {slot_name!r}: candidate[{idx}] is not a dict")
            continue
        cand_path = cand.get("path") or cand.get("filename")
        if not cand_path:
            errors.append(f"slot {slot_name!r}: candidate[{idx}] missing path/filename")
            continue
        cand_basename = os.path.basename(cand_path)

        # If candidate is the current winner (selected=True) and has no
        # comparison record, skip — the winner is exempt from being its own
        # comparison subject.
        is_winner = bool(cand.get("selected") or cand.get("is_winner"))

        score_in_context = cand.get("score_in_context")
        evaluation_notes = cand.get("evaluation_notes") or []

        # Evidence required when the candidate was actually evaluated
        # (score_in_context populated and non-trivial)
        if score_in_context and isinstance(score_in_context, dict):
            evidence_path = _expected_evidence_path(slot_name, cand_basename)
            magic = check_image_magic(evidence_path)
            if magic is None:
                errors.append(
                    f"slot {slot_name!r}: candidate[{idx}] {cand_basename!r} has "
                    f"score_in_context but missing/invalid evidence screenshot at {evidence_path}"
                )
                continue
            if not check_image_min_dimensions(evidence_path):
                errors.append(
                    f"slot {slot_name!r}: candidate[{idx}] evidence screenshot "
                    f"{evidence_path} below min dimensions ({DEFAULT_MIN_WIDTH}x{DEFAULT_MIN_HEIGHT})"
                )
                continue

            # evaluation_notes must be substantive
            if not evaluation_notes:
                errors.append(
                    f"slot {slot_name!r}: candidate[{idx}] missing evaluation_notes[]"
                )
            else:
                short_notes = [
                    n for n in evaluation_notes
                    if not isinstance(n, str) or len(n) < EVALUATION_NOTES_MIN_LEN
                ]
                if short_notes:
                    errors.append(
                        f"slot {slot_name!r}: candidate[{idx}] has {len(short_notes)} "
                        f"evaluation_notes entries shorter than {EVALUATION_NOTES_MIN_LEN} chars"
                    )

            # Provenance triple
            prov = cand.get("provenance")
            if not prov or not isinstance(prov, dict):
                # Try sibling JSON
                try:
                    prov = read_provenance(cand_path)
                except (FileNotFoundError, ValueError) as e:
                    errors.append(
                        f"slot {slot_name!r}: candidate[{idx}] missing provenance "
                        f"({e})"
                    )
                    continue
            provs.append(prov)
            evidence_seen += 1
        elif not is_winner:
            # Non-winner without score_in_context — only OK if total
            # evidence_seen will still meet the floor
            pass

    # Provenance uniqueness across evaluated candidates
    errors.extend([
        f"slot {slot_name!r}: {e}" for e in validate_provenance_triple_unique(provs)
    ])

    if evidence_seen < required_evidence_count:
        errors.append(
            f"slot {slot_name!r}: only {evidence_seen} candidates have evidence "
            f"screenshots (sampling floor min(N-1, 6) = {required_evidence_count}; "
            f"N={n}). Step 5.5 sampling rule cannot be satisfied without {required_evidence_count} "
            f"in-context evaluations."
        )

    return errors


def main() -> int:
    mode = _mode()
    rid = _active_run_id()

    required_v = required_schema_version(rid) if rid else 1
    if required_v < 2:
        print(
            f"validate-step55-evidence: SKIP (run_id={rid!r} pre-cutoff; "
            f"required schema_version={required_v})"
        )
        return 0

    if not os.path.isfile(SIDECAR):
        print(f"validate-step55-evidence: SKIP (no {SIDECAR})")
        return 0

    try:
        sidecar = json.load(open(SIDECAR))
    except Exception as e:
        msg = f"BLOCK: cannot parse {SIDECAR}: {e}"
        print(msg, file=sys.stderr)
        return 0 if mode == "warn" else 1

    sidecar_v = sidecar.get("schema_version", 1)
    if sidecar_v < 2:
        print(
            f"validate-step55-evidence: SKIP ({SIDECAR} schema_version={sidecar_v} "
            f"< 2; sidecar is pre-cutoff format)"
        )
        return 0

    # Locate slots: prefer top-level "slots" map, else flat list
    slots = sidecar.get("slots") or {}
    if not isinstance(slots, dict):
        print(f"validate-step55-evidence: SKIP ({SIDECAR} has no 'slots' map)")
        return 0

    all_errors: list[str] = []
    for slot_name, slot_data in slots.items():
        if not isinstance(slot_data, dict):
            continue
        all_errors.extend(_validate_slot(slot_name, slot_data))

    if not all_errors:
        print(
            f"validate-step55-evidence: OK ({len(slots)} slots checked)"
        )
        return 0

    print(
        f"validate-step55-evidence: FAIL ({len(all_errors)} errors)",
        file=sys.stderr,
    )
    for e in all_errors:
        print(f"  {e}", file=sys.stderr)

    if mode == "warn":
        print("\n[MODE=warn] not blocking", file=sys.stderr)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

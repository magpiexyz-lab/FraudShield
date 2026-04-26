#!/usr/bin/env python3
"""Bootstrap state-11a VERIFY for image-manifest.json (Issue #1077).

When slot-intent.json declares `design_slots_enabled: true`, the expected
image count is dynamic (= number of slots whose production_method ==
"ai_generated"). Otherwise, the legacy threshold of >=7 applies.

Closes Round 2 critic Concern 6 (state-11a hardcoded ic>=7 conflicts with
slot-intent skip-on-non-ai-generated semantics).

Exits 0 on success; non-zero with diagnostic on failure.
"""
import json
import os
import sys


def main() -> int:
    manifest_path = ".runs/image-manifest.json"
    if not os.path.exists(manifest_path):
        # No manifest → nothing to verify (skip-applicable)
        return 0

    try:
        manifest = json.load(open(manifest_path))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"image-manifest.json unreadable: {exc!r}", file=sys.stderr)
        return 1

    status = manifest.get("status")
    if status not in ("complete", "placeholders", "skipped"):
        print(f"bad status: {status!r}", file=sys.stderr)
        return 1

    if status != "complete":
        # Placeholders or skipped: no count check
        return 0

    images = manifest.get("images") or []
    ic = len(images)

    # Default expected count: 7 (legacy hardcoded list).
    expected = 7
    expected_source = "legacy"

    si_path = ".runs/slot-intent.json"
    if os.path.exists(si_path):
        try:
            si = json.load(open(si_path))
        except (OSError, json.JSONDecodeError):
            si = None
        if isinstance(si, dict) and si.get("design_slots_enabled"):
            slots = si.get("slots") or {}
            expected = sum(
                1 for v in slots.values()
                if isinstance(v, dict)
                and v.get("production_method") == "ai_generated"
            )
            expected_source = "slot-intent"

    if expected_source == "slot-intent":
        # Strict equality when slot-intent is authoritative.
        if ic != expected:
            print(
                f"expected exactly {expected} images per slot-intent "
                f"(production_method=ai_generated count), got {ic}",
                file=sys.stderr,
            )
            return 1
    else:
        # Legacy: >= 7
        if ic < expected:
            print(f"expected >={expected} images, got {ic}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

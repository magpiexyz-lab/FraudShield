#!/usr/bin/env python3
"""Backward-compat tool for projects bootstrapped before slot-intent
contract shipped (Issue #1077, PR1.5).

Reads existing .runs/image-manifest.json + greps src/**/*.{tsx,jsx,ts,js}
to infer per-slot intent. Writes SUGGESTIONS to
.runs/slot-intent-migration-suggestions.json (NOT canonical
.runs/slot-intent.json) per Round 2 critic Concern 5: never auto-write
canonical from inference, since the static analyzer has known limits
(walker depth, clsx/cva resolution, dynamic className).

Confidence levels:
  high   — direct grep hit at module level, unambiguous className
  medium — import-walker resolved at depth ≤ 2, unambiguous className
  low    — clsx/cn/cva detected OR dynamic className OR walker depth > 2

User reviews suggestions and promotes to canonical via /resolve or
hand-edit. /upgrade skill invokes this tool as part of template-sync.

Run:
  python3 .claude/scripts/migrate-slot-intent.py
  python3 .claude/scripts/migrate-slot-intent.py --src-root /path/to/src
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys


# ---------------------------------------------------------------------------
# CSS / className extraction
# ---------------------------------------------------------------------------

OPACITY_TAILWIND = {
    f"opacity-{n}": n / 100.0
    for n in (0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50,
              55, 60, 65, 70, 75, 80, 85, 90, 95, 100)
}
OPACITY_ARBITRARY_RE = re.compile(r"opacity-\[([\d.]+)(%)?\]")
BLEND_RE = re.compile(r"\bmix-blend-([a-z\-]+)\b")
GRAYSCALE_RE = re.compile(r"\bgrayscale\b(?![-\d])")
GRAYSCALE_VAL_RE = re.compile(r"\bgrayscale-\[([\d.]+)\]")
BRIGHTNESS_RE = re.compile(r"\bbrightness-(\d+)\b")
INLINE_OPACITY_RE = re.compile(r"opacity:\s*([\d.]+)")
INLINE_BLEND_RE = re.compile(r"mixBlendMode:\s*[\"']([\w-]+)")
CONDITIONAL_RE = re.compile(r"\b(?:clsx|cn|cva)\s*\(")
DYNAMIC_CLASS_RE = re.compile(r"className=\{[^\"`]*[`$]")


def extract_render_from_classname(text: str) -> tuple[dict, str]:
    """Parse a snippet of JSX text (className + style nearby) into intended_render
    + confidence label. Best-effort heuristic."""
    confidence = "high"

    # Conditional className OR dynamic className → low confidence
    if CONDITIONAL_RE.search(text) or DYNAMIC_CLASS_RE.search(text):
        confidence = "low"

    # Opacity
    opacity = 1.0
    for cls, val in OPACITY_TAILWIND.items():
        if re.search(rf"\b{re.escape(cls)}\b", text):
            opacity = val
            break
    m = OPACITY_ARBITRARY_RE.search(text)
    if m:
        try:
            v = float(m.group(1))
            if m.group(2) == "%":
                v /= 100.0
            opacity = v
        except ValueError:
            confidence = "low"
    m = INLINE_OPACITY_RE.search(text)
    if m:
        try:
            opacity = float(m.group(1))
        except ValueError:
            confidence = "low"

    # Blend mode
    blend_mode = "normal"
    m = BLEND_RE.search(text)
    if m:
        blend_mode = m.group(1)
    m = INLINE_BLEND_RE.search(text)
    if m:
        blend_mode = m.group(1).lower()

    # Filter
    filter_parts = []
    if GRAYSCALE_RE.search(text):
        filter_parts.append("grayscale(1)")
    m = GRAYSCALE_VAL_RE.search(text)
    if m:
        filter_parts.append(f"grayscale({m.group(1)})")
    m = BRIGHTNESS_RE.search(text)
    if m:
        try:
            v = int(m.group(1))
            filter_parts.append(f"brightness({v / 100.0})")
        except ValueError:
            pass
    filter_str = " ".join(filter_parts) if filter_parts else "none"

    return {
        "opacity": opacity,
        "blend_mode": blend_mode,
        "filter": filter_str,
    }, confidence


# ---------------------------------------------------------------------------
# Per-filename grep (Layer 1)
# ---------------------------------------------------------------------------

def find_usages(src_root: str, filename: str) -> list[dict]:
    """Find all import/usage sites for a given image filename in src/.
    Returns list of {path, line, snippet}.
    """
    public_path = f"/images/{filename}"
    results = []
    if not os.path.isdir(src_root):
        return results
    patterns = (
        os.path.join(src_root, "**/*.tsx"),
        os.path.join(src_root, "**/*.jsx"),
        os.path.join(src_root, "**/*.ts"),
        os.path.join(src_root, "**/*.js"),
    )
    for pattern in patterns:
        for path in glob.glob(pattern, recursive=True):
            try:
                with open(path) as f:
                    lines = f.readlines()
            except OSError:
                continue
            for i, line in enumerate(lines):
                if public_path in line or filename in line:
                    # Capture a 5-line window for className extraction.
                    start = max(0, i - 2)
                    end = min(len(lines), i + 3)
                    snippet = "".join(lines[start:end])
                    results.append({
                        "path": os.path.relpath(path, os.path.dirname(src_root))
                                       .replace(os.sep, "/"),
                        "line": i + 1,
                        "snippet": snippet,
                    })
    return results


# ---------------------------------------------------------------------------
# Slot inference per filename
# ---------------------------------------------------------------------------

def infer_slot_role(intended_render: dict) -> str:
    """Map an inferred intended_render to a likely slot_role."""
    opacity = intended_render["opacity"]
    blend = intended_render["blend_mode"]
    filter_str = intended_render["filter"]

    # Heavy demote: opacity < 0.2 OR luminosity blend OR grayscale present
    if opacity < 0.2 or blend == "luminosity":
        return "texture"
    if "grayscale" in filter_str and opacity < 0.5:
        return "texture"
    if opacity < 0.5:
        return "texture"
    return "focal"


def infer_for_filename(src_root: str, filename: str,
                      opengraph_image_exists: bool) -> dict:
    """Produce a suggestion for one image filename."""
    # Special case: og-photo with opengraph-image.tsx → dynamic_runtime
    if filename.startswith("og-photo") and opengraph_image_exists:
        return {
            "slot_role": "none",
            "production_method": "dynamic_runtime",
            "intended_render": None,
            "candidate_budget": "low",
            "runtime_gate": None,
            "confidence": "high",
            "evidence": (
                "src/app/opengraph-image.tsx exists; static og-photo is "
                "dead asset. Recommendation: delete public/images/og-photo.* "
                "and og-photo entry from image-manifest.json."
            ),
            "import_sites": [],
        }

    usages = find_usages(src_root, filename)
    if not usages:
        return {
            "slot_role": "none",
            "production_method": "none",
            "intended_render": None,
            "candidate_budget": "low",
            "runtime_gate": None,
            "confidence": "high",
            "evidence": (
                f"no import sites in src/ for {filename}; asset appears "
                "unused. Recommendation: delete public/images and manifest entry."
            ),
            "import_sites": [],
        }

    # Use the first usage's snippet for render extraction.
    render, confidence = extract_render_from_classname(usages[0]["snippet"])
    slot_role = infer_slot_role(render)

    return {
        "slot_role": slot_role,
        "production_method": "ai_generated",
        "intended_render": render,
        "candidate_budget": "low" if slot_role == "texture" else "medium",
        "runtime_gate": None,
        "confidence": confidence,
        "evidence": (
            f"found {len(usages)} usage(s); inferred slot_role={slot_role!r} "
            f"from observed render: opacity={render['opacity']}, "
            f"blend={render['blend_mode']}, filter={render['filter']!r}"
        ),
        "import_sites": [
            {"path": u["path"], "line": u["line"]} for u in usages[:5]
        ],
    }


# ---------------------------------------------------------------------------
# Top-level migration
# ---------------------------------------------------------------------------

def main(argv: list[str] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--src-root", default="src",
        help="Path to src/ (default: 'src' relative to cwd)",
    )
    parser.add_argument(
        "--manifest", default=".runs/image-manifest.json",
        help="Path to image-manifest.json",
    )
    parser.add_argument(
        "--output", default=".runs/slot-intent-migration-suggestions.json",
        help="Output file for suggestions",
    )
    args = parser.parse_args(argv)

    if not os.path.exists(args.manifest):
        print(f"ERROR: manifest not found at {args.manifest}", file=sys.stderr)
        print(
            "This tool migrates legacy projects bootstrapped before the "
            "slot-intent contract shipped. If image-manifest.json doesn't "
            "exist, there is nothing to migrate.",
            file=sys.stderr,
        )
        return 1

    with open(args.manifest) as f:
        manifest = json.load(f)

    images = manifest.get("images", [])
    if not isinstance(images, list):
        print(f"ERROR: manifest.images is not a list", file=sys.stderr)
        return 1

    src_root = args.src_root
    opengraph_image_exists = os.path.exists("src/app/opengraph-image.tsx")

    suggestions: dict[str, dict] = {}
    for entry in images:
        if not isinstance(entry, dict):
            continue
        filename = entry.get("filename")
        if not filename:
            continue
        # Map filename → slot key (drop extension; "feature-1.webp" → "feature-1")
        slot_key = filename.rsplit(".", 1)[0]
        suggestions[slot_key] = infer_for_filename(
            src_root, filename, opengraph_image_exists,
        )

    output = {
        "_schema_version": 1,
        "_kind": "slot-intent-migration-suggestions",
        "_disclaimer": (
            "These are SUGGESTIONS only. Review and promote to canonical "
            ".runs/slot-intent.json manually or via /resolve. The static "
            "analyzer has known limits (walker depth ≤ 2, clsx/cva "
            "resolution, dynamic className) — confidence flags reflect "
            "those limits."
        ),
        "generated_at": datetime.datetime.now(datetime.timezone.utc)
                                .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "manifest_path": args.manifest,
        "src_root": src_root,
        "opengraph_image_tsx_exists": opengraph_image_exists,
        "suggestions": suggestions,
    }

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    counts = {"high": 0, "medium": 0, "low": 0}
    for s in suggestions.values():
        c = s.get("confidence", "low")
        counts[c] = counts.get(c, 0) + 1

    print(f"Wrote {args.output}: {len(suggestions)} suggestions")
    print(f"  confidence: high={counts['high']}, medium={counts['medium']}, "
          f"low={counts['low']}")
    print()
    print("REVIEW REQUIRED — these are suggestions, not canonical. "
          "Hand-edit .runs/slot-intent.json or invoke /resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

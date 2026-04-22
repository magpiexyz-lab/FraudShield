#!/usr/bin/env python3
"""test_auth_paths_drift.py — enforce AUTH_PATHS single-source invariant.

`.claude/patterns/render-review-detection.md` and
`.claude/patterns/review-verdict-gate.md` both carry a `// SHARED:AUTH_PATHS`
anchor marking the canonical AUTH_PATHS Set. The anchor comment promises
that the two Sets are equal; this test enforces it.

Failure mode we prevent: adding `/reset-password` to one file but not the
other — the `review-verdict-gate.md` gate would classify a legitimate
auth-redirect as "non-auth" (product redirect → DEGRADED), when it should
be "auth" (session expired → FAIL).

Exit 0 on all-pass, 1 on any failure.
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PATTERN_FILES = [
    ROOT / ".claude/patterns/render-review-detection.md",
    ROOT / ".claude/patterns/review-verdict-gate.md",
]

ANCHOR = "// SHARED:AUTH_PATHS"


def extract_auth_paths_sets(file_path: Path) -> list[set[str]]:
    """Return all AUTH_PATHS Set literals following the anchor, per file.

    The anchor is a single-line comment. Immediately after (within 20 lines)
    we expect either a JS `new Set([...])` or a Python `{...}` literal
    containing string paths. Return the set of paths per occurrence.
    """
    content = file_path.read_text()
    sets: list[set[str]] = []

    for idx, line in enumerate(content.splitlines()):
        if ANCHOR not in line:
            continue
        # Look ahead up to 20 lines for a Set literal
        window = "\n".join(content.splitlines()[idx : idx + 20])

        # Try JS form: new Set([...])
        js_match = re.search(r"new Set\(\[([^\]]*)\]\)", window)
        # Try Python form: {"...", "..."}
        py_match = re.search(r"AUTH_PATHS\s*=\s*\{([^}]*)\}", window)

        raw = None
        if js_match:
            raw = js_match.group(1)
        elif py_match:
            raw = py_match.group(1)

        if raw is None:
            continue

        # Extract quoted strings
        paths = set(re.findall(r'"([^"]+)"', raw))
        sets.append(paths)

    return sets


class TestAuthPathsDrift(unittest.TestCase):
    def test_both_files_contain_the_anchor(self):
        for fp in PATTERN_FILES:
            with self.subTest(file=str(fp)):
                content = fp.read_text()
                occurrences = content.count(ANCHOR)
                self.assertGreaterEqual(
                    occurrences,
                    1,
                    f"{fp} must contain the '// SHARED:AUTH_PATHS' anchor at least once",
                )

    def test_all_extracted_sets_are_equal(self):
        all_sets: list[tuple[Path, set[str]]] = []
        for fp in PATTERN_FILES:
            sets = extract_auth_paths_sets(fp)
            self.assertGreater(
                len(sets),
                0,
                f"no AUTH_PATHS Set literal found after anchor in {fp}",
            )
            for s in sets:
                all_sets.append((fp, s))

        # Compare every pair
        first_path, first_set = all_sets[0]
        for fp, s in all_sets[1:]:
            self.assertEqual(
                first_set,
                s,
                f"AUTH_PATHS drifted between:\n"
                f"  {first_path}: {sorted(first_set)}\n"
                f"  {fp}: {sorted(s)}",
            )

    def test_no_inline_auth_paths_outside_anchors(self):
        """Any file in .claude/patterns/ or .claude/procedures/ that
        references AUTH_PATHS (by symbol name) without the anchor is a
        drift regression.
        """
        import subprocess

        result = subprocess.run(
            ["git", "-C", str(ROOT), "grep", "-l", "AUTH_PATHS", "--", ".claude/"],
            capture_output=True,
            text=True,
        )
        if result.returncode not in (0, 1):
            self.skipTest(f"git grep failed: {result.stderr}")
            return

        for line in result.stdout.strip().splitlines():
            path = Path(ROOT / line.strip())
            if not path.exists():
                continue
            # Skip test files and the canonical patterns themselves
            if "scripts/tests/" in str(path):
                continue
            if path in PATTERN_FILES:
                continue
            # Allow accessibility-scanner procedure to reference PUBLIC_PATHS
            # (distinct set, not AUTH_PATHS)
            content = path.read_text()
            if re.search(r"\bAUTH_PATHS\b", content):
                # Any file that references AUTH_PATHS outside the two canonical
                # patterns must also carry the anchor comment for traceability.
                # (Future-proofing: if a 4th reviewer's procedure needs AUTH_PATHS
                # inline, it should reference one of the canonical files via
                # a comment rather than redeclare the set.)
                if ANCHOR not in content:
                    self.fail(
                        f"{path} references AUTH_PATHS without the '{ANCHOR}' "
                        f"anchor. Either add the anchor (if this is a shared "
                        f"canonical source) or reference one of the canonical "
                        f"pattern files in a comment."
                    )


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Unit tests for emit-sitemap.py (#1387).

Validates deterministic output: same experiment.yaml + repo state yields
byte-identical src/app/sitemap.ts.

Run via:
    python3 .claude/scripts/tests/test_emit_sitemap.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest

REAL_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# emit-sitemap.py has a hyphen in its filename — load via spec.
EMIT_PATH = os.path.join(REAL_REPO, ".claude", "scripts", "lib", "emit-sitemap.py")
spec = importlib.util.spec_from_file_location("emit_sitemap", EMIT_PATH)
emit_sitemap = importlib.util.module_from_spec(spec)
sys.path.insert(0, os.path.join(REAL_REPO, ".claude", "scripts", "lib"))
spec.loader.exec_module(emit_sitemap)


def _mkpage(root: str, route_path: str):
    full = os.path.join(root, "src", "app", route_path)
    os.makedirs(full, exist_ok=True)
    with open(os.path.join(full, "page.tsx"), "w") as fh:
        fh.write("export default function P() { return null; }")


class TestEmitSitemap(unittest.TestCase):
    def test_empty_experiment_yields_landing_only(self):
        out = emit_sitemap.emit({}, ".")
        self.assertIn("`${b}/`", out)
        self.assertNotIn("spec-builder", out)

    def test_static_pages_emitted(self):
        exp = {
            "stack": {"auth": "supabase"},
            "behaviors": [
                {"id": "b", "pages": ["spec-builder", "portfolio"]},
            ],
            "golden_path": [{"step": "1", "page": "landing"}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            out = emit_sitemap.emit(exp, tmp)
        # Static pages from derive_scope_pages — alphabetized.
        self.assertIn("/spec-builder", out)
        self.assertIn("/portfolio", out)
        self.assertIn("/login", out)   # auth-derived
        self.assertIn("/signup", out)  # auth-derived

    def test_dynamic_segment_urls_emitted_when_route_exists(self):
        exp = {
            "behaviors": [
                {"id": "b-13", "pages": ["portfolio-detail"],
                 "anonymous_allowed": True,
                 "dynamic_segments": {"slug": ["alpha", "beta"]}},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            _mkpage(tmp, "portfolio/[slug]")
            out = emit_sitemap.emit(exp, tmp)
        self.assertIn("/portfolio/alpha", out)
        self.assertIn("/portfolio/beta", out)

    def test_dynamic_segment_skipped_when_route_absent(self):
        # No src/app/portfolio/[slug] → concrete_url is None → skipped.
        exp = {
            "behaviors": [
                {"id": "b-13", "pages": ["portfolio-detail"],
                 "anonymous_allowed": True,
                 "dynamic_segments": {"slug": ["alpha"]}},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            out = emit_sitemap.emit(exp, tmp)
        self.assertNotIn("/portfolio/alpha", out)

    def test_deterministic_output(self):
        # Same input → byte-identical output.
        exp = {
            "behaviors": [{"id": "b", "pages": ["a", "b"]}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            out1 = emit_sitemap.emit(exp, tmp)
            out2 = emit_sitemap.emit(exp, tmp)
        self.assertEqual(out1, out2)

    def test_output_is_valid_ts_metadata_route_shape(self):
        out = emit_sitemap.emit({}, ".")
        self.assertIn("import type { MetadataRoute } from 'next';", out)
        self.assertIn("export default function sitemap(): MetadataRoute.Sitemap", out)
        # Each entry has the required shape.
        self.assertIn("lastModified: now", out)
        self.assertIn("changeFrequency:", out)
        self.assertIn("priority:", out)


if __name__ == "__main__":
    unittest.main()

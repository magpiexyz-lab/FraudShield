#!/usr/bin/env python3
"""Behavioral tests for derive_page_set_for_design_critic() and
derive_page_images() from .claude/scripts/lib/derive_pages.py (#1042).

Covers:
  - Filesystem-scan + golden_path + behaviors union + auth-derived pages
  - Dynamic-route detection + synthetic-ID URL concretization
  - Static image classifier: direct source, next/image import, <img>,
    public/images/, empty-state literal, landing override
  - Layer 2 import-graph walk via @/components/** and relative imports
  - Two-hop accepted false-negative

Run via: python3 .claude/scripts/tests/test_derive_page_images.py
"""
import os
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO_ROOT, ".claude", "scripts"))

from lib.derive_pages import (  # noqa: E402
    derive_page_images,
    derive_page_set_for_design_critic,
)


def _touch(path: str, content: str = "") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


class TestPageSetDiscovery(unittest.TestCase):
    def test_filesystem_only_with_dynamic_route(self):
        with tempfile.TemporaryDirectory() as tmp:
            _touch(os.path.join(tmp, "src/app/page.tsx"), "// landing")
            _touch(os.path.join(tmp, "src/app/dashboard/page.tsx"), "// dash")
            _touch(os.path.join(tmp, "src/app/quote/[id]/page.tsx"), "// quote")
            _touch(os.path.join(tmp, "src/app/docs/[[...slug]]/page.tsx"), "// docs")
            result = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            names = sorted(r["name"] for r in result)
            # landing excluded from operational list; fs-scan picks up
            # dashboard + docs + quote
            self.assertEqual(names, ["dashboard", "docs", "quote"])
            quote = next(r for r in result if r["name"] == "quote")
            self.assertEqual(quote["route_pattern"], "/quote/[id]")
            self.assertEqual(quote["dynamic_segments"], ["id"])

    def test_api_routes_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            _touch(os.path.join(tmp, "src/app/api/health/route.ts"), "")
            _touch(os.path.join(tmp, "src/app/api/some/page.tsx"), "")  # even if misnamed
            _touch(os.path.join(tmp, "src/app/dashboard/page.tsx"), "")
            result = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            names = [r["name"] for r in result]
            self.assertIn("dashboard", names)
            self.assertNotIn("some", names)

    def test_concretize_dynamic_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            _touch(os.path.join(tmp, "src/app/quote/[id]/page.tsx"), "")
            _touch(os.path.join(tmp, "src/app/team/[org]/member/[id]/page.tsx"), "")
            _touch(os.path.join(tmp, "src/app/post/[slug]/page.tsx"), "")
            result = {r["name"]: r for r in derive_page_set_for_design_critic({"type": "web-app"}, tmp)}
            self.assertEqual(
                result["quote"]["test_url"],
                "/quote/00000000-0000-0000-0000-000000000000",
            )
            self.assertIn("00000000-0000-0000-0000-000000000000", result["member"]["test_url"])
            self.assertEqual(result["post"]["test_url"], "/post/demo-fixture-slug")

    def test_union_with_golden_path_and_auth(self):
        exp = {
            "type": "web-app",
            "golden_path": [
                {"page": "landing"},
                {"page": "dashboard"},
                {"page": "admin"},
            ],
            "stack": {"auth": "supabase"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            _touch(os.path.join(tmp, "src/app/page.tsx"), "")
            result = derive_page_set_for_design_critic(exp, tmp)
            names = sorted(r["name"] for r in result)
            # dashboard + admin from golden_path; login+signup from auth;
            # landing excluded
            self.assertEqual(names, ["admin", "dashboard", "login", "signup"])

    def test_source_files_enumerated(self):
        with tempfile.TemporaryDirectory() as tmp:
            _touch(os.path.join(tmp, "src/app/dashboard/page.tsx"), "")
            _touch(os.path.join(tmp, "src/app/dashboard/widget.tsx"), "")
            _touch(os.path.join(tmp, "src/app/dashboard/chart/bar.tsx"), "")
            result = {r["name"]: r for r in derive_page_set_for_design_critic({"type": "web-app"}, tmp)}
            source = sorted(result["dashboard"]["source_files"])
            self.assertIn("src/app/dashboard/page.tsx", source)
            self.assertIn("src/app/dashboard/widget.tsx", source)


class TestDerivePageImages(unittest.TestCase):
    def _make(self, tmp: str, relpath: str, body: str) -> None:
        _touch(os.path.join(tmp, relpath), body)

    def test_direct_Image_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/app/portfolio/page.tsx",
                'import Image from "next/image"\nexport default function(){return <Image src="/hero.webp" alt="" />}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["portfolio"]["has_images"])
            self.assertEqual(im["portfolio"]["detected_via"], "direct-source")

    def test_direct_img_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/app/gallery/page.tsx",
                'export default function(){return <div><img src="/x.png" /></div>}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["gallery"]["has_images"])
            self.assertEqual(im["gallery"]["detected_via"], "direct-source")

    def test_public_images_literal(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/app/about/page.tsx",
                'const logo = "/public/images/logo.svg"\nexport default function(){return <div style={{background: `url(${logo})`}} />}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["about"]["has_images"])

    def test_empty_state_literal(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/app/projects/page.tsx",
                'export default function(){return <div className="empty-state">No projects</div>}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["projects"]["has_images"])

    def test_next_image_import_only_counts(self):
        # The import statement alone matches the next/image pattern — acceptable
        # false-positive (at worst forces image_issues_for_landing field to
        # be present on a page that might not visibly render an Image).
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/app/blog/page.tsx",
                'import Image from "next/image"\nexport default function(){return <p>Blog</p>}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["blog"]["has_images"])

    def test_shared_component_via_alias_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/components/hero.tsx",
                'import Image from "next/image"\nexport function Hero(){return <Image src="/h.webp" alt="" />}\n',
            )
            self._make(
                tmp,
                "src/app/portfolio/page.tsx",
                'import { Hero } from "@/components/hero"\nexport default function(){return <Hero />}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["portfolio"]["has_images"])
            self.assertEqual(im["portfolio"]["detected_via"], "imported-component")
            self.assertIn("src/components/hero.tsx", im["portfolio"]["evidence_files"])

    def test_shared_component_via_relative_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/components/banner.tsx",
                '<Image src="/b.png" />\n',
            )
            self._make(
                tmp,
                "src/app/spec/page.tsx",
                'import { Banner } from "../../components/banner"\nexport default function(){return <Banner/>}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["spec"]["has_images"])
            self.assertEqual(im["spec"]["detected_via"], "imported-component")

    def test_two_hop_import_is_false_negative(self):
        # Accepted limitation: only one level of import walk.
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/components/inner.tsx",
                '<Image src="/deep.webp" />\n',
            )
            self._make(
                tmp,
                "src/components/wrapper.tsx",
                'import { Inner } from "./inner"\nexport function Wrapper(){return <Inner/>}\n',
            )
            self._make(
                tmp,
                "src/app/deep-nest/page.tsx",
                'import { Wrapper } from "@/components/wrapper"\nexport default function(){return <Wrapper/>}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            # Wrapper doesn't itself contain image patterns; Inner does but is
            # two hops away. Documented false negative.
            self.assertFalse(im["deep-nest"]["has_images"])
            self.assertEqual(im["deep-nest"]["detected_via"], "none")

    def test_pure_text_page_no_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/app/auth/reset-password/page.tsx",
                'export default function(){return <form><input/></form>}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            # reset-password is not standalone in page_set — it's nested under
            # auth/. "auth" slug classifies. Check both possible names.
            if "reset-password" in im:
                self.assertFalse(im["reset-password"]["has_images"])
            elif "auth" in im:
                self.assertFalse(im["auth"]["has_images"])
            else:
                # At minimum, the naming from _path_to_page_info picks
                # "reset-password" or similar — just ensure none of the
                # classified entries are flagged has_images=true
                self.assertFalse(any(v["has_images"] for v in im.values()))

    def test_landing_hardcoded(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(tmp, "src/app/page.tsx", 'export default function(){return <p>hi</p>}\n')
            # Pure text landing, still forced to has_images=true
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=True)
            self.assertIn("landing", im)
            self.assertTrue(im["landing"]["has_images"])
            self.assertEqual(im["landing"]["detected_via"], "landing-hardcoded")

    def test_dynamic_route_child_with_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make(
                tmp,
                "src/app/quote/[id]/page.tsx",
                'import Image from "next/image"\nexport default function(){return <Image src="/q.webp" alt="" />}\n',
            )
            page_set = derive_page_set_for_design_critic({"type": "web-app"}, tmp)
            im = derive_page_images(page_set, tmp, include_landing=False)
            self.assertTrue(im["quote"]["has_images"])


if __name__ == "__main__":
    unittest.main()

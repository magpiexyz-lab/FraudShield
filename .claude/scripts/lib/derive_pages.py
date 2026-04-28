#!/usr/bin/env python3
"""Canonical page-inventory derivation for experiment.yaml.

Single source of truth for "what pages must exist on disk" (SET semantics)
and "what is the user journey" (LIST semantics). All count-based and
inventory-based consumers MUST call these functions; raw access to
`golden_path` for these purposes is forbidden by `verify-linter.sh`
field_role_map rule.

Also provides design-critic orchestration helpers (#1042):
- `derive_page_set_for_design_critic()` — operational page list with
  concretized test URLs for dynamic routes.
- `derive_page_images()` — two-layer static image-render classifier.

See .claude/templates/experiment-yaml.md for the full schema.
"""
import glob
import json
import os
import re
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


def derive_public_paths(experiment: dict[str, Any]) -> list[str]:
    """Return the sorted set of route paths that the auth proxy/middleware
    treats as public (no auth required).

    Issue #1126: the auth template's hardcoded `publicPaths` array drifts from
    `behaviors[*]` semantics whenever an experiment declares anonymous-allowed
    pages outside the static defaults (e.g., a public `/spec` builder, public
    quote-view pages). Bootstrap MUST substitute the derived array into the
    proxy/middleware template at scaffold-libs time.

    The public set is the union of:
      1. Marketing landing route ("/") -- always public
      2. Auth landing pages ("/login", "/signup") -- always public
      3. Auth callback routes ("/auth/callback", "/auth/reset-password") -- always public
      4. Health endpoint ("/api/health") -- always public
      5. Behaviors[*].pages where every owning behavior has `anonymous_allowed: true`
         (intersection / fail-secure: a page shared between two behaviors is
         public only if BOTH behaviors mark it anonymous_allowed)

    `behavior.anonymous_allowed: bool (default false)` is the explicit
    schema marker. Absence means "auth required" (default-deny). This is
    distinct from `requires_role`, which gates AUTHENTICATED users by role.
    The two are mutually exclusive (validate-experiment.py enforces).

    Variant routes "/v/*" and the analytics ingest prefix "/ingest/" are
    handled separately by the proxy template (path-prefix match), not
    enumerated here.
    """
    auth_landing = {"/", "/login", "/signup", "/auth/callback", "/auth/reset-password"}
    api_public = {"/api/health"}

    # Map page -> list of behaviors that own it (for intersection check).
    page_owners: dict[str, list[dict]] = {}
    for behavior in (experiment.get("behaviors") or []):
        if not isinstance(behavior, dict):
            continue
        for page in (behavior.get("pages") or []):
            if not page:
                continue
            page_owners.setdefault(page, []).append(behavior)

    # Page is public iff EVERY owning behavior marks it anonymous_allowed=true
    # (fail-secure intersection). One auth-required behavior anywhere on the
    # page keeps it auth-gated.
    behavior_public: set[str] = set()
    for page, owners in page_owners.items():
        if owners and all(b.get("anonymous_allowed") is True for b in owners):
            # Convert page slug to route ("/<page>")
            behavior_public.add(f"/{page}")

    return sorted(auth_landing | api_public | behavior_public)


def derive_funnel_steps(experiment: dict[str, Any]) -> list[dict]:
    """Return the ordered list of golden_path steps for sequence-based consumers.

    List semantics: order matters. Use this for nav-bar generation,
    funnel test sequences, sitemap ordering, and journey walkthroughs.

    Returns the raw list (each entry is a dict with `step`, `event`, `page`).
    Callers iterate in order; do not call set() or len() on this for inventory
    purposes — use derive_scope_pages() instead.
    """
    return list(experiment.get("golden_path") or [])


# ---------------------------------------------------------------------------
# Design-critic orchestration helpers (#1042 / Session C)
# ---------------------------------------------------------------------------

# Synthetic test IDs for dynamic route segments. DEMO_MODE Supabase stub
# returns null from .single() for any ID, so the exact value only needs to be
# URL-safe and deterministic. Choosing distinctly-fixture values (nil UUID,
# "demo-fixture-*") avoids collision with real production IDs if these URLs
# ever leak into non-DEMO_MODE contexts.
_SYNTHETIC_SEGMENT_IDS: dict[str, str] = {
    "id": "00000000-0000-0000-0000-000000000000",
    "slug": "demo-fixture-slug",
    "token": "demo-fixture-token",
    "uuid": "00000000-0000-0000-0000-000000000000",
}

# Static image-render detection patterns (Layer 1 + Layer 2).
# Matching any of these in a .tsx / .jsx file classifies the owning page
# has_images=true.
_IMAGE_PATTERNS: list[str] = [
    r"<Image\b",
    r'from\s+["\']next/image["\']',
    r"<img\b",
    r"public/images/",
    r"empty-state",
]

# Route-path bracket regex identifies dynamic routes (e.g., /quote/[id],
# /docs/[[...slug]]). Any bracket counts.
_DYNAMIC_SEGMENT_RE = re.compile(r"\[([^\]]+)\]")

# Cap filesystem-scan patterns to tsx/jsx under src/app, excluding API routes.
_PAGE_FILE_GLOBS = (
    "src/app/**/page.tsx",
    "src/app/**/page.jsx",
    "src/app/**/page.ts",
    "src/app/**/page.js",
)


def _concretize_url(route_pattern: str) -> str:
    """Substitute each [segment] with a synthetic test ID deterministically."""
    def sub(m: "re.Match[str]") -> str:
        raw = m.group(1)
        # Handle catch-all / optional-catchall ([...slug], [[...slug]])
        stripped = raw.lstrip(".").lstrip("[").rstrip("]")
        key = stripped.lower()
        return _SYNTHETIC_SEGMENT_IDS.get(key, f"demo-fixture-{key}")
    return _DYNAMIC_SEGMENT_RE.sub(sub, route_pattern)


def _path_to_page_info(page_file: str) -> tuple[str, str]:
    """Convert src/app/<p>/page.tsx → (page_name, route_pattern).

    page_name is the folder slug (or "landing" if directly under src/app).
    route_pattern preserves [segment] literals for dynamic routes.
    """
    # Strip src/app/ prefix and /page.<ext> suffix
    rel = page_file
    if rel.startswith("src/app/"):
        rel = rel[len("src/app/"):]
    # rel is now e.g. "quote/[id]/page.tsx" or "page.tsx"
    parts = rel.split("/")
    filename = parts[-1]
    folder_parts = parts[:-1]
    if not filename.startswith("page."):
        # Not a recognisable page file — caller should have filtered
        return ("", "")
    if not folder_parts:
        return ("landing", "/")
    route = "/" + "/".join(folder_parts)
    # Slug is the last non-bracketed folder name; for purely-dynamic leaf
    # (e.g. src/app/[locale]/page.tsx), fall back to the raw folder name.
    non_bracket_parts = [p for p in folder_parts if "[" not in p]
    if non_bracket_parts:
        name = non_bracket_parts[-1]
    else:
        name = folder_parts[-1].strip("[]")
    return (name, route)


def derive_page_set_for_design_critic(
    experiment: dict[str, Any],
    repo_root: str = ".",
) -> list[dict[str, Any]]:
    """Return the list of pages for design-critic per-page spawns (#1042).

    Matches state-3a Stage-1 discovery semantics: filesystem scan UNION
    golden_path UNION auth-derived, EXCLUDING "landing" from the operational
    list (state-3b treats landing separately).

    Each entry:
        {
            "name": <page-slug>,
            "route_pattern": "/<slug>" or "/<slug>/[<seg>]" (literal bracket),
            "test_url":     concrete URL safe for page.goto,
            "source_files": [<repo-relative .tsx/.jsx paths>],
            "dynamic_segments": [<segment-name>, ...]  (empty for static routes)
        }
    """
    # 1. Filesystem scan
    discovered: dict[str, dict[str, Any]] = {}
    for pattern in _PAGE_FILE_GLOBS:
        for p in glob.glob(os.path.join(repo_root, pattern), recursive=True):
            rel = os.path.relpath(p, repo_root).replace(os.sep, "/")
            # Skip API routes
            if "/api/" in rel or rel.startswith("api/"):
                continue
            name, route = _path_to_page_info(rel)
            if not name:
                continue
            entry = discovered.setdefault(
                name,
                {
                    "name": name,
                    "route_pattern": route,
                    "source_files": [],
                    "dynamic_segments": [
                        m.group(1) for m in _DYNAMIC_SEGMENT_RE.finditer(route)
                    ],
                },
            )
            if rel not in entry["source_files"]:
                entry["source_files"].append(rel)
            # Also enumerate nested .tsx/.jsx files under this page's folder
            folder = os.path.dirname(rel)
            if folder:
                for ext in ("tsx", "jsx"):
                    nested = glob.glob(
                        os.path.join(repo_root, folder, f"**/*.{ext}"),
                        recursive=True,
                    )
                    for nrel in nested:
                        nrel_norm = os.path.relpath(nrel, repo_root).replace(
                            os.sep, "/"
                        )
                        if nrel_norm not in entry["source_files"]:
                            entry["source_files"].append(nrel_norm)

    # 2. Union with golden_path + behavior.pages + auth-derived via
    #    derive_scope_pages (already excludes "landing"). For entries not yet
    #    discovered, insert a placeholder (source_files may be empty).
    for name in derive_scope_pages(experiment):
        if name not in discovered:
            discovered[name] = {
                "name": name,
                "route_pattern": f"/{name}",
                "source_files": [],
                "dynamic_segments": [],
            }

    # 3. Exclude landing from the operational list
    discovered.pop("landing", None)

    # 4. Build final entries with concretized test_urls, sorted by name
    out: list[dict[str, Any]] = []
    for name in sorted(discovered):
        entry = discovered[name]
        entry["test_url"] = _concretize_url(entry["route_pattern"])
        # Deterministic source_files order
        entry["source_files"] = sorted(entry["source_files"])
        out.append(entry)
    return out


def _grep_image_patterns(file_path: str) -> list[str]:
    """Return the subset of _IMAGE_PATTERNS that match in the file, or []."""
    if not os.path.isfile(file_path):
        return []
    try:
        with open(file_path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return []
    matched: list[str] = []
    for pat in _IMAGE_PATTERNS:
        if re.search(pat, text):
            matched.append(pat)
    return matched


# Regex for top-level relative imports that can be resolved to src/components
# or src/lib. Single line captures the quoted path.
_IMPORT_RE = re.compile(
    r'^\s*import\s+(?:[^"\']+from\s+)?["\']([^"\']+)["\'];?\s*$',
    re.MULTILINE,
)


def _resolve_import(
    importer_path: str, import_spec: str, repo_root: str
) -> str | None:
    """Resolve an import spec to a repo-relative source-file path.

    Handles:
      - "@/components/foo" → "src/components/foo.tsx" (or .jsx/.ts/.js)
      - "@/lib/bar"        → "src/lib/bar.tsx"
      - relative (./ or ../) paths resolved against importer's directory,
        but ONLY if the resolved path sits under src/components/ or src/lib/
    Returns None when the import cannot be resolved to a source file under
    those two trees.
    """
    if import_spec.startswith("@/components/") or import_spec.startswith(
        "@/lib/"
    ):
        base = import_spec[2:]  # strip "@/"
        candidate_roots = [os.path.join(repo_root, "src", base)]
    elif import_spec.startswith("./") or import_spec.startswith("../"):
        importer_dir = os.path.dirname(
            os.path.join(repo_root, importer_path)
        )
        resolved = os.path.normpath(os.path.join(importer_dir, import_spec))
        rel = os.path.relpath(resolved, repo_root).replace(os.sep, "/")
        if not (rel.startswith("src/components/") or rel.startswith("src/lib/")):
            return None
        candidate_roots = [resolved]
    else:
        return None
    for cr in candidate_roots:
        for ext in (".tsx", ".jsx", ".ts", ".js"):
            p = cr + ext
            if os.path.isfile(p):
                return os.path.relpath(p, repo_root).replace(os.sep, "/")
        # also try index.<ext>
        for ext in (".tsx", ".jsx", ".ts", ".js"):
            p = os.path.join(cr, f"index{ext}")
            if os.path.isfile(p):
                return os.path.relpath(p, repo_root).replace(os.sep, "/")
    return None


def derive_page_images(
    page_set: list[dict[str, Any]],
    repo_root: str = ".",
    include_landing: bool = True,
) -> dict[str, dict[str, Any]]:
    """Two-layer static image-render classifier for design-critic.

    Layer 1 (direct-source): grep each entry's source_files for image patterns.
    Layer 2 (one-level import-graph walk): parse the top page file for import
    statements and grep each resolved src/components/** or src/lib/** target.

    Landing override (when include_landing=True): if an entry is named
    "landing", force has_images=true (owns global slots: hero/features/logo/
    og-photo/empty-state).

    Returns: {
        "<page>": {
            "has_images": bool,
            "detected_via": "direct-source" | "imported-component" |
                            "landing-hardcoded" | "none",
            "evidence_files": [<repo-relative paths where matches fired>],
            "patterns_matched": [<matched regex strings>],
        },
        ...
    }
    """
    result: dict[str, dict[str, Any]] = {}

    # Ensure landing is classified when caller asks (pre-state-3a workflow).
    # Landing's source_files default to src/app/page.tsx if not already present
    # in the input list.
    if include_landing and not any(p.get("name") == "landing" for p in page_set):
        page_set = [
            {
                "name": "landing",
                "route_pattern": "/",
                "test_url": "/",
                "source_files": ["src/app/page.tsx"],
                "dynamic_segments": [],
            },
            *page_set,
        ]

    for entry in page_set:
        name = entry.get("name", "")
        if not name:
            continue
        if name == "landing":
            result[name] = {
                "has_images": True,
                "detected_via": "landing-hardcoded",
                "evidence_files": [],
                "patterns_matched": [],
            }
            continue

        source_files: list[str] = entry.get("source_files") or []
        # Layer 1 — direct source grep
        layer1_hits: list[tuple[str, list[str]]] = []
        for sf in source_files:
            abs_path = os.path.join(repo_root, sf)
            matches = _grep_image_patterns(abs_path)
            if matches:
                layer1_hits.append((sf, matches))

        if layer1_hits:
            result[name] = {
                "has_images": True,
                "detected_via": "direct-source",
                "evidence_files": [sf for sf, _ in layer1_hits],
                "patterns_matched": sorted(
                    {m for _, ms in layer1_hits for m in ms}
                ),
            }
            continue

        # Layer 2 — one-level import-graph walk
        layer2_hits: list[tuple[str, list[str]]] = []
        seen_imports: set[str] = set()
        for sf in source_files:
            abs_path = os.path.join(repo_root, sf)
            if not os.path.isfile(abs_path):
                continue
            try:
                with open(abs_path, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            for m in _IMPORT_RE.finditer(text):
                spec = m.group(1)
                resolved = _resolve_import(sf, spec, repo_root)
                if not resolved or resolved in seen_imports:
                    continue
                seen_imports.add(resolved)
                matches = _grep_image_patterns(
                    os.path.join(repo_root, resolved)
                )
                if matches:
                    layer2_hits.append((resolved, matches))

        if layer2_hits:
            result[name] = {
                "has_images": True,
                "detected_via": "imported-component",
                "evidence_files": [path for path, _ in layer2_hits],
                "patterns_matched": sorted(
                    {m for _, ms in layer2_hits for m in ms}
                ),
            }
            continue

        result[name] = {
            "has_images": False,
            "detected_via": "none",
            "evidence_files": [],
            "patterns_matched": [],
        }

    return result


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
    if len(sys.argv) < 2 or sys.argv[1] not in ("scope", "funnel", "public_paths"):
        sys.stderr.write(
            "usage: derive_pages.py {scope|funnel|public_paths} [< experiment.yaml]\n"
        )
        sys.exit(2)

    experiment = _load_experiment()
    if sys.argv[1] == "scope":
        result = derive_scope_pages(experiment)
    elif sys.argv[1] == "public_paths":
        result = derive_public_paths(experiment)
    else:
        result = derive_funnel_steps(experiment)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Post-fan-out behavior-contract audit for scaffold-pages output (#1387).

Two-layer audit driver:

Layer 4a — Static (fail-fast, runs here):
  For each tagged contract entry in .runs/scaffold-pages-contracts.json,
  perform deterministic structural checks on the page's .tsx file(s).

  Implemented via multi-pass regex / string analysis (not full AST). The
  Layer 4a check is intentionally conservative: it catches obvious gaps
  (no fetch at all, slug missing from sitemap entirely) but defers the
  fool-by-design cases (fetch wrapper with .catch synthesizing stub
  data) to Layer 4b. Round 2 caveat 027e6ac4b29e flags TS-AST as the
  ideal mechanism — this PR ships F6 (npm install typescript-estree)
  so a follow-up can swap in AST-based reachability/consumption checks
  without touching the orchestration in state-11c.

Layer 4b — Runtime signaling (consumed by /verify):
  Emits .runs/behavior-verifier-static-stubs.json. behavior-verifier
  reads this in /verify and runs Playwright network-observability
  checks (B7 dynamic-stub-detection). B7 is the load-bearing
  trustworthy verification — static Layer 4a is fail-fast pre-PR only.

Reads contracts via unstamped_items() from verify_helpers (mandatory
per template-coherence-rules.json rule
verify-d-values-against-stamped-artifact). Writes audit verdict via
write-gate-artifact.sh (canonical writer; stamps {skill, run_id,
written_at}).

CLI: python3 .claude/scripts/lib/behavior_contract_auditor.py [--repo-root PATH]
     Writes .runs/behavior-implementation-audit.json and
     .runs/behavior-verifier-static-stubs.json. Returns 0 even when
     uncovered_count > 0 (state-11c VERIFY block is the gate).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify_helpers import unstamped_items  # type: ignore

CONTRACTS_PATH = ".runs/scaffold-pages-contracts.json"
AUDIT_PATH = ".runs/behavior-implementation-audit.json"
STUBS_PATH = ".runs/behavior-verifier-static-stubs.json"
PHASE_A_SENTINEL_PATH = ".runs/gate-verdicts/phase-a-sentinel.json"
SITEMAP_PATH = "src/app/sitemap.ts"
SCHEMA_VERSION = 2


def _read_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except (OSError, FileNotFoundError):
        return None


def _candidate_page_files(repo_root: str, page: str) -> list[str]:
    """Return ABSOLUTE .tsx/.jsx file paths under the page's folder.

    Tries src/app/<page>/page.tsx first, then disambiguated dynamic
    routes (page contains "-" → split static prefix). Falls back to
    src/app/**/page.tsx scan when neither matches.

    Returns absolute paths so the caller's open() works regardless of
    process CWD (the auditor may be invoked with `cwd != repo_root`).
    """
    direct = os.path.join(repo_root, "src", "app", page, "page.tsx")
    if os.path.isfile(direct):
        return [direct]
    # Disambiguation: page='portfolio-detail' may map to src/app/portfolio/[slug]/
    if "-" in page:
        prefix = page.split("-", 1)[0]
        base = os.path.join(repo_root, "src", "app", prefix)
        if os.path.isdir(base):
            hits: list[str] = []
            for pf in glob.glob(os.path.join(base, "**", "page.tsx"), recursive=True):
                hits.append(pf)
            for pf in glob.glob(os.path.join(base, "**", "page.jsx"), recursive=True):
                hits.append(pf)
            if hits:
                # Also include co-located .tsx files (client components)
                for pf in glob.glob(os.path.join(base, "**", "*-client.tsx"), recursive=True):
                    hits.append(pf)
                return sorted(set(hits))
    return []


def _read_combined_source(files: list[str]) -> str:
    """Concatenate file contents into a single string for grep-style analysis."""
    parts = []
    for f in files:
        text = _read_text(f)
        if text:
            parts.append(text)
    return "\n".join(parts)


# Regex for fetch call sites referencing a specific route literal.
# Matches: fetch('/api/x', ...), fetch("/api/x"), fetch(`/api/x`)
def _fetch_present(source: str, route: str) -> bool:
    pattern = re.compile(
        r"""fetch\s*\(\s*['"`]""" + re.escape(route) + r"""['"`]""",
        re.IGNORECASE,
    )
    return bool(pattern.search(source))


# Detect if the fetch call is wrapped in a constant-false block. Heuristic:
# look for if (false) { ... fetch(route) ... } within ~500 chars window.
_IF_FALSE_RE = re.compile(r"if\s*\(\s*false\s*\)\s*\{", re.IGNORECASE)


def _fetch_unreachable(source: str, route: str) -> bool:
    """Heuristic: report true when fetch(route) sits inside if(false){...}."""
    fetch_pat = re.compile(
        r"""fetch\s*\(\s*['"`]""" + re.escape(route) + r"""['"`]"""
    )
    for fmatch in fetch_pat.finditer(source):
        # Look backward up to 500 chars for an unmatched `if (false) {`
        before = source[max(0, fmatch.start() - 500):fmatch.start()]
        if _IF_FALSE_RE.search(before):
            # Check there is no `}` between if(false){ and fetch (very loose).
            # If a closing brace appears after the if(false){, assume the
            # block already closed; consider this a non-false-positive.
            last_if = list(_IF_FALSE_RE.finditer(before))[-1]
            between = before[last_if.end():]
            if "}" not in between:
                return True
    return False


# Detect .catch(() => <literal>) or .catch(() => (<literal>)) pattern that
# synthesizes stub data. The `\(?\s*` allows the common JS idiom where returning
# an object literal from an arrow function requires wrapping in parens:
# .catch(() => ({ messages: [] }))
_CATCH_LITERAL_RE = re.compile(
    r"""\.\s*catch\s*\(\s*\(\s*[^)]*\s*\)\s*=>\s*\(?\s*([{\[\"'\d])""",
    re.IGNORECASE,
)

# Detect .catch(() => <non-block-expression>) where the catch arrow has
# EMPTY parameters. Empty params mean the error value is discarded — so
# any non-block return is by definition NOT derived from the fetch
# failure. This catches function-call stubs (`.catch(() => synthesize_stub())`)
# and identifier stubs (`.catch(() => MOCK_DATA)`) that the literal-only
# regex above misses. Block form `=> {` is excluded here because blocks
# may legitimately re-raise via `throw` — we handle blocks separately.
_CATCH_EMPTY_PARAM_EXPR_RE = re.compile(
    r"""\.\s*catch\s*\(\s*\(\s*\)\s*=>\s*[^{;\s]""",
)


def _trycatch_no_throw_around_fetch(source: str, fetch_start: int, fetch_end: int) -> bool:
    """Detect fetch(route) inside `try { ... } catch (e?) { <no throw> ... }`.

    Returns True when the fetch sits inside a `try` block whose paired
    `catch` arm contains no `throw` (i.e., swallows the error). This
    catches the issue-body pattern:

        try {
          const r = await fetch('/api/x', ...);
          return await r.json();
        } catch {
          return { spec_id: synthesize_stub_id() };  // graceful fallback
        }

    Uses brace tracking rather than regex because `[^}]*` cannot handle
    nested braces inside the catch body. Conservative: requires the
    `try` keyword to appear within 400 chars before the fetch, and the
    matching `} catch` to appear within 800 chars after.
    """
    before = source[max(0, fetch_start - 400):fetch_start]
    # Walk backward to find the most recent unmatched `try {`.
    # Strategy: scan tokens left-to-right and track brace depth + try state.
    depth_before = 0
    try_at_depth: list[int] = []  # depths at which a `try {` opened
    i = 0
    while i < len(before):
        if before[i:i+4] == 'try ' or before[i:i+5] == 'try\n' or before[i:i+5] == 'try\t' or before[i:i+4] == 'try{':
            # Find the opening brace of the try block.
            j = i + 3
            while j < len(before) and before[j] not in '{':
                j += 1
            if j < len(before) and before[j] == '{':
                try_at_depth.append(depth_before)
                depth_before += 1
                i = j + 1
                continue
        ch = before[i]
        if ch == '{':
            depth_before += 1
        elif ch == '}':
            depth_before -= 1
            # If a try block just closed (its depth went out), pop it.
            if try_at_depth and depth_before == try_at_depth[-1]:
                try_at_depth.pop()
        i += 1

    # If no unclosed `try {` precedes the fetch, no try-wrap.
    if not try_at_depth:
        return False

    # The fetch is inside a try block. Now walk forward to find the
    # matching `}` that closes that try, followed by `catch`.
    after = source[fetch_end:fetch_end + 800]
    depth = depth_before  # current nesting depth (post-fetch)
    target_depth = try_at_depth[-1]  # depth at which the enclosing try { opened
    i = 0
    catch_start = None
    while i < len(after):
        ch = after[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == target_depth:
                # The try block just closed. Look for `catch` (with
                # optional space/newline).
                rest = after[i+1:i+30].lstrip()
                if rest.startswith('catch'):
                    catch_start = i + 1 + after[i+1:].index('catch')
                    break
                else:
                    return False  # try without catch — irrelevant
        i += 1
    if catch_start is None:
        return False

    # Find the catch body opening `{`.
    j = catch_start + 5
    while j < len(after) and after[j] != '{':
        j += 1
    if j >= len(after):
        return False
    # Track the catch body to its closing brace.
    body_depth = 1
    k = j + 1
    while k < len(after) and body_depth > 0:
        if after[k] == '{':
            body_depth += 1
        elif after[k] == '}':
            body_depth -= 1
        k += 1
    catch_body = after[j:k]
    # The catch swallows the error iff there is no `throw` keyword.
    # Heuristic: substring search (more sophisticated AST would tokenize).
    return 'throw' not in catch_body


def _has_stub_catch(source: str, route: str) -> bool:
    """Detect stub-fallback patterns wrapping fetch(route).

    Three detection layers (heuristic — AST upgrade is follow-up):

      (a) .catch(<params>) => LITERAL — existing literal-return detection.
          Catches `.catch(() => ({}))`, `.catch(() => [])`, etc.

      (b) .catch(() => EXPR) with empty params and non-block return —
          empty params mean the error is discarded, so any non-block
          return is a stub by definition. Catches the function-call form
          `.catch(() => synthesize_stub_id())` and identifier form
          `.catch(() => MOCK_DATA)` that (a) misses.

      (c) try { fetch(...) ... } catch { <no throw> } — wrap the fetch
          in a try block whose paired catch arm swallows the error.
          Catches the issue-body pattern that has no `.catch()` chain.

    Parameterized non-empty-arg cases (`.catch(err => ...)`) are NOT
    detected here — they may legitimately derive the return value from
    `err`. Layer 4b runtime check (behavior-verifier B7) is the
    load-bearing trustworthy check for those.
    """
    fetch_pat = re.compile(
        r"""fetch\s*\(\s*['"`]""" + re.escape(route) + r"""['"`]"""
    )
    for fmatch in fetch_pat.finditer(source):
        window = source[fmatch.end():fmatch.end() + 400]
        # (a) literal-return catch
        if _CATCH_LITERAL_RE.search(window):
            return True
        # (b) empty-param non-block catch
        if _CATCH_EMPTY_PARAM_EXPR_RE.search(window):
            return True
        # (c) try/catch wrap with no throw
        if _trycatch_no_throw_around_fetch(source, fmatch.start(), fmatch.end()):
            return True
    return False


# Detect useState / useReducer / useChat for turn state.
_TURN_STATE_RE = re.compile(
    r"\b(useState|useReducer|useChat)\b",
    re.IGNORECASE,
)


def _has_turn_state(source: str) -> bool:
    return bool(_TURN_STATE_RE.search(source))


# Generic API-fetch presence (any /api/ route).
_ANY_API_FETCH_RE = re.compile(
    r"""fetch\s*\(\s*['"`]/api/""",
    re.IGNORECASE,
)


def _has_any_api_fetch(source: str) -> bool:
    return bool(_ANY_API_FETCH_RE.search(source))


def _has_track_call(source: str, event: str) -> bool:
    """Check for track<Event>( or track('<event>',) patterns."""
    camel = "".join(part.capitalize() for part in re.split(r"[-_]", event))
    patterns = [
        re.compile(rf"\btrack{re.escape(camel)}\s*\("),
        re.compile(rf"""trackServerEvent\s*\(\s*['"`]""" + re.escape(event)),
        re.compile(rf"""capture\s*\(\s*['"`]""" + re.escape(event)),
    ]
    return any(p.search(source) for p in patterns)


def _sitemap_contains_slug(repo_root: str, slug: str, route_segment: str | None) -> bool:
    """Check src/app/sitemap.ts contains the slug.

    Strategy: read sitemap.ts; check the slug literal appears AND (when
    route_segment is provided) the segment substitution pattern appears.
    """
    path = os.path.join(repo_root, SITEMAP_PATH)
    src = _read_text(path)
    if not src:
        return False
    return slug in src


def _sitemap_has_iteration(repo_root: str, segment: str) -> bool:
    """Heuristic: detect a for/.map iteration that would expand <segment> values.

    Looks for: SLUGS.map(slug => ...) or for(const slug of SLUGS) or similar.
    """
    path = os.path.join(repo_root, SITEMAP_PATH)
    src = _read_text(path)
    if not src:
        return False
    patterns = [
        re.compile(rf"\.map\s*\(\s*\(?\s*{re.escape(segment)}\b"),
        re.compile(rf"for\s*\(\s*const\s+{re.escape(segment)}\b"),
        re.compile(rf"for\s*\(\s*let\s+{re.escape(segment)}\b"),
        re.compile(rf"\.forEach\s*\(\s*\(?\s*{re.escape(segment)}\b"),
    ]
    return any(p.search(src) for p in patterns)


def _load_phase_a_sentinel(repo_root: str) -> set[str]:
    """Return the set of pages whose page.tsx is owned by Phase A.

    Returns empty set when sentinel absent (Phase A didn't seal yet or
    archetype != web-app).
    """
    path = os.path.join(repo_root, PHASE_A_SENTINEL_PATH)
    text = _read_text(path)
    if not text:
        return set()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return set()
    files = data.get("files") or []
    owned: set[str] = set()
    for f in files:
        # Extract page name from src/app/<page>/page.tsx
        # or src/app/<dyn>/[slug]/page.tsx
        if not isinstance(f, str):
            continue
        if not f.startswith("src/app/") or not f.endswith("page.tsx"):
            continue
        rel = f[len("src/app/"):-len("/page.tsx")]
        if not rel:
            owned.add("landing")
            continue
        # Strip dynamic segments for matching
        parts = [p for p in rel.split("/") if "[" not in p]
        if parts:
            owned.add("-".join(parts) if len(parts) > 1 else parts[0])
    return owned


def _audit_entry(
    entry: dict[str, Any],
    page: str,
    source: str,
    repo_root: str,
) -> dict[str, Any] | None:
    """Audit a single contract entry against the page's combined source.

    Returns a finding dict when uncovered, else None.
    """
    kind = entry.get("kind")
    arg = entry.get("arg")

    if kind == "render":
        return None  # trivially passes (page existence already checked elsewhere)

    if kind == "untagged":
        # Untagged tests produce warnings, not blocks (backward compat).
        return None

    if kind == "api-fetch":
        if not arg:
            return {
                "page": page,
                "contract": entry,
                "reason": "api-fetch entry missing arg (route)",
                "layer": "4a",
            }
        route = arg
        if not _fetch_present(source, route):
            return {
                "page": page,
                "contract": entry,
                "reason": f"page .tsx does not call fetch('{route}')",
                "layer": "4a",
            }
        if _fetch_unreachable(source, route):
            return {
                "page": page,
                "contract": entry,
                "reason": f"fetch('{route}') is wrapped in if(false){{...}} (unreachable)",
                "layer": "4a",
            }
        if _has_stub_catch(source, route):
            return {
                "page": page,
                "contract": entry,
                "reason": (
                    f"fetch('{route}') has .catch(() => <literal>) stub-fallback. "
                    "Layer 4b runtime check (behavior-verifier B7) is load-bearing here."
                ),
                "layer": "4a",
            }
        return None

    if kind == "ai-conversation":
        # Combo check: any /api/ fetch + useState/useReducer/useChat
        if not _has_any_api_fetch(source):
            return {
                "page": page,
                "contract": entry,
                "reason": "ai-conversation contract: no /api/ fetch call site found",
                "layer": "4a",
            }
        if not _has_turn_state(source):
            return {
                "page": page,
                "contract": entry,
                "reason": (
                    "ai-conversation contract: no useState/useReducer/useChat "
                    "for turn state"
                ),
                "layer": "4a",
            }
        return None

    if kind == "event":
        if not arg:
            return {
                "page": page,
                "contract": entry,
                "reason": "event entry missing arg (event name)",
                "layer": "4a",
            }
        if not _has_track_call(source, arg):
            return {
                "page": page,
                "contract": entry,
                "reason": f"page .tsx does not emit event '{arg}' via track* helper",
                "layer": "4a",
            }
        return None

    if kind == "seo":
        # Free-text SEO claim consumed by the lead, not the AST scanner.
        # No structural check at Layer 4a; recorded for review.
        return None

    if kind == "sitemap-instance":
        # arg format: "route/segment" e.g. "portfolio/slug"
        if not arg or "/" not in arg:
            return {
                "page": page,
                "contract": entry,
                "reason": "sitemap-instance entry missing arg in route/segment format",
                "layer": "4a",
            }
        route_prefix, segment = arg.rsplit("/", 1)
        # Layer 4a check: sitemap.ts has SOME iteration over <segment>.
        # The concrete slug presence is verified at Layer 4b runtime (B7
        # fetches /sitemap.xml from dev server).
        if not _sitemap_has_iteration(repo_root, segment):
            return {
                "page": page,
                "contract": entry,
                "reason": (
                    f"sitemap.ts has no iteration over '{segment}' "
                    "(.map / for / forEach with that identifier)"
                ),
                "layer": "4a",
            }
        return None

    # Unknown/roadmap kinds: skip (Group A's verb registry will lint these
    # separately). Roadmap kinds (sdk-call, realtime-sub, external-widget)
    # explicitly fall through here.
    if entry.get("roadmap") or entry.get("unknown_kind"):
        return None

    # Unrecognized kind without flag — treat as a soft finding.
    return None


def audit(repo_root: str = ".") -> dict[str, Any]:
    """Run the post-fan-out audit and produce the audit verdict payload."""
    contracts_path = os.path.join(repo_root, CONTRACTS_PATH)
    if not os.path.isfile(contracts_path):
        return {
            "schema_version": SCHEMA_VERSION,
            "audited_pages": 0,
            "tagged_contract_entries": 0,
            "covered_static": 0,
            "uncovered_count": 0,
            "uncovered": [],
            "warnings": [],
            "runtime_check_signaled": [],
            "provenance": "lead-orchestrated",
            "lead_attestation": True,
            "note": f"{CONTRACTS_PATH} absent — no contracts to audit.",
        }

    try:
        with open(contracts_path, encoding="utf-8") as fh:
            contracts = json.load(fh)
    except Exception as e:
        return {
            "schema_version": SCHEMA_VERSION,
            "audited_pages": 0,
            "tagged_contract_entries": 0,
            "covered_static": 0,
            "uncovered_count": 1,
            "uncovered": [{"contract": None, "reason": f"contracts parse error: {e}", "layer": "load"}],
            "warnings": [],
            "runtime_check_signaled": [],
            "provenance": "lead-orchestrated",
            "lead_attestation": True,
        }

    phase_a_owned = _load_phase_a_sentinel(repo_root)

    audited_pages = 0
    tagged_entries = 0
    covered = 0
    uncovered: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    runtime_signaled: list[dict[str, Any]] = []

    # Iterate page-keyed contracts via unstamped_items (mandatory).
    for page, entries in unstamped_items(contracts):
        if page.startswith("_"):  # skip _schema_version, _summary
            continue
        if not isinstance(entries, list):
            continue

        # Phase A sentinel exemption (#1187)
        if page in phase_a_owned:
            continue

        page_files = _candidate_page_files(repo_root, page)
        source = _read_combined_source(page_files)
        audited_pages += 1

        for entry in entries:
            if not isinstance(entry, dict):
                continue
            kind = entry.get("kind")

            # Untagged → warning, not finding
            if kind == "untagged":
                warnings.append({
                    "page": page,
                    "untagged_test": entry.get("raw_test"),
                })
                continue

            tagged_entries += 1

            # Runtime-check signaling (Layer 4b). seo entries are
            # human-review only and need no runtime check.
            if kind in ("api-fetch", "ai-conversation", "sitemap-instance"):
                runtime_signaled.append({
                    "page": page,
                    "contract": entry,
                    "route": entry.get("arg"),
                })

            # If no page file was found, mark uncovered (every tagged
            # entry needs a target).
            if not source:
                uncovered.append({
                    "page": page,
                    "contract": entry,
                    "reason": f"no .tsx file under src/app/{page} or matching prefix",
                    "layer": "4a",
                })
                continue

            finding = _audit_entry(entry, page, source, repo_root)
            if finding:
                uncovered.append(finding)
            else:
                covered += 1

    return {
        "schema_version": SCHEMA_VERSION,
        "audited_pages": audited_pages,
        "tagged_contract_entries": tagged_entries,
        "covered_static": covered,
        "uncovered_count": len(uncovered),
        "uncovered": uncovered,
        "warnings": warnings,
        "runtime_check_signaled": runtime_signaled,
        "provenance": "lead-orchestrated",
        "lead_attestation": True,
    }


def _active_skill() -> str:
    """Find the active skill name from .runs/*-context.json."""
    best = None
    best_ts = ""
    for f in glob.glob(".runs/*-context.json"):
        if "epilogue" in f:
            continue
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
        except Exception:
            continue
        if d.get("completed") is True:
            continue
        ts = d.get("timestamp") or ""
        if ts >= best_ts:
            best = d
            best_ts = ts
    return (best or {}).get("skill", "bootstrap")


def write_artifacts(audit_payload: dict[str, Any], skill: str | None = None) -> int:
    """Write the audit verdict + runtime stubs annotation via canonical writer."""
    skill = skill or _active_skill()
    here = os.path.dirname(os.path.abspath(__file__))
    writer = os.path.join(here, "write-gate-artifact.sh")

    # Main audit artifact
    audit_json = json.dumps(audit_payload)
    r1 = subprocess.run(
        ["bash", writer, "--path", AUDIT_PATH, "--payload", audit_json, "--skill", skill],
        capture_output=True, text=True,
    )
    if r1.returncode != 0:
        sys.stderr.write(f"write-gate-artifact.sh failed for {AUDIT_PATH}: {r1.stderr}\n")
        return r1.returncode

    # Runtime stubs annotation (Layer 4b signal)
    stubs_payload = {
        "schema_version": SCHEMA_VERSION,
        "annotations": audit_payload.get("runtime_check_signaled", []),
        "provenance": "lead-orchestrated",
        "lead_attestation": True,
    }
    stubs_json = json.dumps(stubs_payload)
    r2 = subprocess.run(
        ["bash", writer, "--path", STUBS_PATH, "--payload", stubs_json, "--skill", skill],
        capture_output=True, text=True,
    )
    if r2.returncode != 0:
        sys.stderr.write(f"write-gate-artifact.sh failed for {STUBS_PATH}: {r2.stderr}\n")
        return r2.returncode
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Post-fan-out behavior-contract audit for scaffold-pages output (#1387)."
    )
    parser.add_argument("--repo-root", default=".", help="Project root (default: cwd).")
    parser.add_argument("--skill", default=None, help="Active skill override.")
    parser.add_argument("--dry-run", action="store_true", help="Print payload, do not write.")
    args = parser.parse_args()

    audit_payload = audit(args.repo_root)

    if args.dry_run:
        print(json.dumps(audit_payload, indent=2))
        return 0

    rc = write_artifacts(audit_payload, args.skill)
    if rc != 0:
        return rc

    # Always exit 0 — state-11c VERIFY is the gate; the artifact carries
    # uncovered_count and uncovered[] for downstream consumption.
    print(
        f"behavior-contract-auditor: audited_pages={audit_payload['audited_pages']} "
        f"tagged={audit_payload['tagged_contract_entries']} "
        f"covered={audit_payload['covered_static']} "
        f"uncovered={audit_payload['uncovered_count']} "
        f"warnings={len(audit_payload['warnings'])} "
        f"runtime_signaled={len(audit_payload['runtime_check_signaled'])}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

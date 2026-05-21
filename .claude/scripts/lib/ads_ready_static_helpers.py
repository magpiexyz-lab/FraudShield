"""Pure helper functions for /ads-ready Layer A static checks."""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from check_project_name import main as cpn_main  # noqa: E402
from derive_pages import derive_scope_pages  # noqa: E402
from iterate_cross_db import _read_token, list_supabase_projects, normalize_name  # noqa: E402
from iterate_cross_railway_db import (  # noqa: E402
    _check_railway_auth,
    list_railway_projects,
)
import stripe_api  # noqa: E402
import vercel_api  # noqa: E402

try:
    import yaml
except ImportError:  # pragma: no cover - tests run with PyYAML installed
    yaml = None


POSTHOG_PLACEHOLDER = "phc_TEAM_KEY"
POSTHOG_PRIVATE_API_HOST = "https://us.posthog.com"
SOURCE_FALLBACK_FILES = [
    "src/lib/analytics.ts",
    "src/lib/analytics-server.ts",
    "src/app/route.ts",
    "site/index.html",
]

SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
ANALYTICS_TARGETS = {
    "src/lib/analytics.ts",
    "src/lib/analytics.tsx",
    "src/lib/events.ts",
    "src/lib/events.tsx",
}

RAW_POSTHOG_RE = re.compile(r"\bposthog\.(capture|identify|init|register|reset)\s*\(")
IMPORT_FROM_RE = re.compile(r"\bfrom\s+['\"]([^'\"]+)['\"]")
IMPORT_SIDE_EFFECT_RE = re.compile(r"\bimport\s+['\"]([^'\"]+)['\"]")
TRACK_RAW_RE = re.compile(r"\btrack\(\s*['\"]([^'\"]+)['\"]")
TRACK_WRAPPER_RE = re.compile(r"\btrack([A-Z][A-Za-z0-9_]*)\s*\(")
TRACKING_CALL_RE = re.compile(r"\b(?:track|identify|reset)\s*\(|\btrack[A-Z]\w+\s*\(")

POSTHOG_ENV_FALLBACK_RE = re.compile(
    r"process\.env\.NEXT_PUBLIC_POSTHOG_KEY\s*\?\?\s*['\"]([^'\"]+)['\"]"
)
SURFACE_ASSIGNMENT_RE = re.compile(
    r"(?:const|var|let)\s+(?:POSTHOG_KEY|key)\s*=\s*['\"]([^'\"]+)['\"]"
)
POSTHOG_INIT_RE = re.compile(r"posthog\.init\s*\(\s*['\"]([^'\"]+)['\"]")

SIGNUP_EVENT_NAMES = {
    "signup_complete",
    "signup_completed",
    "signup_started",
    "signup_start",
    "waitlist_signup",
    "waitlist_submit",
    "waitlist_submitted",
    "register_complete",
    "account_created",
}
SIGNUP_EVENT_RE = re.compile(r".*_signup_(complete|completed|started)$")


def _root(ctx: dict) -> Path:
    return Path(ctx.get("mvp_root", ".")).expanduser()


def _rel(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _path(ctx: dict, rel: str) -> Path:
    return _root(ctx) / rel


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _load_yaml_file(path: Path) -> dict:
    if yaml is None:
        return {}
    if not path.exists():
        return {}
    try:
        data = yaml.safe_load(_read_text(path)) or {}
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _experiment(ctx: dict) -> dict:
    return _load_yaml_file(_path(ctx, "experiment/experiment.yaml"))


def _events_yaml(ctx: dict) -> dict:
    return _load_yaml_file(_path(ctx, "experiment/EVENTS.yaml"))


def _iterate_cross_config(ctx: dict) -> dict:
    return _load_yaml_file(_path(ctx, "experiment/iterate-cross-config.yaml"))


def _mvp_name(ctx: dict) -> str:
    return str(_experiment(ctx).get("name") or "").strip()


def _archetype(ctx: dict) -> str:
    return str(_experiment(ctx).get("type") or "web-app").strip() or "web-app"


def _stack(ctx: dict) -> dict:
    stack = _experiment(ctx).get("stack") or {}
    return stack if isinstance(stack, dict) else {}


def _service_values(ctx: dict, key: str) -> list[str]:
    services = _stack(ctx).get("services") or []
    if not isinstance(services, list):
        return []
    values = []
    for service in services:
        if isinstance(service, dict) and service.get(key):
            values.append(str(service[key]))
    return values


def _stack_has_requirement(ctx: dict, requirement: str) -> bool:
    stack = _stack(ctx)
    if requirement in stack and stack.get(requirement):
        return True
    if str(stack.get(requirement) or ""):
        return True
    for value in stack.values():
        if isinstance(value, str) and value == requirement:
            return True
    for service_key in ("runtime", "hosting", "ui", "testing"):
        if requirement in _service_values(ctx, service_key):
            return True
    return False


def _read_env_file(root: Path, rel: str = ".env.local") -> dict[str, str]:
    path = root / rel
    if not path.exists():
        return {}
    env: dict[str, str] = {}
    for raw_line in _read_text(path).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def _is_excluded_source(root: Path, path: Path, include_events: bool = True) -> bool:
    rel = _rel(root, path)
    name = path.name
    parts = set(path.parts)
    if rel in {"src/lib/analytics.ts", "src/lib/analytics-server.ts"}:
        return True
    if include_events and rel == "src/lib/events.ts":
        return True
    if name.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")):
        return True
    if name.endswith(".stories.tsx"):
        return True
    if ".storybook" in parts or "__tests__" in parts or "__mocks__" in parts:
        return True
    return False


def _is_excluded_traversal_path(path: Path) -> bool:
    name = path.name
    parts = set(path.parts)
    if name.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")):
        return True
    if name.endswith(".stories.tsx"):
        return True
    if ".storybook" in parts or "__tests__" in parts or "__mocks__" in parts:
        return True
    return False


def _source_files(root: Path, include_events: bool = True) -> list[Path]:
    src = root / "src"
    if not src.exists():
        return []
    files = list(src.rglob("*.ts")) + list(src.rglob("*.tsx"))
    return [
        path
        for path in sorted(files)
        if path.is_file() and not _is_excluded_source(root, path, include_events)
    ]


def _pascal_case(event: str) -> str:
    return "".join(part.capitalize() for part in re.split(r"[_\-\s]+", event) if part)


def _snake_case(name: str) -> str:
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def _event_call_patterns(event: str) -> tuple[re.Pattern[str], re.Pattern[str]]:
    return (
        re.compile(rf"\btrack\(\s*['\"]{re.escape(event)}['\"]"),
        re.compile(rf"\btrack{re.escape(_pascal_case(event))}\s*\("),
    )


def _file_has_event_call(text: str, event: str) -> bool:
    raw, wrapper = _event_call_patterns(event)
    return bool(raw.search(text) or wrapper.search(text))


def _read_posthog_api_key() -> str:
    return open(os.path.expanduser("~/.posthog/personal-api-key")).read().strip()


def _read_vercel_project_link(root: Path) -> dict[str, str | None] | None:
    path = root / ".vercel" / "project.json"
    if not path.exists():
        return None
    try:
        data = json.loads(_read_text(path))
    except Exception:
        return None
    return {"projectId": data.get("projectId"), "orgId": data.get("orgId")}


def _vercel_identity(ctx: dict) -> tuple[str | None, str | None, str | None]:
    root = _root(ctx)
    link = _read_vercel_project_link(root)
    project_id = ctx.get("vercel_project_id")
    team_id = ctx.get("vercel_team_id")
    if link:
        project_id = project_id or link.get("projectId")
        team_id = team_id or link.get("orgId")
    if not project_id:
        project_id = _mvp_name(ctx) or None
    token = ctx.get("vercel_token") or vercel_api.read_vercel_token()
    return token, project_id, team_id


def _extract_source_fallbacks(root: Path) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for rel in SOURCE_FALLBACK_FILES:
        path = root / rel
        if not path.exists():
            continue
        text = _read_text(path)
        if rel in {"src/lib/analytics.ts", "src/lib/analytics-server.ts"}:
            matches = POSTHOG_ENV_FALLBACK_RE.findall(text)
        else:
            matches = SURFACE_ASSIGNMENT_RE.findall(text)
            if not matches:
                matches = POSTHOG_INIT_RE.findall(text)
        for value in matches:
            found.append((rel, value))
    return found


def _format_source_drift(root: Path) -> str:
    pairs = _extract_source_fallbacks(root)
    return ", ".join(f"{file}={_mask_secret(value)}" for file, value in pairs)


def resolve_production_posthog_key(ctx: dict) -> tuple[str | None, str, str | None]:
    """Resolve the production NEXT_PUBLIC_POSTHOG_KEY for an MVP.

    Returns (key, source_tag, resolved_file). See the /ads-ready plan for the
    six source tags and branch semantics.
    """
    root = _root(ctx)
    token, project_id, team_id = _vercel_identity(ctx)
    if token and project_id:
        result = vercel_api.get_vercel_env_var(
            token,
            project_id,
            team_id,
            "NEXT_PUBLIC_POSTHOG_KEY",
            target="production",
        )
        if isinstance(result, vercel_api.EnvResultError):
            return None, "vercel_env_error", None
        if isinstance(result, vercel_api.EnvResultFound):
            if result.value and result.value != POSTHOG_PLACEHOLDER:
                return result.value, "vercel_env_set", None
            return result.value, "vercel_env_empty_or_placeholder", None

    fallbacks = _extract_source_fallbacks(root)
    if not fallbacks:
        return None, "missing", None

    for file, value in fallbacks:
        if value == POSTHOG_PLACEHOLDER:
            return value, "source_fallback", file

    values = {value for _, value in fallbacks}
    if len(values) > 1:
        return None, "source_fallback_inconsistent", None

    file, value = fallbacks[0]
    return value, "source_fallback", file


def applies_if_iterate_cross_config_has_signup_events(ctx: dict) -> bool:
    mapping = (_iterate_cross_config(ctx).get("mvp_mappings") or {}).get(_mvp_name(ctx))
    if not isinstance(mapping, dict):
        return False
    events = mapping.get("signup_events") or []
    return isinstance(events, list) and bool(events)


def applies_if_stack_database_supabase(ctx: dict) -> bool:
    return _stack(ctx).get("database") == "supabase"


def applies_if_stack_database_railway(ctx: dict) -> bool:
    root = _root(ctx)
    if _stack(ctx).get("database") == "railway":
        return True
    if (root / "railway.json").exists():
        return True
    return "railway.app" in _read_env_file(root).get("DATABASE_URL", "")


def applies_if_stack_hosting_vercel(ctx: dict) -> bool:
    return "vercel" in _service_values(ctx, "hosting")


def applies_if_stack_payment_stripe(ctx: dict) -> bool:
    return _stack(ctx).get("payment") == "stripe"


def applies_if_events_yaml_exists(ctx: dict) -> bool:
    return _path(ctx, "experiment/EVENTS.yaml").exists()


def check_project_name_drift(ctx: dict) -> tuple[bool, str, str | None]:
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        rc = cpn_main(["--root", str(_root(ctx))])
    err = stderr.getvalue().strip()
    if rc == 0:
        return True, "PROJECT_NAME constants match experiment.yaml.name.", None
    if rc == 1:
        return (
            False,
            err or "PROJECT_NAME drift detected.",
            "PROJECT_NAME drift. Update the constant in the file(s) listed in stderr to match experiment.yaml.name.",
        )
    if rc == 2:
        return (
            False,
            "check_project_name returned environmental error (exit 2); see stderr"
            + (f": {err}" if err else ""),
            "Resolve the environmental issue (missing yaml, missing PyYAML) and re-run /ads-ready",
        )
    return False, f"check_project_name returned unexpected exit {rc}: {err}", "Report to template maintainer."


def check_no_posthog_placeholder(ctx: dict) -> tuple[bool, str, str | None]:
    key, source, resolved_file = resolve_production_posthog_key(ctx)
    if source in {"vercel_env_set", "source_fallback"} and key and key != POSTHOG_PLACEHOLDER:
        return True, f"PostHog key resolved from {source}.", None
    if source == "source_fallback_inconsistent":
        drift = _format_source_drift(_root(ctx))
        return (
            False,
            f"Active PostHog fallback values disagree across source files: {drift}.",
            f"Active PostHog fallback values disagree across source files: {drift}. All client+server analytics files must use the SAME team `phc_*` key (or all defer to Vercel production env). Sync them.",
        )
    if source == "vercel_env_empty_or_placeholder":
        return (
            False,
            "NEXT_PUBLIC_POSTHOG_KEY in Vercel production env is empty or placeholder.",
            "NEXT_PUBLIC_POSTHOG_KEY in Vercel production env is empty or placeholder. Set it to your team's real `phc_*` key in Vercel project settings (Production target).",
        )
    if source == "vercel_env_error":
        return (
            False,
            "Could not verify Vercel production env.",
            "Could not verify Vercel production env. Confirm `vercel login` and retry. Local .env.local does NOT count - production env is authoritative.",
        )
    if source == "source_fallback" and key == POSTHOG_PLACEHOLDER:
        return (
            False,
            f"Source file `{resolved_file}` still has the placeholder as its active PostHog fallback.",
            f"Source file `{resolved_file}` still has the `phc_TEAM_KEY` placeholder as its active PostHog fallback value. Replace the active fallback literal with the team's real `phc_*` key, OR set NEXT_PUBLIC_POSTHOG_KEY in Vercel production env. (Do NOT change any `POSTHOG_PLACEHOLDER` comparison constants - those exist intentionally for runtime misconfig detection.)",
        )
    return (
        False,
        "NEXT_PUBLIC_POSTHOG_KEY is not configured anywhere.",
        "NEXT_PUBLIC_POSTHOG_KEY is not configured in Vercel production env, nor as a source-level fallback in any of: src/lib/analytics.ts, src/lib/analytics-server.ts, src/app/route.ts, site/index.html. Set it in Vercel production env.",
    )


def _load_tsconfig_paths(root: Path) -> list[tuple[str, str]]:
    path = root / "tsconfig.json"
    if not path.exists():
        return [("@/*", "src/*")]
    try:
        data = json.loads(_read_text(path))
    except Exception:
        return [("@/*", "src/*")]
    raw_paths = ((data.get("compilerOptions") or {}).get("paths") or {})
    paths: list[tuple[str, str]] = [("@/*", "src/*")]
    if isinstance(raw_paths, dict):
        for alias, targets in raw_paths.items():
            if not isinstance(targets, list):
                continue
            for target in targets:
                if isinstance(target, str):
                    paths.append((alias, target))
    return paths


def _apply_alias(spec: str, aliases: list[tuple[str, str]]) -> str | None:
    for alias, target in aliases:
        if "*" in alias:
            prefix, suffix = alias.split("*", 1)
            if spec.startswith(prefix) and spec.endswith(suffix):
                middle = spec[len(prefix) : len(spec) - len(suffix) if suffix else len(spec)]
                return target.replace("*", middle)
        elif spec == alias or spec.startswith(alias.rstrip("/") + "/"):
            rest = spec[len(alias) :].lstrip("/")
            return str(Path(target) / rest)
    if spec.startswith("@/"):
        return "src/" + spec[2:]
    return None


def _probe_module(base: Path) -> Path | None:
    candidates: list[Path] = []
    if base.suffix in SOURCE_EXTENSIONS and base.exists():
        candidates.append(base)
    for ext in SOURCE_EXTENSIONS:
        candidates.append(base.with_suffix(ext))
    for ext in SOURCE_EXTENSIONS:
        candidates.append(base / f"index{ext}")
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _resolve_import(root: Path, importer: Path, spec: str, aliases: list[tuple[str, str]] | None = None) -> Path | None:
    aliases = aliases or _load_tsconfig_paths(root)
    base: Path | None = None
    if spec.startswith("."):
        base = (importer.parent / spec).resolve()
    else:
        alias_target = _apply_alias(spec, aliases)
        if alias_target:
            base = (root / alias_target).resolve()
    if base is None:
        return None
    resolved = _probe_module(base)
    if not resolved:
        return None
    try:
        resolved.resolve().relative_to((root / "src").resolve())
    except ValueError:
        return None
    if _is_excluded_traversal_path(resolved):
        return None
    return resolved


def _import_specs(text: str) -> list[str]:
    return IMPORT_FROM_RE.findall(text) + IMPORT_SIDE_EFFECT_RE.findall(text)


def _landing_roots(ctx: dict) -> list[Path]:
    root = _root(ctx)
    roots: list[Path] = []
    default_page = root / "src/app/page.tsx"
    if default_page.exists():
        roots.append(default_page)
    elif (root / "src/app/layout.tsx").exists():
        roots.append(root / "src/app/layout.tsx")

    for page in derive_scope_pages(_experiment(ctx)):
        page = str(page).strip("/")
        if not page or page in {"landing", "home"}:
            candidate = root / "src/app/page.tsx"
        else:
            candidate = root / "src/app" / page / "page.tsx"
        if candidate.exists() and candidate not in roots:
            roots.append(candidate)

    if not roots:
        roots.extend(sorted((root / "src/app").rglob("page.tsx")) if (root / "src/app").exists() else [])
    return roots


def check_analytics_module_wired(ctx: dict) -> tuple[bool, str, str | None]:
    root = _root(ctx)
    aliases = _load_tsconfig_paths(root)
    queue = list(_landing_roots(ctx))
    visited: set[Path] = set()
    cap = 200

    while queue and len(visited) < cap:
        current = queue.pop(0).resolve()
        if current in visited or not current.exists():
            continue
        visited.add(current)
        text = _read_text(current)
        imported_targets: list[Path] = []
        for spec in _import_specs(text):
            resolved = _resolve_import(root, current, spec, aliases)
            if not resolved:
                continue
            imported_targets.append(resolved)
            if resolved.resolve() not in visited and len(visited) + len(queue) < cap:
                queue.append(resolved)
        for target in imported_targets:
            if _rel(root, target) in ANALYTICS_TARGETS and TRACKING_CALL_RE.search(text):
                return (
                    True,
                    f"{_rel(root, current)} imports {_rel(root, target)} and calls a tracking function.",
                    None,
                )

    return (
        False,
        f"No reachable landing component imports analytics/events and calls a tracking function (visited {len(visited)} files).",
        "No file reachable from the landing page's component tree (BFS visited-set, up to 200 files) imports an analytics module AND calls a tracking function. Add `import { trackLandingViewed } from '@/lib/events'` to src/app/page.tsx (or to a colocated landing component) and call it on mount.",
    )


def check_no_raw_capture(ctx: dict) -> tuple[bool, str, str | None]:
    root = _root(ctx)
    offenders = []
    for path in _source_files(root):
        text = _read_text(path)
        if RAW_POSTHOG_RE.search(text):
            offenders.append(_rel(root, path))
    if not offenders:
        return True, "No raw posthog.* bypass calls found outside analytics wrappers.", None
    listed = ", ".join(offenders)
    return (
        False,
        f"Raw posthog.* calls found in: {listed}.",
        f"Replace raw posthog.<method>() calls with the corresponding wrapper from @/lib/analytics (track/identify/reset). Direct posthog.* is only allowed inside src/lib/analytics{{,-server}}.ts. File(s): {listed}.",
    )


def _signup_events_from_config(ctx: dict) -> list[str]:
    mappings = _iterate_cross_config(ctx).get("mvp_mappings") or {}
    mapping = mappings.get(_mvp_name(ctx)) if isinstance(mappings, dict) else None
    if not isinstance(mapping, dict):
        return []
    events = mapping.get("signup_events") or []
    return [str(event) for event in events] if isinstance(events, list) else []


def check_signup_events_implemented(ctx: dict) -> tuple[bool, str, str | None]:
    events = _signup_events_from_config(ctx)
    if not events:
        return True, "No iterate-cross signup_events configured for this MVP.", None
    root = _root(ctx)
    files = _source_files(root)
    missing = []
    for event in events:
        if not any(_file_has_event_call(_read_text(path), event) for path in files):
            missing.append(event)
    if not missing:
        return True, "All iterate-cross signup_events have call sites.", None
    event = missing[0]
    return (
        False,
        f"Missing call site for signup event `{event}`.",
        f"Event '{event}' is in mvp_mappings.{_mvp_name(ctx)}.signup_events but no call site invokes track('{event}') or track{_pascal_case(event)}(...) outside src/lib/events.ts. Add the call to the signup handler.",
    )


def _mask_secret(value: str | None) -> str:
    if not value:
        return "<empty>"
    if len(value) <= 10:
        return value
    return value[:6] + "..." + value[-4:]


def _posthog_get(url: str, api_key: str) -> dict:
    r = subprocess.run(
        ["curl", "-s", "-H", f"Authorization: Bearer {api_key}", url],
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        raise RuntimeError(f"PostHog API failed: {r.stderr[:200]}")
    try:
        data = json.loads(r.stdout)
    except Exception as exc:
        raise RuntimeError(f"malformed PostHog response: {exc}") from exc
    if isinstance(data, dict) and str(data.get("detail", "")).lower().startswith("authentication"):
        raise PermissionError("PostHog token lacks Organization Read / Project Read scope.")
    return data if isinstance(data, dict) else {}


def _next_url(host: str, url: str | None) -> str | None:
    if not url:
        return None
    if url.startswith("http"):
        return url
    return host.rstrip("/") + "/" + url.lstrip("/")


def _list_posthog_projects(api_key: str, host: str = POSTHOG_PRIVATE_API_HOST) -> list[dict]:
    projects: list[dict] = []
    org_url: str | None = f"{host.rstrip()}/api/organizations/"
    while org_url:
        org_page = _posthog_get(org_url, api_key)
        for org in org_page.get("results") or []:
            if not isinstance(org, dict) or not org.get("id"):
                continue
            proj_url: str | None = f"{host.rstrip()}/api/organizations/{org['id']}/projects/"
            while proj_url:
                proj_page = _posthog_get(proj_url, api_key)
                for project in proj_page.get("results") or []:
                    if isinstance(project, dict):
                        projects.append(project)
                proj_url = _next_url(host, proj_page.get("next"))
        org_url = _next_url(host, org_page.get("next"))
    return projects


def _posthog_source_failure(source: str, resolved_file: str | None) -> tuple[bool, str, str | None]:
    if source == "source_fallback_inconsistent":
        return (
            False,
            "PostHog source fallback values are inconsistent.",
            "Sync active PostHog fallback literals across client and server source files before validating team ownership.",
        )
    if source == "vercel_env_empty_or_placeholder":
        return (
            False,
            "NEXT_PUBLIC_POSTHOG_KEY in Vercel production env is empty or placeholder.",
            "Set NEXT_PUBLIC_POSTHOG_KEY in Vercel production env to the team's real PostHog key.",
        )
    if source == "vercel_env_error":
        return (
            False,
            "Could not verify Vercel production env for NEXT_PUBLIC_POSTHOG_KEY.",
            "Confirm `vercel login` and retry. Do not rely on local .env.local for ads readiness.",
        )
    if source == "missing":
        return (
            False,
            "NEXT_PUBLIC_POSTHOG_KEY is not configured.",
            "Set NEXT_PUBLIC_POSTHOG_KEY in Vercel production env, or add a source fallback in the analytics file.",
        )
    if resolved_file:
        return (
            False,
            f"`{resolved_file}` still uses the phc_TEAM_KEY placeholder.",
            f"Replace the active fallback literal in `{resolved_file}` with the team's real `phc_*` key.",
        )
    return False, "PostHog key could not be resolved.", "Configure NEXT_PUBLIC_POSTHOG_KEY."


def _server_key_result(ctx: dict) -> Any:
    token, project_id, team_id = _vercel_identity(ctx)
    if not token or not project_id:
        return vercel_api.EnvResultAbsent()
    return vercel_api.get_vercel_env_var(
        token,
        project_id,
        team_id,
        "POSTHOG_SERVER_KEY",
        target="production",
    )


def check_posthog_team_key(ctx: dict) -> tuple[bool, str, str | None]:
    key, source, resolved_file = resolve_production_posthog_key(ctx)
    if source not in {"vercel_env_set", "source_fallback"} or not key or key == POSTHOG_PLACEHOLDER:
        return _posthog_source_failure(source, resolved_file)

    try:
        api_key = _read_posthog_api_key()
    except Exception:
        return (
            False,
            "PostHog personal API key is missing.",
            "Save your PostHog personal API key to ~/.posthog/personal-api-key (see iterate-cross state-x0). For /ads-ready, the token needs scopes: Organization Read, Project Read.",
        )

    try:
        projects = _list_posthog_projects(api_key, str(ctx.get("posthog_api_host") or POSTHOG_PRIVATE_API_HOST))
    except PermissionError as exc:
        return False, str(exc), "Create a PostHog personal API key with Organization Read and Project Read scopes."
    except Exception as exc:
        return False, f"PostHog project discovery failed: {exc}", "Confirm PostHog API token scopes and retry."

    project_names = [str(p.get("name") or p.get("id") or "<unnamed>") for p in projects]
    client_project = next((p for p in projects if p.get("api_token") == key), None)
    if client_project is None:
        expected = ", ".join(project_names) or "<no accessible projects>"
        if source == "source_fallback":
            fix = (
                f"MVP's NEXT_PUBLIC_POSTHOG_KEY (from `{resolved_file}`'s source-level fallback) does not match any project accessible by your PostHog account. Expected one of: {expected}. Update the fallback constant in `{resolved_file}`, OR set NEXT_PUBLIC_POSTHOG_KEY in Vercel production env."
            )
        else:
            fix = (
                f"MVP's NEXT_PUBLIC_POSTHOG_KEY (from Vercel production env) does not match any project accessible by your PostHog account (across all orgs). Expected one of: {expected}. Update the Vercel env var to a team-project key, OR transfer this Vercel project to the team account."
            )
        return False, f"Resolved PostHog key {_mask_secret(key)} is not among team projects: {expected}.", fix

    server_result = _server_key_result(ctx)
    if isinstance(server_result, vercel_api.EnvResultError):
        return (
            False,
            f"Could not verify POSTHOG_SERVER_KEY in Vercel production env: {server_result.reason}",
            "Fix Vercel auth/API access and re-run /ads-ready; server-side PostHog attribution cannot be verified on API error.",
        )
    if isinstance(server_result, vercel_api.EnvResultFound):
        server_value = server_result.value
        if server_value == "":
            return (
                False,
                "POSTHOG_SERVER_KEY is set to empty string in Vercel production env.",
                "POSTHOG_SERVER_KEY is set to empty string in Vercel production env. JavaScript `??` does NOT fall through on empty string, so server-side PostHog events will fail. Either unset POSTHOG_SERVER_KEY (preferred) or set it to a real team key.",
            )
        if server_value == POSTHOG_PLACEHOLDER:
            return (
                False,
                "POSTHOG_SERVER_KEY is set to the placeholder `phc_TEAM_KEY` in Vercel production env.",
                "POSTHOG_SERVER_KEY is set to the placeholder `phc_TEAM_KEY` in Vercel production env. Server events will go to a no-op project. Unset POSTHOG_SERVER_KEY or set it to a real team key.",
            )
        server_project = next((p for p in projects if p.get("api_token") == server_value), None)
        if server_project is None or server_project.get("api_token") != client_project.get("api_token"):
            client_name = str(client_project.get("name") or client_project.get("id") or "<client project>")
            server_name = (
                str(server_project.get("name") or server_project.get("id"))
                if server_project
                else "<no accessible team project>"
            )
            return (
                False,
                f"POSTHOG_SERVER_KEY ({_mask_secret(server_value)}) targets a different PostHog project than NEXT_PUBLIC_POSTHOG_KEY ({_mask_secret(key)}).",
                f"POSTHOG_SERVER_KEY (`{_mask_secret(server_value)}`) targets a different PostHog project than NEXT_PUBLIC_POSTHOG_KEY (`{_mask_secret(key)}`). Client events go to `{client_name}`, server events go to `{server_name}` - funnel attribution breaks. Set POSTHOG_SERVER_KEY to the same key as NEXT_PUBLIC_POSTHOG_KEY, or unset it.",
            )

    return (
        True,
        f"Resolved PostHog key matches team project `{client_project.get('name') or client_project.get('id')}`.",
        None,
    )


def check_supabase_team_org(ctx: dict) -> tuple[bool, str, str | None]:
    root = _root(ctx)
    supabase_url = _read_env_file(root).get("NEXT_PUBLIC_SUPABASE_URL", "")
    match = re.search(r"https://([a-zA-Z0-9-]+)\.supabase\.co", supabase_url)
    if not match:
        return False, "NEXT_PUBLIC_SUPABASE_URL is missing from .env.local.", "Set NEXT_PUBLIC_SUPABASE_URL for the team Supabase project."
    project_ref = match.group(1)
    try:
        token = _read_token()
        projects = list_supabase_projects(token)
    except SystemExit as exc:
        return False, str(exc), "Run `supabase login`."
    except Exception as exc:
        return False, f"Supabase project list failed: {exc}", "Run `supabase login` and retry."
    if any(p.get("id") == project_ref for p in projects):
        return True, f"Supabase project `{project_ref}` is accessible by the operator token.", None
    return (
        False,
        f"Supabase project `{project_ref}` is not accessible by the operator token.",
        f"Supabase project {project_ref} is not accessible by your token (likely in a personal org). Transfer to team org or invite our shared-org token's account.",
    )


def _railway_project_id(root: Path) -> str | None:
    path = root / "railway.json"
    if not path.exists():
        return None
    try:
        data = json.loads(_read_text(path))
    except Exception:
        return None
    return data.get("projectId") or data.get("project")


def check_railway_team_workspace(ctx: dict) -> tuple[bool, str, str | None]:
    auth_error = _check_railway_auth()
    if auth_error:
        return False, auth_error, "Run `! railway login`."
    root = _root(ctx)
    project_id = _railway_project_id(root)
    projects = list_railway_projects()
    if project_id and any(p.get("id") == project_id for p in projects):
        return True, f"Railway project `{project_id}` is accessible.", None
    name_norm = normalize_name(_mvp_name(ctx))
    for project in projects:
        if name_norm and normalize_name(str(project.get("name") or "")) == name_norm:
            return True, f"Railway project `{project.get('name')}` is accessible.", None
    return (
        False,
        "Railway project is not accessible in the operator's workspace.",
        "Railway project not in your team workspace. Transfer to team workspace or accept the invite.",
    )


def check_vercel_team_account(ctx: dict) -> tuple[bool, str, str | None]:
    token = vercel_api.read_vercel_token()
    if not token:
        return False, "Vercel CLI token is missing.", "Run `vercel login`."
    link = _read_vercel_project_link(_root(ctx))
    if link and link.get("projectId"):
        team_id = link.get("orgId")
        project_id_or_name = str(link["projectId"])
    else:
        team_id = None
        project_id_or_name = _mvp_name(ctx)
    project = vercel_api.find_project(token, team_id, project_id_or_name)
    if project:
        return True, f"Vercel project `{project_id_or_name}` is accessible in team scope.", None
    return (
        False,
        f"Vercel project `{project_id_or_name}` is not in operator team scope.",
        f"Vercel project '{project_id_or_name}' is not in your team scope (likely a personal Vercel account). Transfer to team Vercel account, or re-run `vercel link` against the team's project.",
    )


def check_stripe_team_account(ctx: dict) -> tuple[bool, str, str | None]:
    operator_key = stripe_api.read_stripe_key_from_config()
    if not operator_key:
        return False, "Stripe CLI auth is missing.", "Run `stripe login`."
    mvp_key = _read_env_file(_root(ctx)).get("STRIPE_SECRET_KEY")
    if not mvp_key:
        return False, "STRIPE_SECRET_KEY is missing for a Stripe MVP.", "Set STRIPE_SECRET_KEY in Vercel env."
    operator_account = stripe_api.get_account_id(operator_key)
    mvp_account = stripe_api.get_account_id(mvp_key)
    if not operator_account or not mvp_account:
        return False, "Could not resolve Stripe account IDs.", "Confirm Stripe API keys and retry."
    if operator_account == mvp_account:
        return True, f"Stripe account `{mvp_account}` matches the operator account.", None
    return (
        False,
        f"MVP Stripe account `{mvp_account}` differs from operator account `{operator_account}`.",
        f"MVP's STRIPE_SECRET_KEY resolves to account {mvp_account} but operator's team Stripe account is {operator_account}. Update Vercel env var.",
    )


def _events_map(ctx: dict) -> dict[str, dict]:
    events = _events_yaml(ctx).get("events") or {}
    if isinstance(events, dict):
        return {str(k): (v if isinstance(v, dict) else {}) for k, v in events.items()}
    if isinstance(events, list):
        out = {}
        for item in events:
            if isinstance(item, dict) and item.get("name"):
                out[str(item["name"])] = item
        return out
    return {}


def _event_applies(ctx: dict, event_config: dict) -> bool:
    requires = event_config.get("requires") or []
    if isinstance(requires, str):
        requires = [requires]
    if any(not _stack_has_requirement(ctx, str(req)) for req in requires):
        return False
    archetypes = event_config.get("archetypes") or []
    if isinstance(archetypes, str):
        archetypes = [archetypes]
    if archetypes and _archetype(ctx) not in [str(a) for a in archetypes]:
        return False
    return True


def _filtered_events(ctx: dict) -> set[str]:
    return {
        name
        for name, config in _events_map(ctx).items()
        if _event_applies(ctx, config)
    }


def check_events_yaml_all_implemented(ctx: dict) -> tuple[bool, str, str | None]:
    events = sorted(_filtered_events(ctx))
    if not events:
        return True, "EVENTS.yaml has no applicable events.", None
    root = _root(ctx)
    files = _source_files(root)
    missing = []
    for event in events:
        if not any(_file_has_event_call(_read_text(path), event) for path in files):
            missing.append(event)
    if not missing:
        return True, "All applicable EVENTS.yaml events have implementation call sites.", None
    event = missing[0]
    return (
        False,
        f"Event `{event}` is declared in EVENTS.yaml but has no call site.",
        f"Event '{event}' declared in EVENTS.yaml but no call site invokes track('{event}') or track{_pascal_case(event)}(...) outside src/lib/events.ts. Add the call to the page/component that triggers this event, or remove the event from EVENTS.yaml.",
    )


def _tracked_events_in_code(root: Path) -> list[tuple[str, str]]:
    tracked: list[tuple[str, str]] = []
    for path in _source_files(root):
        text = _read_text(path)
        rel = _rel(root, path)
        for match in TRACK_RAW_RE.finditer(text):
            tracked.append((match.group(1), rel))
        for match in TRACK_WRAPPER_RE.finditer(text):
            wrapper = match.group(1)
            if wrapper == "ServerEvent":
                continue
            tracked.append((_snake_case(wrapper), rel))
    return tracked


def check_no_unauthorized_track_calls(ctx: dict) -> tuple[bool, str, str | None]:
    allowed = _filtered_events(ctx)
    for event, rel in _tracked_events_in_code(_root(ctx)):
        if event not in allowed:
            return (
                False,
                f"Event `{event}` is tracked in code but not declared in EVENTS.yaml ({rel}).",
                f"Event '{event}' tracked in code (file {rel}) but not declared in EVENTS.yaml. Add it to EVENTS.yaml `events:` map (with proper funnel_stage + requires/archetypes), or remove the track() call.",
            )
    return True, "No track() calls outside EVENTS.yaml.", None


def _is_signup_event(event: str) -> bool:
    if event in SIGNUP_EVENT_NAMES:
        return True
    if event.startswith("early_access_"):
        return True
    return bool(SIGNUP_EVENT_RE.match(event))


def _signup_tracks(text: str) -> list[str]:
    events = []
    for match in TRACK_RAW_RE.finditer(text):
        event = match.group(1)
        if _is_signup_event(event):
            events.append(event)
    for match in TRACK_WRAPPER_RE.finditer(text):
        event = _snake_case(match.group(1))
        if _is_signup_event(event):
            events.append(event)
    return events


def _signup_search_roots(root: Path) -> list[Path]:
    paths: list[Path] = []
    for rel in ("src/app", "src/components", "src/hooks"):
        base = root / rel
        if base.exists():
            paths.extend(list(base.rglob("*.ts")) + list(base.rglob("*.tsx")))
    lib = root / "src/lib"
    if lib.exists():
        paths.extend(list(lib.glob("auth*.ts")) + list(lib.glob("auth*.tsx")))
    return [p for p in sorted(set(paths)) if p.is_file() and not _is_excluded_source(root, p)]


def _imports_auth_utility(spec: str) -> bool:
    return bool(
        re.match(r"@/(lib/auth|hooks/use-auth|hooks/use-supabase|lib/supabase)", spec)
        or re.match(r"\.{1,2}/.*(auth|use-auth|use-supabase|supabase)", spec)
    )


def check_identify_in_signup(ctx: dict) -> tuple[bool, str, str | None]:
    root = _root(ctx)
    aliases = _load_tsconfig_paths(root)
    files = _signup_search_roots(root)
    signup_files: list[tuple[Path, str]] = []
    for path in files:
        text = _read_text(path)
        events = _signup_tracks(text)
        if not events:
            continue
        event = events[0]
        signup_files.append((path, event))
        if re.search(r"\bidentify\s*\(", text):
            return True, f"{_rel(root, path)} tracks `{event}` and calls identify().", None
        for spec in _import_specs(text):
            if not _imports_auth_utility(spec):
                continue
            resolved = _resolve_import(root, path, spec, aliases)
            if resolved and re.search(r"\bidentify\s*\(", _read_text(resolved)):
                return (
                    True,
                    f"{_rel(root, path)} tracks `{event}` and imports identify-capable auth utility {_rel(root, resolved)}.",
                    None,
                )
    if signup_files:
        path, event = signup_files[0]
        return (
            False,
            f"{_rel(root, path)} tracks signup event `{event}` but no identify() call is reachable.",
            f"File {_rel(root, path)} tracks signup event '{event}' but no identify() call is reachable from this file (neither in-file nor via imported auth utility). Without identify(), the anon->signed-in distinct_id link breaks. Add `identify(user.id)` to the signup handler OR ensure the imported auth utility calls it on session creation.",
        )
    return (
        False,
        "No signup-shaped tracking event was found.",
        "Add a signup completion tracking event and call `identify(user.id)` when the user signs up.",
    )


def check_1(ctx: dict) -> tuple[bool, str, str | None]:
    return check_project_name_drift(ctx)


def check_2(ctx: dict) -> tuple[bool, str, str | None]:
    return check_no_posthog_placeholder(ctx)


def check_3(ctx: dict) -> tuple[bool, str, str | None]:
    return check_analytics_module_wired(ctx)


def check_4(ctx: dict) -> tuple[bool, str, str | None]:
    return check_no_raw_capture(ctx)


def check_5(ctx: dict) -> tuple[bool, str, str | None]:
    return check_signup_events_implemented(ctx)


def check_6(ctx: dict) -> tuple[bool, str, str | None]:
    return check_posthog_team_key(ctx)


def check_7(ctx: dict) -> tuple[bool, str, str | None]:
    return check_supabase_team_org(ctx)


def check_8(ctx: dict) -> tuple[bool, str, str | None]:
    return check_railway_team_workspace(ctx)


def check_9(ctx: dict) -> tuple[bool, str, str | None]:
    return check_vercel_team_account(ctx)


def check_10(ctx: dict) -> tuple[bool, str, str | None]:
    return check_stripe_team_account(ctx)


def check_11(ctx: dict) -> tuple[bool, str, str | None]:
    return check_events_yaml_all_implemented(ctx)


def check_12(ctx: dict) -> tuple[bool, str, str | None]:
    return check_no_unauthorized_track_calls(ctx)


def check_13(ctx: dict) -> tuple[bool, str, str | None]:
    return check_identify_in_signup(ctx)

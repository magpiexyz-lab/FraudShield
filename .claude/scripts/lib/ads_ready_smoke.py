#!/usr/bin/env python3
"""Layer B entry point for /ads-ready live PostHog smoke checks."""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ads_ready_static_helpers as H  # noqa: E402
import vercel_api  # noqa: E402
from gclid_filter import SYNTHETIC_GCLID_PREFIX  # noqa: E402
from iterate_cross_posthog_batch import _posthog_query  # noqa: E402


CHECK_20_NAME = "Synthetic gclid arrives at PostHog"
CHECK_21_NAME = "Golden-path landing event fires"
CHECK_22_NAME = "No double-firing of critical events"
SMOKE_DIR = Path(".runs") / "_ads_ready_smoke_dir"


class SmokeSetupError(RuntimeError):
    """Setup problem that should become a diagnostic result, not a crash."""


def _utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _root(ctx: dict[str, Any]) -> Path:
    return Path(ctx.get("mvp_root") or ".").expanduser()


def _read_json(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data if isinstance(data, dict) else {}


def _write_json(path: str, output: dict[str, Any]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        json.dump(output, fh, indent=2)
        fh.write("\n")


def _check(
    check_id: int,
    name: str,
    passed: bool | None,
    details: str,
    fix: str | None,
    skipped: bool = False,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": check_id,
        "name": name,
        "applicable": True,
        "passed": passed,
        "details": details,
        "fix": fix,
    }
    if skipped:
        result["skipped"] = True
    return result


def _result_output(
    checks: list[dict[str, Any]],
    *,
    deploy_url: str | None = None,
    synthetic_gclid: str | None = None,
    skipped: bool = False,
    skip_reason: str | None = None,
) -> dict[str, Any]:
    failed = [
        r
        for r in checks
        if r.get("applicable") is True
        and r.get("skipped") is not True
        and r.get("passed") is not True
    ]
    passed = [r for r in checks if r.get("passed") is True]
    skipped_checks = [r for r in checks if r.get("skipped") is True]
    output: dict[str, Any] = {
        "skill": "ads-ready",
        "layer": "B",
        "timestamp": _utc_now(),
        "checks": checks,
        "overall_pass": None if skipped else len(failed) == 0,
        "applicable_count": len(checks),
        "passed_count": len(passed),
        "failed_count": len(failed),
        "skipped_count": len(skipped_checks),
    }
    if deploy_url:
        output["deploy_url"] = deploy_url
    if synthetic_gclid:
        output["synthetic_gclid"] = synthetic_gclid
    if skipped:
        output["skipped"] = True
    if skip_reason:
        output["skip_reason"] = skip_reason
    return output


def _write_result(path: str, output: dict[str, Any]) -> None:
    _write_json(path, output)
    print_summary(output, stream=sys.stderr)


def write_skipped(path: str, reason: str = "static_only flag set") -> None:
    checks = [
        _check(20, CHECK_20_NAME, None, f"Skipped: {reason}", None, skipped=True),
        _check(21, CHECK_21_NAME, None, f"Skipped: {reason}", None, skipped=True),
        _check(22, CHECK_22_NAME, None, f"Skipped: {reason}", None, skipped=True),
    ]
    output = _result_output(
        checks,
        skipped=True,
        skip_reason=f"{reason}; Layer B not run",
    )
    _write_result(path, output)
    print(
        "Layer B SKIPPED (--static-only). DO NOT launch ads without running full /ads-ready.",
        file=sys.stderr,
    )


def write_failed(
    path: str,
    details: str,
    fix: str | None,
    *,
    deploy_url: str | None = None,
    synthetic_gclid: str | None = None,
) -> None:
    checks = [
        _check(20, CHECK_20_NAME, False, details, fix),
        _check(
            21,
            CHECK_21_NAME,
            None,
            "Skipped because Layer B setup failed.",
            None,
            skipped=True,
        ),
        _check(
            22,
            CHECK_22_NAME,
            None,
            "Skipped because Layer B setup failed.",
            None,
            skipped=True,
        ),
    ]
    _write_result(
        path,
        _result_output(
            checks,
            deploy_url=deploy_url,
            synthetic_gclid=synthetic_gclid,
        ),
    )


def print_summary(output: dict[str, Any], stream=sys.stderr) -> None:
    if output.get("skipped") is True:
        status = "SKIPPED"
    else:
        status = "PASS" if output.get("overall_pass") is True else "FAIL"
    print(
        "ads-ready Layer B {status}: {passed}/{applicable} passed, "
        "{failed} failed, {skipped} skipped".format(
            status=status,
            passed=output.get("passed_count", 0),
            applicable=output.get("applicable_count", 0),
            failed=output.get("failed_count", 0),
            skipped=output.get("skipped_count", 0),
        ),
        file=stream,
    )
    for result in output.get("checks", []):
        if result.get("skipped") is True or result.get("passed") is True:
            continue
        print(f"- Check {result.get('id')} {result.get('name')}: {result.get('details')}", file=stream)
        print(f"  fix: {result.get('fix') or 'No fix provided.'}", file=stream)


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _experiment(ctx: dict[str, Any]) -> dict[str, Any]:
    return _load_yaml(_root(ctx) / "experiment" / "experiment.yaml")


def _mvp_name(ctx: dict[str, Any]) -> str:
    return str(_experiment(ctx).get("name") or "").strip()


def _events_map(ctx: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = _load_yaml(_root(ctx) / "experiment" / "EVENTS.yaml").get("events") or {}
    if isinstance(raw, dict):
        return {str(name): (cfg if isinstance(cfg, dict) else {}) for name, cfg in raw.items()}
    if isinstance(raw, list):
        events = {}
        for item in raw:
            if isinstance(item, dict) and item.get("name"):
                events[str(item["name"])] = item
        return events
    return {}


def _stack(ctx: dict[str, Any]) -> dict[str, Any]:
    stack = _experiment(ctx).get("stack") or {}
    return stack if isinstance(stack, dict) else {}


def _service_values(ctx: dict[str, Any], key: str) -> list[str]:
    services = _stack(ctx).get("services") or []
    if not isinstance(services, list):
        return []
    return [str(service[key]) for service in services if isinstance(service, dict) and service.get(key)]


def _stack_has_requirement(ctx: dict[str, Any], requirement: str) -> bool:
    stack = _stack(ctx)
    if stack.get(requirement):
        return True
    for value in stack.values():
        if isinstance(value, str) and value == requirement:
            return True
    for service_key in ("runtime", "hosting", "ui", "testing"):
        if requirement in _service_values(ctx, service_key):
            return True
    return False


def _archetype(ctx: dict[str, Any]) -> str:
    return str(_experiment(ctx).get("type") or "web-app")


def _event_applies(ctx: dict[str, Any], cfg: dict[str, Any]) -> bool:
    requires = cfg.get("requires") or []
    if isinstance(requires, str):
        requires = [requires]
    if any(not _stack_has_requirement(ctx, str(req)) for req in requires):
        return False
    archetypes = cfg.get("archetypes") or []
    if isinstance(archetypes, str):
        archetypes = [archetypes]
    return not archetypes or _archetype(ctx) in [str(a) for a in archetypes]


def expected_landing_events(ctx: dict[str, Any]) -> list[str]:
    events = []
    for name, cfg in _events_map(ctx).items():
        if not _event_applies(ctx, cfg):
            continue
        if str(cfg.get("funnel_stage") or "") in {"reach", "landing"}:
            events.append(name)
    return sorted(events)


def single_fire_events(ctx: dict[str, Any]) -> set[str]:
    events: set[str] = set()
    for name, cfg in _events_map(ctx).items():
        if not _event_applies(ctx, cfg):
            continue
        stage = str(cfg.get("funnel_stage") or "")
        if stage in {"activation", "activate", "monetize", "retain"} and not name.endswith(
            ("_view", "_viewed")
        ):
            events.add(name)
    return events


def _read_vercel_project_link(root: Path) -> dict[str, str | None] | None:
    path = root / ".vercel" / "project.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return {"projectId": data.get("projectId"), "orgId": data.get("orgId")}


def _vercel_identity(ctx: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    token = ctx.get("vercel_token") or vercel_api.read_vercel_token()
    project_id = ctx.get("vercel_project_id")
    team_id = ctx.get("vercel_team_id")
    link = _read_vercel_project_link(_root(ctx))
    if link:
        project_id = project_id or link.get("projectId")
        team_id = team_id or link.get("orgId")
    return token, project_id or _mvp_name(ctx) or None, team_id


def autodetect_vercel_deploy_url(ctx: dict[str, Any]) -> str | None:
    token, project_id, team_id = _vercel_identity(ctx)
    if not token or not project_id:
        return None
    return vercel_api.latest_production_deployment_url(token, project_id, team_id)


def resolve_deploy_url(ctx: dict[str, Any]) -> str | None:
    deploy_url = str(ctx.get("deploy_url") or "").strip()
    return deploy_url or autodetect_vercel_deploy_url(ctx)


def playwright_installed(root: Path) -> bool:
    return (root / "node_modules" / "@playwright" / "test").exists()


def _read_posthog_api_key() -> str:
    return Path("~/.posthog/personal-api-key").expanduser().read_text(encoding="utf-8").strip()


def _posthog_get(url: str, api_key: str) -> dict[str, Any]:
    r = subprocess.run(
        ["curl", "-s", "-H", f"Authorization: Bearer {api_key}", url],
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        raise SmokeSetupError(f"PostHog API failed: {r.stderr[:200]}")
    try:
        data = json.loads(r.stdout)
    except Exception as exc:
        raise SmokeSetupError(f"malformed PostHog response: {exc}") from exc
    if isinstance(data, dict) and str(data.get("detail", "")).lower().startswith("authentication"):
        raise SmokeSetupError("PostHog token lacks Organization Read / Project Read scope.")
    return data if isinstance(data, dict) else {}


def _next_url(host: str, url: str | None) -> str | None:
    if not url:
        return None
    if url.startswith("http"):
        return url
    return host.rstrip("/") + "/" + url.lstrip("/")


def list_posthog_projects(api_key: str, host: str = H.POSTHOG_PRIVATE_API_HOST) -> list[dict[str, Any]]:
    projects: list[dict[str, Any]] = []
    org_url: str | None = f"{host.rstrip('/')}/api/organizations/"
    while org_url:
        org_page = _posthog_get(org_url, api_key)
        for org in org_page.get("results") or []:
            if not isinstance(org, dict) or not org.get("id"):
                continue
            project_url: str | None = f"{host.rstrip('/')}/api/organizations/{org['id']}/projects/"
            while project_url:
                project_page = _posthog_get(project_url, api_key)
                for project in project_page.get("results") or []:
                    if isinstance(project, dict):
                        projects.append(project)
                project_url = _next_url(host, project_page.get("next"))
        org_url = _next_url(host, org_page.get("next"))
    return projects


def _source_failure_message(source: str, key: str | None, resolved_file: str | None) -> str:
    if source == "vercel_env_empty_or_placeholder":
        return "PostHog key resolution failed (vercel_env_empty_or_placeholder): Vercel production NEXT_PUBLIC_POSTHOG_KEY is empty or phc_TEAM_KEY."
    if source == "vercel_env_error":
        return "PostHog key resolution failed (vercel_env_error): could not verify Vercel production env."
    if source == "missing":
        return "PostHog key resolution failed (missing): NEXT_PUBLIC_POSTHOG_KEY is not configured anywhere."
    if source == "source_fallback_inconsistent":
        return "PostHog key resolution failed (source_fallback_inconsistent): active fallback literals differ across source files."
    if source == "source_fallback" and (not key or key == H.POSTHOG_PLACEHOLDER):
        return f"PostHog key resolution failed (source_fallback): `{resolved_file}` still uses phc_TEAM_KEY as the active fallback."
    if source == "vercel_env_set" and (not key or key == H.POSTHOG_PLACEHOLDER):
        return "PostHog key resolution failed (vercel_env_set): Vercel production key is empty or phc_TEAM_KEY."
    return f"PostHog key resolution failed ({source})."


def discover_posthog_project(ctx: dict[str, Any]) -> dict[str, Any]:
    key, source, resolved_file = H.resolve_production_posthog_key(ctx)
    if source == "vercel_env_set" and key and key != H.POSTHOG_PLACEHOLDER:
        resolved_key = key
    elif source == "source_fallback" and key and key != H.POSTHOG_PLACEHOLDER:
        resolved_key = key
    else:
        raise SmokeSetupError(_source_failure_message(source, key, resolved_file))

    try:
        api_key = _read_posthog_api_key()
    except Exception as exc:
        raise SmokeSetupError(
            "PostHog project discovery failed. Check ~/.posthog/personal-api-key and token scopes (Organization Read, Project Read)."
        ) from exc

    projects = list_posthog_projects(api_key, str(ctx.get("posthog_api_host") or H.POSTHOG_PRIVATE_API_HOST))
    project = next((p for p in projects if p.get("api_token") == resolved_key), None)
    if not project:
        names = ", ".join(str(p.get("name") or p.get("id") or "<unnamed>") for p in projects)
        raise SmokeSetupError(
            "PostHog project discovery failed. Resolved NEXT_PUBLIC_POSTHOG_KEY "
            f"does not match any accessible project across all orgs. Accessible projects: {names or '<none>'}."
        )
    return {
        "project_id": str(project.get("id")),
        "api_key": api_key,
        "expected_project_name": _mvp_name(ctx),
        "project": project,
        "posthog_key_source": source,
    }


def prepare_smoke_dir(root: Path) -> Path:
    smoke_dir = root / SMOKE_DIR
    smoke_dir.mkdir(parents=True, exist_ok=True)
    source_dir = Path(__file__).resolve().parent
    shutil.copyfile(source_dir / "ads_ready_smoke.spec.ts", smoke_dir / "ads_ready_smoke.spec.ts")
    shutil.copyfile(
        source_dir / "ads_ready_playwright.config.ts",
        smoke_dir / "ads_ready_playwright.config.ts",
    )
    return smoke_dir


def run_playwright_smoke(root: Path, deploy_url: str, synthetic_gclid: str) -> Path:
    smoke_dir = prepare_smoke_dir(root)
    env = os.environ.copy()
    env.update(
        {
            "ADS_READY_DEPLOY_URL": deploy_url.rstrip("/"),
            "ADS_READY_GCLID": synthetic_gclid,
            "ADS_READY_OUTPUT_DIR": str(SMOKE_DIR),
        }
    )
    config = smoke_dir / "ads_ready_playwright.config.ts"
    spec = smoke_dir / "ads_ready_smoke.spec.ts"
    r = subprocess.run(
        ["npx", "playwright", "test", "--config", str(config), str(spec)],
        cwd=str(root),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        diagnostic = (r.stderr or r.stdout or "").strip()[:1000]
        raise SmokeSetupError(
            "Playwright smoke failed. "
            + (diagnostic if diagnostic else "No diagnostic output from npx playwright.")
        )
    return smoke_dir / "captured-events.json"


def _query(sql: str, values: dict[str, Any], posthog: dict[str, Any]) -> list[Any]:
    response = _posthog_query(sql, values, posthog["project_id"], posthog["api_key"])
    results = response.get("results", []) if isinstance(response, dict) else []
    return results if isinstance(results, list) else []


def _event_query_sql() -> str:
    return """
SELECT event, properties.project_name AS pn,
       coalesce(toString(properties.$session_entry_gclid), toString(properties.gclid)) AS g
FROM events
WHERE (
    properties.gclid = {syn}
    OR properties.$session_entry_gclid = {syn}
  )
  AND timestamp >= now() - INTERVAL 5 MINUTE
ORDER BY timestamp DESC
LIMIT 50
"""


def _count_query_sql() -> str:
    return """
SELECT event, count() AS fires
FROM events
WHERE (
    properties.gclid = {syn}
    OR properties.$session_entry_gclid = {syn}
  )
  AND timestamp >= now() - INTERVAL 5 MINUTE
GROUP BY event
"""


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    if isinstance(row, (list, tuple)) and len(row) > index:
        return row[index]
    return None


def _event_names(rows: list[Any]) -> set[str]:
    return {str(value) for row in rows if (value := _row_value(row, "event", 0))}


def _query_events_with_retry(
    synthetic_gclid: str,
    posthog: dict[str, Any],
    sleeper: Callable[[float], None] | None = None,
) -> list[Any]:
    sleeper = sleeper or time.sleep
    sleeper(30)
    rows = _query(_event_query_sql(), {"syn": synthetic_gclid}, posthog)
    if rows:
        return rows
    sleeper(30)
    return _query(_event_query_sql(), {"syn": synthetic_gclid}, posthog)


def run_check_20_synthetic_gclid(
    synthetic_gclid: str,
    posthog: dict[str, Any],
    expected_pn: str,
    sleeper: Callable[[float], None] | None = None,
) -> tuple[dict[str, Any], list[Any]]:
    try:
        rows = _query_events_with_retry(synthetic_gclid, posthog, sleeper=sleeper)
    except Exception as exc:
        return (
            _check(
                20,
                CHECK_20_NAME,
                False,
                f"HogQL query failed for synthetic gclid: {exc}",
                "Confirm the PostHog personal API key has Project Read scope and retry.",
            ),
            [],
        )
    if not rows:
        return (
            _check(
                20,
                CHECK_20_NAME,
                False,
                "Synthetic event never arrived in PostHog after the 90s timeout budget.",
                "Synthetic event never arrived (90s timeout). Open DevTools on the deployed URL with ?gclid=test, check Network for /ingest/decide/ or i.posthog.com/capture. Likely causes: SDK never inits, NEXT_PUBLIC_POSTHOG_KEY misconfig in Vercel env, /ingest rewrite missing in next.config, or ad-blocker.",
            ),
            rows,
        )
    project_names = {str(_row_value(row, "pn", 1) or "") for row in rows}
    if expected_pn and expected_pn not in project_names:
        return (
            _check(
                20,
                CHECK_20_NAME,
                False,
                f"Synthetic gclid arrived, but project_name was {sorted(project_names)} instead of `{expected_pn}`.",
                "Ensure analytics global properties set project_name from experiment.yaml.name before launching ads.",
            ),
            rows,
        )
    return (
        _check(20, CHECK_20_NAME, True, f"Synthetic gclid arrived with project_name `{expected_pn}`.", None),
        rows,
    )


def run_check_21_golden_path_events(
    synthetic_gclid: str,
    posthog: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    try:
        rows = _query(_event_query_sql(), {"syn": synthetic_gclid}, posthog)
    except Exception as exc:
        return _check(
            21,
            CHECK_21_NAME,
            False,
            f"HogQL query failed for landing events: {exc}",
            "Confirm the PostHog personal API key has Project Read scope and retry.",
        )
    observed = _event_names(rows)
    expected = expected_landing_events(ctx)
    if not expected:
        if observed:
            return _check(21, CHECK_21_NAME, True, f"Observed events for synthetic gclid: {sorted(observed)}.", None)
        return _check(
            21,
            CHECK_21_NAME,
            False,
            "No EVENTS.yaml landing expectation exists and no event fired for the synthetic gclid.",
            "Add a landing/reach event to EVENTS.yaml and fire it on the landing page, or fix analytics initialization.",
        )
    matched = sorted(set(expected) & observed)
    if matched:
        return _check(21, CHECK_21_NAME, True, f"Landing-stage event(s) fired: {matched}.", None)
    return _check(
        21,
        CHECK_21_NAME,
        False,
        f"Expected landing-stage events {expected}, but only {sorted(observed)} fired.",
        f"Expected landing-stage events {expected} per EVENTS.yaml, but only {sorted(observed)} fired. Add the corresponding track call to src/app/page.tsx or import its wrapper from @/lib/events.",
    )


def run_check_22_no_double_fire(
    synthetic_gclid: str,
    posthog: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    try:
        rows = _query(_count_query_sql(), {"syn": synthetic_gclid}, posthog)
    except Exception as exc:
        return _check(
            22,
            CHECK_22_NAME,
            False,
            f"HogQL aggregation failed for double-fire check: {exc}",
            "Confirm the PostHog personal API key has Project Read scope and retry.",
        )
    single_fire = single_fire_events(ctx)
    offenders: list[tuple[str, int]] = []
    for row in rows:
        event = str(_row_value(row, "event", 0) or "")
        try:
            fires = int(_row_value(row, "fires", 1) or 0)
        except (TypeError, ValueError):
            fires = 0
        if event in single_fire and fires > 1:
            offenders.append((event, fires))
    if not offenders:
        return _check(22, CHECK_22_NAME, True, "No critical single-fire event fired more than once.", None)
    event, fires = offenders[0]
    return _check(
        22,
        CHECK_22_NAME,
        False,
        f"Event `{event}` fired {fires} times for one gclid session.",
        f"Event '{event}' fired {fires} times for one gclid session (expected 1). Search src/ for duplicate track('{event}') call sites.",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", required=True)
    parser.add_argument("--static-result", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    ctx = _read_json(args.context)
    if ctx.get("static_only"):
        write_skipped(args.output, reason="static_only flag set")
        return 0

    deploy_url = resolve_deploy_url(ctx)
    if not deploy_url:
        write_failed(
            args.output,
            "Could not determine deployed URL. Pass --url, or log into Vercel CLI.",
            "Pass --url to /ads-ready, or run `vercel login` and ensure the MVP is linked to a Vercel project.",
        )
        return 0

    root = _root(ctx)
    if not playwright_installed(root):
        write_failed(
            args.output,
            "Playwright is required for Layer B.",
            "Playwright is required for Layer B. Run `npm install --save-dev @playwright/test && npx playwright install chromium` in the MVP repo, then re-run /ads-ready.",
            deploy_url=deploy_url,
        )
        return 0

    try:
        posthog = discover_posthog_project(ctx)
        synthetic_gclid = SYNTHETIC_GCLID_PREFIX + secrets.token_urlsafe(20)
        run_playwright_smoke(root, deploy_url, synthetic_gclid)
    except SmokeSetupError as exc:
        write_failed(
            args.output,
            str(exc),
            "Fix the Layer B setup issue and re-run /ads-ready.",
            deploy_url=deploy_url,
        )
        return 0

    check_20, _rows = run_check_20_synthetic_gclid(
        synthetic_gclid,
        posthog,
        expected_pn=str(posthog.get("expected_project_name") or ""),
    )
    check_21 = run_check_21_golden_path_events(synthetic_gclid, posthog, ctx)
    check_22 = run_check_22_no_double_fire(synthetic_gclid, posthog, ctx)

    _write_result(
        args.output,
        _result_output(
            [check_20, check_21, check_22],
            deploy_url=deploy_url,
            synthetic_gclid=synthetic_gclid,
        ),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

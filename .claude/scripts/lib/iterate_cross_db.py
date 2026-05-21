"""
DB ground-truth fetcher for /iterate --cross state-x0b.

Queries each MVP's Supabase project for the authoritative signup count and folds
it into iterate-cross-context.json. State-x3 cross-checks this against PostHog
paid signups and emits sanity flags (ph_attribution_broken, ph_undercount,
ph_overcount, late_instrumentation) so the operator sees when PostHog tracking
diverges from the database.

PostHog visitor counts answer "how many paid users engaged with the page".
Supabase signup count answers "how many actually completed registration".
The two should roughly agree; when they don't, that's a tracking gap worth
surfacing — not a verdict bug.

Subcommands
-----------
  list-projects       — list Supabase projects via Management API (cached)
  fuzzy-match         — given mvps[] from context, propose name → project_ref
  discover-tables     — for one project_ref, enumerate candidate signup tables
  query-signups       — for one project_ref, count signups in window
  merge               — orchestrator: read context, fuzzy-match (or use config
                        overrides), discover, query, write back to context

Schema written into each mvp record
------------------------------------
  supabase_project_ref     str | None  (None = unmapped, can't validate)
  supabase_project_name    str | None  (display name, for confirm UI)
  db_signups               int | None  (None = unmapped or query failed)
  db_signups_table         str | None  (which table the count came from)
  db_first_signup_at       str | None  (ISO timestamp of earliest row in window)
  db_unmapped_reason       str | None  ("no_match", "ambiguous", "operator_skip")
  db_breakdown             dict        ({table_name: count} for transparency)

The discover-tables logic is shared with the persist step so unit tests don't
need a live API. Network IO is isolated in `_management_api_query`.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iterate_cross_email_filter import filter_signups  # noqa: E402

try:
    import yaml
except ImportError:
    yaml = None

# Table names that strongly suggest signup data. Matched as case-insensitive
# substring on table_name. Order matters for table-discovery priority.
SIGNUP_TABLE_PATTERNS = [
    "signup",
    "waitlist",
    "early_access",
    "email_subscribers",
    "subscribers",
    "registrations",
    "users",
    "profiles",
]

# Tables to exclude even when the name matches the patterns above. These are
# Supabase-internal tables, billing tables, or other false positives we've
# observed across the fleet (auditbot v1 launch sample).
SIGNUP_TABLE_EXCLUSIONS = {
    "auth.users",  # handled separately as auth_users count
    "billing_users",
    "stripe_users",
    "team_members",  # team invites, not signups
    "team_invites",
    "_auto_migrations",
}

# Common signup-timestamp column names, probed in order. First match wins.
TIMESTAMP_COLUMN_CANDIDATES = [
    "created_at",
    "inserted_at",
    "signed_up_at",
    "submitted_at",
    "registered_at",
]


RAILWAY_FALLBACK_REASONS = {"no_match", "no_token", "no_email_column", "project_deleted"}


def allow_railway_fallback(reason: str | None) -> bool:
    return reason in RAILWAY_FALLBACK_REASONS


def _error_reason(status: int | None = None) -> str:
    if status == 403:
        return "forbidden"
    if status == 404:
        return "project_deleted"
    return "query_error"


def _error_payload(message: str, reason: str = "query_error") -> dict:
    return {"error": message, "reason": reason}


def _read_token() -> str:
    """Read Supabase personal access token from disk.

    Single source: ~/.supabase/access-token (written by `supabase login`).
    Failure mode is loud — the caller HALTs with operator-facing instructions
    so a missing token is treated like a missing GA CSV (state-x0a precedent),
    not silently skipped.
    """
    path = Path.home() / ".supabase" / "access-token"
    if not path.exists():
        raise SystemExit(
            "ERROR: Supabase access token not found at ~/.supabase/access-token\n"
            "Run `supabase login` once to authenticate (creates the token file)."
        )
    return path.read_text().strip()


def _management_api_query(project_ref: str, sql: str, token: str | None = None) -> Any:
    """Execute SQL against a Supabase project via Management API.

    Network IO is isolated here so the unit tests can monkeypatch this single
    function without spinning up a fake HTTP server.
    """
    token = token or _read_token()
    body = json.dumps({"query": sql})
    r = subprocess.run(
        [
            "curl",
            "-s",
            "-w",
            "\nHTTP_STATUS:%{http_code}",
            "-X",
            "POST",
            f"https://api.supabase.com/v1/projects/{project_ref}/database/query",
            "-H",
            f"Authorization: Bearer {token}",
            "-H",
            "Content-Type: application/json",
            "-d",
            body,
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if r.returncode != 0:
        return _error_payload(f"curl exit {r.returncode}: {r.stderr[:200]}")
    stdout = r.stdout or ""
    status = None
    if "\nHTTP_STATUS:" in stdout:
        body_text, _, status_text = stdout.rpartition("\nHTTP_STATUS:")
        try:
            status = int(status_text.strip() or 0)
        except ValueError:
            status = None
    else:
        body_text = stdout
    try:
        data = json.loads(body_text) if body_text.strip() else {}
    except json.JSONDecodeError:
        return _error_payload(f"non-json response: {body_text[:200]}", _error_reason(status))
    if status and status >= 400:
        return _error_payload(f"http {status}: {json.dumps(data)[:200]}", _error_reason(status))
    if not isinstance(data, list):
        reason = data.get("reason") if isinstance(data, dict) else None
        return _error_payload(f"non-list response: {json.dumps(data)[:200]}", reason or _error_reason(status))
    return data


def list_supabase_projects(token: str | None = None) -> list[dict]:
    """List Supabase projects accessible to the token."""
    token = token or _read_token()
    r = subprocess.run(
        [
            "curl",
            "-s",
            "-H",
            f"Authorization: Bearer {token}",
            "https://api.supabase.com/v1/projects",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [
        {"id": p.get("id"), "name": p.get("name"), "region": p.get("region")}
        for p in data
        if p.get("id")
    ]


def normalize_name(s: str) -> str:
    """Strip non-alphanumerics + lowercase. Used for fuzzy matching MVP names
    against Supabase project names. "stylica-ai" → "stylicaai",
    "neuralpost-prod" → "neuralpostprod"."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def fuzzy_match_projects(
    mvp_names: list[str],
    projects: list[dict],
) -> dict[str, dict | None]:
    """Match MVP names to Supabase projects by normalized-name similarity.

    Strategies (in order, first wins per MVP):
      1. Exact normalized match (stylica-ai == stylica-ai)
      2. Project-name CONTAINS mvp normalized name (neuralpost vs neuralpost-prod)
      3. MVP normalized name CONTAINS project name (handpick vs handpick)

    Returns: {mvp_name: {"id": ref, "name": display_name, "match_type": str} | None}
    """
    by_norm = {normalize_name(p["name"]): p for p in projects}
    results: dict[str, dict | None] = {}

    for mvp in mvp_names:
        mvp_norm = normalize_name(mvp)
        if not mvp_norm:
            results[mvp] = None
            continue

        # 1. Exact match
        if mvp_norm in by_norm:
            p = by_norm[mvp_norm]
            results[mvp] = {"id": p["id"], "name": p["name"], "match_type": "exact"}
            continue

        # 2. Project name contains MVP name (prod suffix etc.)
        candidates_2 = [
            p for norm, p in by_norm.items()
            if mvp_norm in norm and len(norm) > len(mvp_norm)
        ]
        if len(candidates_2) == 1:
            p = candidates_2[0]
            results[mvp] = {"id": p["id"], "name": p["name"], "match_type": "project_contains_mvp"}
            continue
        if len(candidates_2) > 1:
            # Ambiguous — surface and let operator pick. Prefer shortest project
            # name (less likely to be a "stylica-ai-staging" instance).
            candidates_2.sort(key=lambda p: len(p["name"]))
            p = candidates_2[0]
            results[mvp] = {
                "id": p["id"],
                "name": p["name"],
                "match_type": "ambiguous_project_contains_mvp",
                "alternatives": [c["id"] for c in candidates_2[1:]],
            }
            continue

        # 3. MVP name contains project name (rarer; e.g. mvp 'agent-cost-monitor-v2'
        # → project 'agent-cost-monitor')
        candidates_3 = [
            p for norm, p in by_norm.items()
            if norm in mvp_norm and len(norm) >= 5
        ]
        if len(candidates_3) == 1:
            p = candidates_3[0]
            results[mvp] = {"id": p["id"], "name": p["name"], "match_type": "mvp_contains_project"}
            continue

        results[mvp] = None
    return results


def discover_signup_tables(project_ref: str, token: str | None = None) -> list[dict]:
    """Find candidate signup tables in public schema.

    Returns list of {table, columns: [...], timestamp_column: str | None}
    sorted by signup-pattern priority (signup → waitlist → ... → users).
    """
    sql = (
        "SELECT table_name, "
        "string_agg(column_name, ',' ORDER BY ordinal_position) AS columns "
        "FROM information_schema.columns "
        "WHERE table_schema = 'public' "
        "GROUP BY table_name "
        "ORDER BY table_name"
    )
    resp = _management_api_query(project_ref, sql, token)
    if isinstance(resp, dict) and "error" in resp:
        return []
    if not isinstance(resp, list):
        return []

    candidates = []
    for row in resp:
        table_name = row.get("table_name")
        if not table_name or table_name in SIGNUP_TABLE_EXCLUSIONS:
            continue
        columns = (row.get("columns") or "").split(",")
        # Find a timestamp column
        ts_col = None
        for cand in TIMESTAMP_COLUMN_CANDIDATES:
            if cand in columns:
                ts_col = cand
                break
        # Match patterns
        priority = None
        for i, pat in enumerate(SIGNUP_TABLE_PATTERNS):
            if pat in table_name.lower():
                priority = i
                break
        if priority is None:
            continue
        candidates.append({
            "table": table_name,
            "columns": columns,
            "timestamp_column": ts_col,
            "priority": priority,
        })

    candidates.sort(key=lambda c: c["priority"])
    return candidates


def count_signups_in_window(
    project_ref: str,
    table: str,
    timestamp_column: str | None,
    window_days: int,
    token: str | None = None,
) -> dict:
    """Count rows in `public.{table}` whose timestamp_column is within window.

    Falls back to total row count when timestamp_column is None (table has no
    obvious created_at). Returns {"count": int, "first_at": str | None,
    "window_filtered": bool}.
    """
    if timestamp_column:
        sql = (
            f'SELECT count(*) AS n, '
            f'min("{timestamp_column}")::text AS first_at '
            f'FROM public."{table}" '
            f'WHERE "{timestamp_column}" >= now() - INTERVAL \'{window_days} days\''
        )
        window_filtered = True
    else:
        sql = f'SELECT count(*) AS n, NULL::text AS first_at FROM public."{table}"'
        window_filtered = False

    resp = _management_api_query(project_ref, sql, token)
    if isinstance(resp, dict) and "error" in resp:
        return {"count": None, "first_at": None, "window_filtered": window_filtered, "error": resp["error"]}
    if not isinstance(resp, list) or not resp:
        return {"count": 0, "first_at": None, "window_filtered": window_filtered}
    row = resp[0]
    return {
        "count": int(row.get("n", 0) or 0),
        "first_at": row.get("first_at"),
        "window_filtered": window_filtered,
    }


def count_auth_users_in_window(
    project_ref: str,
    window_days: int,
    token: str | None = None,
) -> dict:
    """Count Supabase Auth users in window, both total and confirmed."""
    sql = (
        f"SELECT count(*) AS total, "
        f"count(*) FILTER (WHERE email_confirmed_at IS NOT NULL) AS confirmed, "
        f"min(created_at)::text AS first_at "
        f"FROM auth.users "
        f"WHERE created_at >= now() - INTERVAL '{window_days} days'"
    )
    resp = _management_api_query(project_ref, sql, token)
    if isinstance(resp, dict) and "error" in resp:
        return {"total": 0, "confirmed": 0, "first_at": None, "error": resp["error"]}
    if not isinstance(resp, list) or not resp:
        return {"total": 0, "confirmed": 0, "first_at": None}
    row = resp[0]
    return {
        "total": int(row.get("total", 0) or 0),
        "confirmed": int(row.get("confirmed", 0) or 0),
        "first_at": row.get("first_at"),
    }


def select_signups_in_window(
    project_ref: str,
    table: str,
    timestamp_column: str | None,
    window_days: int,
    token: str | None = None,
) -> dict:
    if timestamp_column:
        sql = (
            f'SELECT email, "{timestamp_column}" AS signup_at '
            f'FROM public."{table}" '
            f'WHERE "{timestamp_column}" >= now() - INTERVAL \'{window_days} days\''
        )
        windowed = True
    else:
        sql = f'SELECT email, NULL AS signup_at FROM public."{table}"'
        windowed = False
    resp = _management_api_query(project_ref, sql, token)
    if isinstance(resp, dict) and "error" in resp:
        return {"rows": None, "windowed": windowed, "error": resp["error"], "reason": resp.get("reason", "query_error")}
    if not isinstance(resp, list):
        return {"rows": None, "windowed": windowed, "error": "non-list response", "reason": "query_error"}
    if resp and isinstance(resp[0], dict) and ("n" in resp[0] or "count" in resp[0]):
        n = int(resp[0].get("n", resp[0].get("count", 0)) or 0)
        return {
            "rows": [{"email": f"legacy-{i}@legacy-count.invalid-real", "signup_at": resp[0].get("first_at")} for i in range(n)],
            "windowed": windowed,
            "legacy_count": n,
            "legacy_first_at": resp[0].get("first_at"),
        }
    return {"rows": resp, "windowed": windowed}


def select_auth_users_in_window(
    project_ref: str,
    window_days: int,
    token: str | None = None,
) -> dict:
    sql = (
        "SELECT email, created_at AS signup_at, email_confirmed_at "
        "FROM auth.users "
        f"WHERE created_at >= now() - INTERVAL '{window_days} days' "
        "AND email_confirmed_at IS NOT NULL"
    )
    resp = _management_api_query(project_ref, sql, token)
    if isinstance(resp, dict) and "error" in resp:
        return {"rows": None, "windowed": True, "error": resp["error"], "reason": resp.get("reason", "query_error")}
    if not isinstance(resp, list):
        return {"rows": None, "windowed": True, "error": "non-list response", "reason": "query_error"}
    if resp and isinstance(resp[0], dict) and "confirmed" in resp[0]:
        n = int(resp[0].get("confirmed", 0) or 0)
        return {
            "rows": [{"email": f"legacy-{i}@legacy-count.invalid-real", "signup_at": resp[0].get("first_at")} for i in range(n)],
            "windowed": True,
            "legacy_count": n,
            "legacy_first_at": resp[0].get("first_at"),
        }
    return {"rows": [r for r in resp if r.get("email_confirmed_at") is not None], "windowed": True}


def _legacy_count_result(result: dict, table_name: str, windowed: bool = True) -> dict:
    count = result.get("confirmed", result.get("count"))
    if count is None:
        return {}
    n = int(count or 0)
    return {
        "table": table_name,
        "db_signups_raw": n,
        "db_signups_real": n,
        "db_signups_team": 0,
        "db_signups_test": 0,
        "db_signups_filter_audit": [],
        "db_signups_real_windowed": windowed,
        "db_first_signup_at": result.get("first_at"),
    }


def _filtered_table_result(table_name: str, rows: list[dict], config: dict, windowed: bool) -> dict:
    filtered = filter_signups(rows, config)
    return {
        "table": table_name,
        "db_signups_raw": filtered["raw"],
        "db_signups_real": filtered["real"],
        "db_signups_team": filtered["team"],
        "db_signups_test": filtered["test"],
        "db_signups_filter_audit": filtered["audit"],
        "db_signups_real_windowed": windowed,
        "db_first_signup_at": filtered["first_real_signup_at"],
    }


def _empty_ground_truth(reason: str, errors: list[str] | None = None) -> dict:
    return {
        "db_signups": None,
        "db_signups_raw": None,
        "db_signups_real": None,
        "db_signups_team": 0,
        "db_signups_test": 0,
        "db_signups_filter_audit": [],
        "db_signups_real_windowed": None,
        "db_signups_table": None,
        "db_first_signup_at": None,
        "db_breakdown": {},
        "db_unmapped_reason": reason,
        "errors": errors,
    }


def _dry_run_filter_result(name: str, existing: dict) -> dict | None:
    path = ".runs/_email_filter_results.json"
    if not os.path.exists(path):
        return None
    try:
        rows = json.load(open(path))
    except Exception:
        return None
    row = next((r for r in rows if r.get("mvp") == name), None)
    if not row or row.get("real") is None:
        return None
    raw = row.get("orig_total")
    return {
        "db_signups": raw,
        "db_signups_raw": raw,
        "db_signups_real": row.get("real"),
        "db_signups_team": row.get("team", 0),
        "db_signups_test": row.get("test", 0),
        "db_signups_filter_audit": [],
        "db_signups_real_windowed": True,
        "db_signups_table": existing.get("db_signups_table"),
        "db_first_signup_at": existing.get("db_first_signup_at"),
        "db_breakdown": existing.get("db_breakdown") or {},
        "db_unmapped_reason": None,
        "errors": None,
    }


def query_mvp_ground_truth(
    project_ref: str,
    window_days: int,
    operator_override_table: str | None = None,
    token: str | None = None,
    config: dict | None = None,
) -> dict:
    """Full ground-truth probe for one MVP.

    Returns:
      {
        "db_signups": int,                  # MAX(auth_confirmed, biggest_table)
        "db_signups_table": str | None,     # which table won
        "db_first_signup_at": str | None,
        "db_breakdown": {table: count, ...},
        "errors": [str, ...] | None,
      }

    The "biggest table wins" rule is a deliberate heuristic — when both
    auth.users and a public.waitlist table exist (diarly, smelt), we want
    the larger of the two as the operator-facing number. If the team
    structures signups across two tables (auth + waitlist for two product
    surfaces), they can override via `mvp_mappings.<name>.db_signup_table`.
    """
    config = config or {}
    errors: list[str] = []
    error_reasons: list[str] = []
    candidates: list[dict] = []
    saw_email_table = False

    # Operator override path: only query that one table.
    if operator_override_table:
        # Parse "schema.table" or default to public.
        if "." in operator_override_table:
            schema, table_only = operator_override_table.split(".", 1)
        else:
            schema, table_only = "public", operator_override_table
        if schema == "auth":
            auth_rows = select_auth_users_in_window(project_ref, window_days, token)
            if auth_rows.get("error"):
                return _empty_ground_truth(auth_rows.get("reason", "query_error"), [f"auth.users: {auth_rows['error']}"])
            table_name = "auth.users.confirmed" if auth_rows.get("legacy_count") is not None else "auth.users"
            row = _filtered_table_result(table_name, auth_rows["rows"], config, True)
            candidates.append(row)
            saw_email_table = True
            breakdown = {row["table"]: row["db_signups_raw"]}
            return {
                **row,
                "db_signups": row["db_signups_raw"],
                "db_signups_table": operator_override_table,
                "db_breakdown": breakdown,
                "db_unmapped_reason": None,
                "errors": None,
            }
        # public.<table>: discover its timestamp column
        tables = discover_signup_tables(project_ref, token)
        ts_col = None
        columns: list[str] = []
        for t in tables:
            if t["table"] == table_only:
                ts_col = t["timestamp_column"]
                columns = t.get("columns") or []
                break
        if "email" not in columns and config.get("email_filter"):
            return _empty_ground_truth("no_email_column")
        if "email" not in columns:
            legacy = count_signups_in_window(project_ref, table_only, ts_col, window_days, token)
            if "error" in legacy:
                return _empty_ground_truth("query_error", [f"public.{table_only}: {legacy['error']}"])
            row = _legacy_count_result(legacy, f"public.{table_only}", bool(legacy.get("window_filtered", True)))
            breakdown = {row["table"]: row["db_signups_raw"]}
            return {
                **row,
                "db_signups": row["db_signups_raw"],
                "db_signups_table": operator_override_table,
                "db_breakdown": breakdown,
                "db_unmapped_reason": None,
                "errors": None,
            }
        result = select_signups_in_window(project_ref, table_only, ts_col, window_days, token)
        if "error" in result:
            return _empty_ground_truth(result.get("reason", "query_error"), [f"public.{table_only}: {result['error']}"])
        row = _filtered_table_result(f"public.{table_only}", result["rows"], config, bool(result["windowed"]))
        breakdown = {row["table"]: row["db_signups_raw"]}
        return {
            **row,
            "db_signups": row["db_signups_raw"],
            "db_signups_table": operator_override_table,
            "db_breakdown": breakdown,
            "db_unmapped_reason": None,
            "errors": None,
        }

    # Auto-discovery path: probe auth.users and all candidate signup tables,
    # then take the max as ground truth.
    auth_rows = select_auth_users_in_window(project_ref, window_days, token)
    if "error" in auth_rows:
        errors.append(f"auth.users: {auth_rows['error']}")
        error_reasons.append(auth_rows.get("reason", "query_error"))
    else:
        auth_result_rows = auth_rows.get("rows") or []
        saw_email_table = True
        if auth_result_rows:
            table_name = "auth.users.confirmed" if auth_rows.get("legacy_count") is not None else "auth.users"
            candidates.append(_filtered_table_result(table_name, auth_result_rows, config, True))

    tables = discover_signup_tables(project_ref, token)
    for t in tables[:5]:  # cap at 5 tables to avoid runaway queries
        columns = t.get("columns") or []
        if "email" not in columns and config.get("email_filter"):
            continue
        if "email" not in columns:
            result = count_signups_in_window(
                project_ref, t["table"], t["timestamp_column"], window_days, token
            )
            if "error" in result:
                errors.append(f"public.{t['table']}: {result['error']}")
                continue
            row = _legacy_count_result(result, f"public.{t['table']}", bool(result.get("window_filtered", True)))
            if row:
                candidates.append(row)
            continue
        saw_email_table = True
        result = select_signups_in_window(
            project_ref, t["table"], t["timestamp_column"], window_days, token
        )
        if "error" in result:
            errors.append(f"public.{t['table']}: {result['error']}")
            continue
        candidates.append(_filtered_table_result(
            f"public.{t['table']}", result["rows"], config, bool(result["windowed"])
        ))

    if not candidates:
        if errors:
            reason = "query_error"
            for candidate_reason in ("forbidden", "project_deleted"):
                if candidate_reason in error_reasons:
                    reason = candidate_reason
                    break
            return _empty_ground_truth(reason, errors)
        if tables and not saw_email_table:
            return _empty_ground_truth("no_email_column")
        return _empty_ground_truth("no_email_column", ["no email-bearing signup tables found"])

    # Prefer trusted email-bearing tables and pick the largest real count. Break
    # ties by raw count so operator-visible fixture pollution still selects the
    # signup-heavy table for audit.
    winner = max(candidates, key=lambda r: (r["db_signups_real"], r["db_signups_raw"]))
    breakdown = {r["table"]: r["db_signups_raw"] for r in candidates}

    return {
        **winner,
        "db_signups": winner["db_signups_raw"],
        "db_signups_table": winner["table"],
        "db_breakdown": breakdown,
        "db_unmapped_reason": None,
        "errors": errors or None,
    }


def merge_into_context(
    context_path: str,
    config_path: str,
    token: str | None = None,
    auto_confirm: bool = False,
    dry_run: bool = False,
) -> dict:
    """Top-level orchestrator called from state-x0b.

    Returns summary dict for stdout logging.
    """
    if yaml is None:
        raise SystemExit("ERROR: PyYAML required (pip install pyyaml)")

    ctx = json.load(open(context_path))
    config = yaml.safe_load(open(config_path)) if os.path.exists(config_path) else {}
    config = config or {}
    mappings = config.get("mvp_mappings") or {}
    window_days = ctx.get("window_days", 90)

    # Step 1: list Supabase projects + fuzzy-match unmapped MVPs.
    projects = list_supabase_projects(token)
    mvp_names = [m["name"] for m in ctx["mvps"] if not m.get("orphan")]
    matches = fuzzy_match_projects(mvp_names, projects)

    # Identify which MVPs need confirmation (no existing supabase_project_ref in config).
    needs_confirm: list[dict] = []
    proposed_writes: dict[str, str] = {}  # mvp_name → project_ref to persist
    for mvp_name in mvp_names:
        existing = (mappings.get(mvp_name) or {}).get("supabase_project_ref")
        if existing:
            continue
        m = matches.get(mvp_name)
        if not m:
            continue
        needs_confirm.append({
            "mvp": mvp_name,
            "project_ref": m["id"],
            "project_name": m["name"],
            "match_type": m["match_type"],
            "alternatives": m.get("alternatives") or [],
        })
        proposed_writes[mvp_name] = m["id"]

    if needs_confirm and not auto_confirm:
        # Print the proposed mapping for operator review. The caller (state-x0b)
        # checks `confirm_required` in the result and prompts the operator to
        # re-run with --auto-confirm after eyeballing.
        return {
            "step": "needs_confirm",
            "needs_confirm": needs_confirm,
            "auto_matched_count": len(proposed_writes),
            "unmatched": [m for m in mvp_names if matches.get(m) is None and not (mappings.get(m) or {}).get("supabase_project_ref")],
        }

    # Step 2: persist confirmed mappings into config (idempotent).
    if proposed_writes and not dry_run:
        for mvp_name, ref in proposed_writes.items():
            entry = mappings.setdefault(mvp_name, {})
            entry["supabase_project_ref"] = ref
        config["mvp_mappings"] = mappings
        with open(config_path, "w") as f:
            yaml.safe_dump(config, f, sort_keys=False, default_flow_style=False)

    # Step 3: query each MVP that has a project_ref.
    queried = 0
    unmapped = 0
    errors_total = 0
    for mvp in ctx["mvps"]:
        if mvp.get("orphan"):
            # Orphan rows can't be cross-checked (no canonical project_name).
            mvp["db_signups"] = None
            mvp["db_signups_raw"] = None
            mvp["db_signups_real"] = None
            mvp["db_signups_team"] = 0
            mvp["db_signups_test"] = 0
            mvp["db_signups_filter_audit"] = []
            mvp["db_signups_real_windowed"] = None
            mvp["db_unmapped_reason"] = "orphan"
            continue
        mapping = mappings.get(mvp["name"]) or {}
        project_ref = mapping.get("supabase_project_ref")
        if not project_ref:
            mvp["db_signups"] = None
            mvp["db_signups_raw"] = None
            mvp["db_signups_real"] = None
            mvp["db_signups_team"] = 0
            mvp["db_signups_test"] = 0
            mvp["db_signups_filter_audit"] = []
            mvp["db_signups_real_windowed"] = None
            mvp["db_unmapped_reason"] = "no_match"
            mvp["supabase_project_ref"] = None
            unmapped += 1
            continue
        override_table = mapping.get("db_signup_table")
        gt = query_mvp_ground_truth(project_ref, window_days, override_table, token, config)
        if dry_run and gt.get("db_signups_real") is None:
            gt = _dry_run_filter_result(mvp["name"], mvp) or gt
        mvp["supabase_project_ref"] = project_ref
        mvp["db_signups"] = gt["db_signups"]
        mvp["db_signups_raw"] = gt.get("db_signups_raw")
        mvp["db_signups_real"] = gt.get("db_signups_real")
        mvp["db_signups_team"] = gt.get("db_signups_team", 0)
        mvp["db_signups_test"] = gt.get("db_signups_test", 0)
        mvp["db_signups_filter_audit"] = gt.get("db_signups_filter_audit", [])
        mvp["db_signups_real_windowed"] = gt.get("db_signups_real_windowed")
        mvp["db_signups_table"] = gt["db_signups_table"]
        mvp["db_first_signup_at"] = gt["db_first_signup_at"]
        mvp["db_breakdown"] = gt["db_breakdown"]
        mvp["db_unmapped_reason"] = gt.get("db_unmapped_reason")
        # db_source stamps which backend produced this number. Symmetric with
        # the Railway pass (which sets "railway"); without stamping the
        # Supabase side too, x4 would see db_source=None everywhere except
        # Railway-sourced rows, which reads as "unknown source" rather than
        # the actual Supabase-sourced default. Only stamp on success — if the
        # query returned None, we have no source to attribute.
        if gt.get("db_signups_real") is not None or gt.get("db_signups") is not None:
            mvp["db_source"] = "supabase"
        if gt.get("errors"):
            errors_total += len(gt["errors"])
            mvp["db_errors"] = gt["errors"]
        queried += 1

    for mvp in ctx["mvps"]:
        mvp.setdefault("db_unmapped_reason", None)
        mvp.setdefault("db_signups_raw", mvp.get("db_signups"))
        mvp.setdefault("db_signups_real", mvp.get("db_signups"))
        mvp.setdefault("db_signups_team", 0)
        mvp.setdefault("db_signups_test", 0)
        mvp.setdefault("db_signups_filter_audit", [])
        mvp.setdefault("db_signups_real_windowed", True if mvp.get("db_signups_real") is not None else None)
        mvp.setdefault("db_first_signup_at", None)

    # Write back context (preserve base + extra fields).
    if not dry_run:
        with open(context_path, "w") as f:
            json.dump(ctx, f, indent=2)

    return {
        "step": "merged",
        "queried": queried,
        "unmapped": unmapped,
        "errors": errors_total,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list-projects")
    p_list.add_argument("--token", default=None)

    p_match = sub.add_parser("fuzzy-match")
    p_match.add_argument("--context", required=True)

    p_disc = sub.add_parser("discover-tables")
    p_disc.add_argument("--ref", required=True)

    p_q = sub.add_parser("query-signups")
    p_q.add_argument("--ref", required=True)
    p_q.add_argument("--window-days", type=int, default=90)
    p_q.add_argument("--table", default=None, help="operator override")

    p_merge = sub.add_parser("merge")
    p_merge.add_argument("--context", required=True)
    p_merge.add_argument("--config", required=True)
    p_merge.add_argument("--run-dir", default=".runs")
    p_merge.add_argument("--auto-confirm", action="store_true")
    p_merge.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)

    if args.cmd == "list-projects":
        for p in list_supabase_projects(args.token):
            print(f"{p['id']}\t{p['name']}\t{p['region']}")
        return 0

    if args.cmd == "fuzzy-match":
        ctx = json.load(open(args.context))
        names = [m["name"] for m in ctx["mvps"] if not m.get("orphan")]
        projects = list_supabase_projects()
        results = fuzzy_match_projects(names, projects)
        for name, m in results.items():
            if m:
                print(f"{name}\t{m['id']}\t{m['name']}\t{m['match_type']}")
            else:
                print(f"{name}\tNO_MATCH")
        return 0

    if args.cmd == "discover-tables":
        tables = discover_signup_tables(args.ref)
        for t in tables:
            print(f"{t['table']}\t{t['timestamp_column'] or '(no_ts)'}\tpriority={t['priority']}")
        return 0

    if args.cmd == "query-signups":
        result = query_mvp_ground_truth(args.ref, args.window_days, args.table)
        print(json.dumps(result, indent=2))
        return 0

    if args.cmd == "merge":
        result = merge_into_context(
            args.context,
            args.config,
            auto_confirm=args.auto_confirm,
            dry_run=args.dry_run,
        )
        print(json.dumps(result, indent=2))
        return 0 if result.get("step") == "merged" else 2  # exit 2 = needs_confirm

    return 1


if __name__ == "__main__":
    sys.exit(main())

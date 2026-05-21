#!/usr/bin/env python3
"""PostHog query batching helpers for /iterate --cross.

The state files use these helpers for two shapes that otherwise silently cap
portfolio-size runs:
- discovery queries with LIMIT/OFFSET pagination
- UNION ALL query groups that need bounded batch sizes
"""

from __future__ import annotations

import json
import re
import subprocess
from typing import Any


def _posthog_query(sql: str, values: dict[str, Any], project_id: str, api_key: str) -> dict:
    body = {"query": {"kind": "HogQLQuery", "query": sql, "values": values}}
    r = subprocess.run(
        [
            "curl", "-s", "-X", "POST",
            f"https://us.i.posthog.com/api/projects/{project_id}/query/",
            "-H", "Content-Type: application/json",
            "-H", f"Authorization: Bearer {api_key}",
            "--data", json.dumps(body),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        raise RuntimeError(f"PostHog query failed: curl exit {r.returncode}: {r.stderr[:200]}")
    if not r.stdout.strip():
        raise RuntimeError("PostHog query failed: empty response")
    try:
        resp = json.loads(r.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"PostHog query failed: non-JSON response: {r.stdout[:200]}") from exc
    if isinstance(resp, dict) and resp.get("error"):
        raise RuntimeError(f"PostHog query failed: {resp.get('error')}")
    if "results" not in resp or not isinstance(resp["results"], list):
        raise RuntimeError(f"PostHog query failed: missing results: {json.dumps(resp)[:400]}")
    return resp


def _page_sql(sql_template: str, limit: int, offset: int) -> str:
    if "{limit}" in sql_template or "{offset}" in sql_template:
        return sql_template.format(limit=limit, offset=offset)
    base = re.sub(r"\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$", "", sql_template, flags=re.I)
    return f"{base} LIMIT {limit} OFFSET {offset}"


def paginate_discovery_query(
    sql_template: str,
    values: dict[str, Any] | None,
    project_id: str,
    api_key: str,
    page_size: int = 200,
    max_pages: int = 20,
) -> tuple[list[list], dict[str, Any]]:
    """Run a LIMIT/OFFSET discovery query until the final short page."""
    if page_size <= 0:
        raise ValueError("page_size must be > 0")
    if max_pages <= 0:
        raise ValueError("max_pages must be > 0")

    values = values or {}
    rows: list[list] = []
    for page in range(max_pages):
        resp = _posthog_query(
            _page_sql(sql_template, page_size, page * page_size),
            values,
            project_id,
            api_key,
        )
        batch = resp["results"]
        rows.extend(batch)
        if len(batch) < page_size:
            return rows, {"status": "complete", "pages_fetched": page + 1}
    raise RuntimeError(
        f"PostHog pagination hit max_pages={max_pages}; fetched {len(rows)} rows"
    )


def run_union_batches(
    parts: list[str],
    values: dict[str, Any] | None,
    project_id: str,
    api_key: str,
    batch_size: int = 20,
) -> tuple[list[list], dict[str, Any]]:
    """Run UNION ALL query parts in bounded batches and concatenate rows."""
    if batch_size <= 0:
        raise ValueError("batch_size must be > 0")
    values = values or {}
    if not parts:
        return [], {"complete": True, "batches_run": 0, "parts_total": 0}

    rows: list[list] = []
    batches_run = 0
    for start in range(0, len(parts), batch_size):
        sql = " UNION ALL ".join(parts[start:start + batch_size])
        resp = _posthog_query(sql, values, project_id, api_key)
        rows.extend(resp["results"])
        batches_run += 1
    return rows, {
        "complete": True,
        "batches_run": batches_run,
        "parts_total": len(parts),
    }

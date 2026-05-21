#!/usr/bin/env python3
"""Tests for iterate_cross_posthog_batch.py."""

from __future__ import annotations

import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import iterate_cross_posthog_batch as batch  # noqa: E402
from gclid_filter import PAID_GCLID_FILTER, SYNTHETIC_GCLID_PREFIX  # noqa: E402


def test_paginate_discovery_query_fetches_until_short_page():
    calls = []

    def fake_query(sql, values, project_id, api_key):
        calls.append(sql)
        if "OFFSET 0" in sql:
            return {"results": [[i] for i in range(200)]}
        return {"results": [[200 + i] for i in range(50)]}

    with patch("iterate_cross_posthog_batch._posthog_query", side_effect=fake_query):
        rows, meta = batch.paginate_discovery_query(
            "SELECT x FROM events ORDER BY x LIMIT 200",
            {},
            "pid",
            "key",
            page_size=200,
        )

    assert len(rows) == 250
    assert meta == {"status": "complete", "pages_fetched": 2}
    assert calls[0].endswith("LIMIT 200 OFFSET 0")
    assert calls[1].endswith("LIMIT 200 OFFSET 200")


def test_paginate_discovery_query_uses_limit_offset_placeholders():
    seen = []

    def fake_query(sql, values, project_id, api_key):
        seen.append(sql)
        return {"results": []}

    with patch("iterate_cross_posthog_batch._posthog_query", side_effect=fake_query):
        rows, meta = batch.paginate_discovery_query(
            "SELECT x LIMIT {limit} OFFSET {offset}",
            {},
            "pid",
            "key",
            page_size=50,
        )

    assert rows == []
    assert meta["pages_fetched"] == 1
    assert seen == ["SELECT x LIMIT 50 OFFSET 0"]


def test_paginate_discovery_query_raises_on_max_pages_hit():
    with patch(
        "iterate_cross_posthog_batch._posthog_query",
        return_value={"results": [[i] for i in range(10)]},
    ):
        with pytest.raises(RuntimeError, match="max_pages"):
            batch.paginate_discovery_query(
                "SELECT x",
                {},
                "pid",
                "key",
                page_size=10,
                max_pages=2,
            )


def test_run_union_batches_splits_parts():
    sqls = []

    def fake_query(sql, values, project_id, api_key):
        sqls.append(sql)
        return {"results": [[len(sqls)]]}

    parts = [f"SELECT {i}" for i in range(45)]
    with patch("iterate_cross_posthog_batch._posthog_query", side_effect=fake_query):
        rows, meta = batch.run_union_batches(parts, {"x": 1}, "pid", "key", batch_size=15)

    assert rows == [[1], [2], [3]]
    assert meta == {"complete": True, "batches_run": 3, "parts_total": 45}
    assert len(sqls) == 3
    assert all(" UNION ALL " in sql for sql in sqls)


def test_run_union_batches_empty_fast_path():
    rows, meta = batch.run_union_batches([], {}, "pid", "key")
    assert rows == []
    assert meta == {"complete": True, "batches_run": 0, "parts_total": 0}


def test_paid_gclid_filter_excludes_ads_ready_synthetic_prefix():
    assert SYNTHETIC_GCLID_PREFIX == "Cj0KCQjw_ads_ready_synthetic_"
    assert "AND NOT startsWith" in PAID_GCLID_FILTER
    assert SYNTHETIC_GCLID_PREFIX in PAID_GCLID_FILTER

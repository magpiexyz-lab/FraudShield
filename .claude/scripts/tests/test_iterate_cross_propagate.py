#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_propagate.py."""

from __future__ import annotations

import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from iterate_cross_propagate import main  # noqa: E402


def test_propagate_raises_when_catalog_batches_status_missing():
    with tempfile.TemporaryDirectory() as td:
        context_p = os.path.join(td, "context.json")
        raw_p = os.path.join(td, "catalog-raw.json")
        output_p = os.path.join(td, "data.json")

        json.dump({"mvps": [{"name": "alpha", "owner": "Ada"}]}, open(context_p, "w"))
        json.dump({"results": []}, open(raw_p, "w"))

        with pytest.raises(RuntimeError, match="_x1_catalog_batches_status missing from catalog raw JSON"):
            main([
                "--context", context_p,
                "--catalog-raw", raw_p,
                "--output", output_p,
            ])

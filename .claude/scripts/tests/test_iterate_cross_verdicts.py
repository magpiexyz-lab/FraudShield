#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_verdicts.py.

Run:
  python3 -m pytest .claude/scripts/tests/test_iterate_cross_verdicts.py -v
  # OR (no pytest dependency):
  python3 .claude/scripts/tests/test_iterate_cross_verdicts.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from iterate_cross_verdicts import (  # noqa: E402
    DEFAULT_CONFIG,
    VERDICT_ENUM,
    VERDICT_GO,
    VERDICT_INSUFFICIENT,
    VERDICT_NO_GO,
    VERDICT_NOT_DEPLOYED,
    VERDICT_STD_VIOL,
    VERDICT_TRACKING,
    action_line,
    compute_headline_verdict,
    compute_legacy_traction_score,
    emit_telegram,
    main,
    parse_debug_prompts,
)


THRESHOLDS = DEFAULT_CONFIG["thresholds"]


def mvp(name="m", owner="alice", campaign="m-search-v1", clicks=0, signups=0, ctr=0.0, spend=0.0):
    return {
        "name": name,
        "owner": owner,
        "campaign_name": campaign,
        "google_ads": {"clicks": clicks, "ctr": ctr, "spend": spend},
        "tracking": {"signups": signups, "gclid_visitor_count": signups, "total_events_count": 100},
    }


def test_go_with_3_signups():
    score = compute_headline_verdict(mvp(clicks=40, signups=3), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_GO
    assert score["clicks_needed"] == 0


def test_go_with_more_than_3_signups():
    score = compute_headline_verdict(mvp(clicks=34, signups=6), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_GO


def test_no_go_at_clicks_floor_with_zero_signups():
    score = compute_headline_verdict(mvp(clicks=50, signups=0), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_NO_GO


def test_no_go_above_floor_with_below_threshold_signups():
    score = compute_headline_verdict(mvp(clicks=107, signups=1), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_NO_GO


def test_insufficient_data_below_floor():
    score = compute_headline_verdict(mvp(clicks=20, signups=1), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_INSUFFICIENT
    assert score["clicks_needed"] == 30


def test_insufficient_zero_clicks():
    score = compute_headline_verdict(mvp(clicks=0, signups=0), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_INSUFFICIENT
    assert score["clicks_needed"] == 50


def test_standard_violation_takes_precedence_over_signups():
    # Even with 5 signups, bid strategy violation wins.
    score = compute_headline_verdict(
        mvp(clicks=80, signups=5),
        {"bid_strategy_violation": True},
        THRESHOLDS,
    )
    assert score["headline_verdict"] == VERDICT_STD_VIOL


def test_tracking_broken_takes_precedence_over_clicks_floor():
    score = compute_headline_verdict(
        mvp(clicks=154, signups=0),
        {"tracking_broken": True},
        THRESHOLDS,
    )
    assert score["headline_verdict"] == VERDICT_TRACKING


def test_not_deployed_takes_precedence_over_no_go():
    score = compute_headline_verdict(
        mvp(clicks=40, signups=0),
        {"not_deployed": True},
        THRESHOLDS,
    )
    assert score["headline_verdict"] == VERDICT_NOT_DEPLOYED


def test_precedence_violation_over_tracking():
    # Both flags set: STANDARD_VIOLATION wins (rule 1 before rule 2).
    score = compute_headline_verdict(
        mvp(clicks=10, signups=0),
        {"bid_strategy_violation": True, "tracking_broken": True},
        THRESHOLDS,
    )
    assert score["headline_verdict"] == VERDICT_STD_VIOL


def test_soft_warning_conversion_misconfigured_does_not_change_verdict():
    score = compute_headline_verdict(
        mvp(clicks=40, signups=3),
        {"subaccount_conversion_misconfigured": True},
        THRESHOLDS,
    )
    assert score["headline_verdict"] == VERDICT_GO
    assert "subaccount_conversion_misconfigured" in score["soft_warnings"]


def test_clicks_needed_zero_for_go():
    score = compute_headline_verdict(mvp(clicks=10, signups=3), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_GO
    assert score["clicks_needed"] == 0


def test_clicks_needed_only_set_for_insufficient():
    score = compute_headline_verdict(mvp(clicks=50, signups=0), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_NO_GO
    assert score["clicks_needed"] == 0


def test_metrics_cpa_when_signups_present():
    score = compute_headline_verdict(mvp(clicks=80, signups=4, spend=100.0), {}, THRESHOLDS)
    assert score["metrics"]["cpa"] == 25.0


def test_metrics_cpa_none_when_zero_signups():
    score = compute_headline_verdict(mvp(clicks=50, signups=0, spend=72.68), {}, THRESHOLDS)
    assert score["metrics"]["cpa"] is None


def test_metrics_conv_rate_zero_when_zero_clicks():
    score = compute_headline_verdict(mvp(clicks=0, signups=0), {}, THRESHOLDS)
    assert score["metrics"]["conv_rate"] == 0.0


def test_verdict_enum_consistency():
    """Each verdict path returns a value in the registry-asserted enum."""
    cases = [
        (mvp(clicks=10, signups=3), {}, VERDICT_GO),
        (mvp(clicks=50, signups=0), {}, VERDICT_NO_GO),
        (mvp(clicks=10, signups=0), {}, VERDICT_INSUFFICIENT),
        (mvp(clicks=10, signups=0), {"bid_strategy_violation": True}, VERDICT_STD_VIOL),
        (mvp(clicks=10, signups=0), {"tracking_broken": True}, VERDICT_TRACKING),
        (mvp(clicks=10, signups=0), {"not_deployed": True}, VERDICT_NOT_DEPLOYED),
    ]
    for m, issues, expected in cases:
        score = compute_headline_verdict(m, issues, THRESHOLDS)
        assert score["headline_verdict"] == expected
        assert score["headline_verdict"] in VERDICT_ENUM


def test_telegram_block_per_owner():
    scores = [
        compute_headline_verdict(mvp(name="a", owner="alice", clicks=80, signups=5), {}, THRESHOLDS),
        compute_headline_verdict(mvp(name="b", owner="bob", clicks=20, signups=0), {}, THRESHOLDS),
    ]
    text = emit_telegram(scores, {})
    assert "alice" in text
    assert "bob" in text
    # Two blocks separated by ---
    assert text.count("---") >= 1


def test_telegram_block_under_4096():
    scores = [
        compute_headline_verdict(mvp(name=f"mvp_{i}", owner="alice", clicks=10, signups=0), {}, THRESHOLDS)
        for i in range(50)
    ]
    text = emit_telegram(scores, {})
    # Single block (all alice's), must be ≤ 4000 chars (we cap at 3990 + truncation note).
    assert len(text) <= 4096


def test_telegram_includes_debug_prompt_when_tracking_broken():
    scores = [
        compute_headline_verdict(
            mvp(name="x", owner="alice", clicks=100, signups=0),
            {"tracking_broken": True},
            THRESHOLDS,
        )
    ]
    debug_prompts = {"TRACKING_BROKEN": "Run this prompt to fix tracking..."}
    text = emit_telegram(scores, debug_prompts)
    assert "Run this prompt to fix tracking" in text


def test_action_line_formats_clicks_needed():
    line = action_line(VERDICT_INSUFFICIENT, "smelt-search-v1", clicks_needed=9)
    assert "9 more clicks" in line


def test_parse_debug_prompts_extracts_sections():
    md = """# Header

Some intro text.

## TRACKING_BROKEN

Body of tracking broken prompt.
Multi-line OK.

## NOT_DEPLOYED

Body of not deployed prompt.
"""
    parsed = parse_debug_prompts(md)
    assert "TRACKING_BROKEN" in parsed
    assert "NOT_DEPLOYED" in parsed
    assert "tracking broken prompt" in parsed["TRACKING_BROKEN"]


def test_legacy_traction_score_with_quality_score():
    m = {
        "posthog": {"demand": 4},
        "google_ads": {"ctr": 0.05, "spend": 100.0, "quality_score": 7},
    }
    score = compute_legacy_traction_score(m)
    # conversion=100, ctr=100, cost=50, qs=70 → 0.45*100 + 0.25*100 + 0.20*50 + 0.10*70 = 87
    assert score is not None
    assert 80 <= score <= 95


def test_legacy_traction_score_qs_fallback():
    m = {
        "posthog": {"demand": 1},
        "google_ads": {"ctr": 0.025, "spend": 50.0, "quality_score": 0},
    }
    score = compute_legacy_traction_score(m)
    # conversion=25, ctr=50, cost=0, qs_fallback weights → 0.50*25 + 0.30*50 + 0.20*0 = 27.5
    assert score is not None


def test_legacy_traction_score_zero_data():
    m = {"posthog": {}, "google_ads": {}}
    score = compute_legacy_traction_score(m)
    # No clicks/spend/conv/QS → conversion=0, ctr=0, cost=100 (since denominator=1), qs=0
    # qs=0 falls into qs_fallback: 0.50*0 + 0.30*0 + 0.20*100 = 20.0
    assert score is not None


def test_main_requires_output_or_emit_telegram():
    """main() should error if neither --output nor --emit-telegram is given."""
    import io
    from contextlib import redirect_stderr

    err = io.StringIO()
    with redirect_stderr(err):
        rc = main(["--data", "/dev/null", "--issues", "/dev/null"])
    assert rc == 2
    assert "must specify at least one" in err.getvalue()


def test_main_legacy_score_attaches_field():
    """When --legacy-score is set, legacy_traction_score is populated."""
    import json as _json
    import tempfile

    data = {
        "mvps": [
            {
                "name": "m",
                "owner": "alice",
                "campaign_name": "m-search",
                "google_ads": {"clicks": 80, "ctr": 0.05, "spend": 100.0, "quality_score": 7},
                "posthog": {"demand": 4, "activate": 2, "reach": 80},
                "tracking": {"signups": 4, "gclid_visitor_count": 80, "total_events_count": 200},
            }
        ]
    }
    issues = {"mvps": [{"name": "m"}]}

    with tempfile.TemporaryDirectory() as td:
        data_path = os.path.join(td, "data.json")
        issues_path = os.path.join(td, "issues.json")
        out_path = os.path.join(td, "scores.json")

        _json.dump(data, open(data_path, "w"))
        _json.dump(issues, open(issues_path, "w"))

        rc = main(
            [
                "--data", data_path,
                "--issues", issues_path,
                "--config", "/nonexistent.yaml",
                "--output", out_path,
                "--legacy-score",
            ]
        )
        assert rc == 0
        result = _json.load(open(out_path))
        assert result["mvps"][0]["legacy_traction_score"] is not None


def test_main_scores_input_skips_recomputation():
    """When --scores is provided, the script reads it and skips data/issues recomputation."""
    import json as _json
    import tempfile

    pre_scores = {
        "thresholds": {"signups_go": 3, "clicks_floor": 50},
        "mvps": [
            {
                "name": "m",
                "owner": "alice",
                "campaign_name": "m-search",
                "headline_verdict": "GO",
                "clicks_needed": 0,
                "soft_warnings": [],
                "metrics": {"clicks": 80, "signups": 5, "ctr": 0.05, "spend": 100.0, "cpa": 20.0, "conv_rate": 0.0625},
                "legacy_traction_score": None,
            }
        ],
    }
    with tempfile.TemporaryDirectory() as td:
        scores_path = os.path.join(td, "scores.json")
        telegram_path = os.path.join(td, "telegram.txt")
        _json.dump(pre_scores, open(scores_path, "w"))

        # Pass non-existent data/issues paths — the script must NOT touch them.
        rc = main(
            [
                "--data", "/nonexistent-data.json",
                "--issues", "/nonexistent-issues.json",
                "--scores", scores_path,
                "--config", "/nonexistent.yaml",
                "--debug-prompts", "/nonexistent-prompts.md",
                "--emit-telegram", telegram_path,
            ]
        )
        assert rc == 0
        text = open(telegram_path).read()
        assert "alice" in text
        assert "GO" in text


# Self-runner so this file works without pytest installed.
if __name__ == "__main__":
    import inspect

    failed = 0
    passed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn) and inspect.signature(fn).parameters == {}:
            try:
                fn()
                print(f"PASS  {name}")
                passed += 1
            except Exception as e:
                print(f"FAIL  {name}: {e!r}")
                failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)

#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_verdicts.py (PostHog-only).

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
    VERDICT_NO_DATA,
    VERDICT_NO_GO,
    VERDICT_WEAK,
    action_line,
    compute_headline_verdict,
    emit_telegram,
    main,
    parse_debug_prompts,
)


THRESHOLDS = DEFAULT_CONFIG["thresholds"]


def mvp(name="m", owner="alice", visitors=0, signups=0, signup_events=None):
    """Build a PostHog-only MVP record matching state-x2's data.json schema."""
    return {
        "name": name,
        "owner": owner,
        "gclid_visitors": visitors,
        "signups": signups,
        "signup_events": signup_events or ["signup_complete"],
        "total_events_count": 100,
        "event_catalog": [],
    }


# ---------- Verdict precedence ----------

def test_go_with_3_signups():
    score = compute_headline_verdict(mvp(visitors=40, signups=3), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_GO
    assert score["visitors_needed"] == 0


def test_go_with_more_than_3_signups():
    score = compute_headline_verdict(mvp(visitors=34, signups=6), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_GO


def test_no_go_at_floor_with_zero_signups():
    score = compute_headline_verdict(mvp(visitors=50, signups=0), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_NO_GO


def test_weak_above_floor_with_some_but_not_enough_signups():
    """≥50 visitors with 0<signups<3 → WEAK (between NO_GO and GO)."""
    score = compute_headline_verdict(mvp(visitors=107, signups=1), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_WEAK


def test_weak_with_two_signups_at_high_volume():
    score = compute_headline_verdict(mvp(visitors=200, signups=2), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_WEAK


def test_insufficient_data_below_floor():
    score = compute_headline_verdict(mvp(visitors=20, signups=1), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_INSUFFICIENT
    assert score["visitors_needed"] == 30


def test_insufficient_zero_visitors():
    score = compute_headline_verdict(mvp(visitors=0, signups=0), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_INSUFFICIENT
    assert score["visitors_needed"] == 50


def test_no_data_takes_precedence_over_signups():
    """no_event_data flag wins even with signups (shouldn't happen but defensive)."""
    score = compute_headline_verdict(
        mvp(visitors=80, signups=5),
        {"no_event_data": True},
        THRESHOLDS,
    )
    assert score["headline_verdict"] == VERDICT_NO_DATA


def test_no_data_takes_precedence_over_no_go():
    score = compute_headline_verdict(
        mvp(visitors=154, signups=0),
        {"no_event_data": True},
        THRESHOLDS,
    )
    assert score["headline_verdict"] == VERDICT_NO_DATA


def test_visitors_needed_zero_for_go():
    score = compute_headline_verdict(mvp(visitors=10, signups=3), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_GO
    assert score["visitors_needed"] == 0


def test_visitors_needed_zero_for_no_go():
    score = compute_headline_verdict(mvp(visitors=50, signups=0), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_NO_GO
    assert score["visitors_needed"] == 0


def test_visitors_needed_zero_for_weak():
    score = compute_headline_verdict(mvp(visitors=80, signups=1), {}, THRESHOLDS)
    assert score["headline_verdict"] == VERDICT_WEAK
    assert score["visitors_needed"] == 0


def test_metrics_conv_rate_when_visitors_present():
    score = compute_headline_verdict(mvp(visitors=80, signups=4), {}, THRESHOLDS)
    assert score["metrics"]["conv_rate"] == 0.05


def test_metrics_conv_rate_zero_when_zero_visitors():
    score = compute_headline_verdict(mvp(visitors=0, signups=0), {}, THRESHOLDS)
    assert score["metrics"]["conv_rate"] == 0.0


def test_signup_events_carried_through():
    score = compute_headline_verdict(
        mvp(visitors=40, signups=3, signup_events=["signup_complete", "waitlist_signup"]),
        {},
        THRESHOLDS,
    )
    assert score["signup_events"] == ["signup_complete", "waitlist_signup"]


def test_verdict_enum_consistency():
    """Each verdict path returns a value in the registry-asserted enum."""
    cases = [
        (mvp(visitors=10, signups=3), {}, VERDICT_GO),
        (mvp(visitors=50, signups=0), {}, VERDICT_NO_GO),
        (mvp(visitors=80, signups=1), {}, VERDICT_WEAK),
        (mvp(visitors=10, signups=0), {}, VERDICT_INSUFFICIENT),
        (mvp(visitors=10, signups=0), {"no_event_data": True}, VERDICT_NO_DATA),
    ]
    for m, issues, expected in cases:
        score = compute_headline_verdict(m, issues, THRESHOLDS)
        assert score["headline_verdict"] == expected
        assert score["headline_verdict"] in VERDICT_ENUM


# ---------- Telegram emission ----------

def test_telegram_block_per_owner():
    scores = [
        compute_headline_verdict(mvp(name="a", owner="alice", visitors=80, signups=5), {}, THRESHOLDS),
        compute_headline_verdict(mvp(name="b", owner="bob", visitors=20, signups=0), {}, THRESHOLDS),
    ]
    text = emit_telegram(scores, {}, visitors_floor=50)
    assert "alice" in text
    assert "bob" in text
    # Two blocks separated by ---
    assert text.count("---") >= 1


def test_telegram_unassigned_when_no_owner():
    scores = [
        compute_headline_verdict(mvp(name="a", owner=None, visitors=80, signups=5), {}, THRESHOLDS),
    ]
    text = emit_telegram(scores, {}, visitors_floor=50)
    assert "unassigned" in text


def test_telegram_block_under_4096():
    scores = [
        compute_headline_verdict(mvp(name=f"mvp_{i}", owner="alice", visitors=10, signups=0), {}, THRESHOLDS)
        for i in range(50)
    ]
    text = emit_telegram(scores, {}, visitors_floor=50)
    # Single block (all alice's), must be ≤ 4096 (we cap at 3990 + truncation note).
    assert len(text) <= 4096


def test_telegram_includes_debug_prompt_when_no_data():
    scores = [
        compute_headline_verdict(
            mvp(name="x", owner="alice", visitors=100, signups=0),
            {"no_event_data": True},
            THRESHOLDS,
        )
    ]
    debug_prompts = {"NO_DATA": "Run this prompt to fix tracking..."}
    text = emit_telegram(scores, debug_prompts, visitors_floor=50)
    assert "Run this prompt to fix tracking" in text


def test_telegram_universal_rule_uses_visitors_floor():
    scores = [
        compute_headline_verdict(mvp(name="a", visitors=10, signups=0), {}, THRESHOLDS),
    ]
    text = emit_telegram(scores, {}, visitors_floor=50)
    # Should reference the actual threshold, not "50 visitors" by accident
    assert "<50 visitors" in text or "≥50 visitors" in text


def test_action_line_formats_visitors_needed():
    line = action_line(VERDICT_INSUFFICIENT, "smelt", signups=0, visitors_needed=9, visitors_floor=50)
    assert "9 more visitors" in line
    assert "50" in line


def test_action_line_weak_mentions_signups():
    line = action_line(VERDICT_WEAK, "statistica", signups=2, visitors_needed=0, visitors_floor=50)
    assert "2 signups" in line


def test_parse_debug_prompts_extracts_sections():
    md = """# Header

Some intro text.

## NO_DATA

Body of no_data prompt.
Multi-line OK.

## WEAK

Body of weak prompt.
"""
    parsed = parse_debug_prompts(md)
    assert "NO_DATA" in parsed
    assert "WEAK" in parsed
    assert "no_data prompt" in parsed["NO_DATA"]


# ---------- main() integration ----------

def test_main_requires_output_or_emit_telegram():
    """main() should error if neither --output nor --emit-telegram is given."""
    import io
    from contextlib import redirect_stderr

    err = io.StringIO()
    with redirect_stderr(err):
        rc = main(["--data", "/dev/null", "--issues", "/dev/null"])
    assert rc == 2
    assert "must specify at least one" in err.getvalue()


def test_main_writes_output_from_data_and_issues():
    """main() reads data + issues, applies verdict, writes scores.json."""
    import json as _json
    import tempfile

    data = {
        "mvps": [
            {
                "name": "diarly",
                "owner": "lego",
                "gclid_visitors": 100,
                "signups": 8,
                "signup_events": ["signup_complete"],
                "total_events_count": 745,
                "event_catalog": [],
            }
        ]
    }
    issues = {"mvps": [{"name": "diarly", "no_event_data": False}]}

    with tempfile.TemporaryDirectory() as td:
        data_path = os.path.join(td, "data.json")
        issues_path = os.path.join(td, "issues.json")
        out_path = os.path.join(td, "scores.json")
        _json.dump(data, open(data_path, "w"))
        _json.dump(issues, open(issues_path, "w"))

        rc = main([
            "--data", data_path,
            "--issues", issues_path,
            "--config", "/nonexistent.yaml",
            "--output", out_path,
        ])
        assert rc == 0
        result = _json.load(open(out_path))
        assert result["mvps"][0]["headline_verdict"] == VERDICT_GO
        assert result["mvps"][0]["metrics"]["conv_rate"] == 0.08


def test_main_scores_input_skips_recomputation():
    """When --scores is provided, the script reads it and skips data/issues recomputation."""
    import json as _json
    import tempfile

    pre_scores = {
        "thresholds": {"signups_go": 3, "visitors_floor": 50},
        "window_days": 90,
        "mvps": [
            {
                "name": "m",
                "owner": "alice",
                "headline_verdict": "GO",
                "visitors_needed": 0,
                "metrics": {"gclid_visitors": 80, "signups": 5, "conv_rate": 0.0625},
                "signup_events": ["signup_complete"],
            }
        ],
    }
    with tempfile.TemporaryDirectory() as td:
        scores_path = os.path.join(td, "scores.json")
        telegram_path = os.path.join(td, "telegram.txt")
        _json.dump(pre_scores, open(scores_path, "w"))

        # Pass non-existent data/issues paths — the script must NOT touch them.
        rc = main([
            "--data", "/nonexistent-data.json",
            "--issues", "/nonexistent-issues.json",
            "--scores", scores_path,
            "--config", "/nonexistent.yaml",
            "--debug-prompts", "/nonexistent-prompts.md",
            "--emit-telegram", telegram_path,
        ])
        assert rc == 0
        text = open(telegram_path).read()
        assert "alice" in text
        assert "GO" in text


def test_main_emits_visitors_floor_in_universal_rule():
    """Telegram artifact's universal rule references the configured visitors_floor."""
    import json as _json
    import tempfile

    data = {"mvps": [{"name": "m", "owner": "alice", "gclid_visitors": 10, "signups": 0, "signup_events": []}]}
    issues = {"mvps": [{"name": "m"}]}
    config_yaml = "thresholds:\n  signups_go: 3\n  visitors_floor: 100\n"

    with tempfile.TemporaryDirectory() as td:
        data_path = os.path.join(td, "data.json")
        issues_path = os.path.join(td, "issues.json")
        cfg_path = os.path.join(td, "config.yaml")
        tg_path = os.path.join(td, "telegram.txt")

        _json.dump(data, open(data_path, "w"))
        _json.dump(issues, open(issues_path, "w"))
        open(cfg_path, "w").write(config_yaml)

        rc = main([
            "--data", data_path,
            "--issues", issues_path,
            "--config", cfg_path,
            "--output", os.path.join(td, "scores.json"),
            "--emit-telegram", tg_path,
        ])
        assert rc == 0
        text = open(tg_path).read()
        assert "100" in text  # The custom visitors_floor


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

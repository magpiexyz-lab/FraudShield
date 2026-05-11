#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_classify.py.

Validates the safety guards that replace per-MVP operator confirmation:
- Hard exclusion list (UI events never classified as signup)
- Operator override lock (classified_by: operator never overwritten)
- Sanity check (signups/visitors > 50% AND visitors >= 10)

Run:
  python3 .claude/scripts/tests/test_iterate_cross_classify.py
  # OR:
  python3 -m pytest .claude/scripts/tests/test_iterate_cross_classify.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from iterate_cross_classify import (  # noqa: E402
    EXCLUDED_PATTERNS,
    cmd_finalize,
    cmd_persist,
    cmd_prepare,
    filter_signup_events,
    is_excluded,
)


# ---------- Hard exclusion list ----------

def test_excluded_cta_click():
    assert is_excluded("cta_click")
    assert is_excluded("cta_clicked")
    assert is_excluded("cta_click_im_tradesperson")


def test_excluded_landing_events():
    assert is_excluded("visit_landing")
    assert is_excluded("landing_view")
    assert is_excluded("landing_viewed")
    assert is_excluded("landing_page_viewed")
    assert is_excluded("landing_cta_clicked")


def test_excluded_view_events():
    assert is_excluded("page_viewed")
    assert is_excluded("marketplace_view")
    assert is_excluded("marketplace_viewed")
    assert is_excluded("buyer_landing_view")
    assert is_excluded("pricing_view")
    assert is_excluded("feed_view")
    assert is_excluded("feed_viewed")


def test_excluded_posthog_autocapture():
    assert is_excluded("$pageview")
    assert is_excluded("$autocapture")
    assert is_excluded("$pageleave")


def test_excluded_scroll_attribution():
    assert is_excluded("scroll_depth")
    assert is_excluded("attribution_captured")
    assert is_excluded("ad_clicked")


def test_excluded_model_recommended():
    """model_recommended is a UI suggestion event, not a commitment."""
    assert is_excluded("model_recommended")


def test_NOT_excluded_signup_events():
    """Real signup events must NOT be in the exclusion list."""
    assert not is_excluded("signup_complete")
    assert not is_excluded("signup_completed")
    assert not is_excluded("signup_start")
    assert not is_excluded("waitlist_signup")
    assert not is_excluded("waitlist_submit")
    assert not is_excluded("waitlist_submitted")
    assert not is_excluded("early_access_signup")
    assert not is_excluded("buyer_signup_complete")
    assert not is_excluded("actor_registration_started")
    assert not is_excluded("form_submitted")
    assert not is_excluded("api_key_create")
    assert not is_excluded("demo_completed")
    assert not is_excluded("analysis_complete")
    assert not is_excluded("first_check_completed")
    assert not is_excluded("location_connected")
    assert not is_excluded("activate")


def test_filter_signup_events_strips_excluded():
    """filter_signup_events removes excluded events but keeps real signups."""
    kept, removed = filter_signup_events(["signup_complete", "cta_click", "landing_view"])
    assert kept == ["signup_complete"]
    assert set(removed) == {"cta_click", "landing_view"}


def test_filter_empty_list():
    kept, removed = filter_signup_events([])
    assert kept == []
    assert removed == []


def test_filter_all_excluded():
    kept, removed = filter_signup_events(["cta_click", "landing_view", "$pageview"])
    assert kept == []
    assert len(removed) == 3


def test_filter_none_excluded():
    kept, removed = filter_signup_events(["signup_complete", "form_submitted"])
    assert kept == ["signup_complete", "form_submitted"]
    assert removed == []


# ---------- prepare subcommand ----------

def _write_inputs(td, mvps, issues_flags, config=None):
    """Helper: write data + issues + config to temp paths."""
    data = {"mvps": mvps}
    issues = {"mvps": [{"name": m["name"], **flags} for m, flags in zip(mvps, issues_flags)]}
    config_data = config or {}

    data_p = os.path.join(td, "data.json")
    issues_p = os.path.join(td, "issues.json")
    config_p = os.path.join(td, "config.yaml")
    json.dump(data, open(data_p, "w"))
    json.dump(issues, open(issues_p, "w"))

    try:
        import yaml
        yaml.safe_dump(config_data, open(config_p, "w"))
    except ImportError:
        with open(config_p, "w") as f:
            f.write("mvp_mappings: {}\n")

    return data_p, issues_p, config_p


class Args:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def test_prepare_buckets_correctly():
    with tempfile.TemporaryDirectory() as td:
        mvps = [
            {"name": "skip_me", "event_catalog": []},
            {"name": "auto_me",  "event_catalog": [{"event": "signup_complete"}, {"event": "cta_click"}]},
            {"name": "llm_me",   "event_catalog": [{"event": "weird_event"}, {"event": "obscure_complete"}]},
            {"name": "empty_me", "event_catalog": []},
        ]
        flags = [
            {"signup_classified": True,  "auto_default_match": False, "needs_llm_classification": False, "no_event_data": False},
            {"signup_classified": False, "auto_default_match": True,  "needs_llm_classification": False, "no_event_data": False},
            {"signup_classified": False, "auto_default_match": False, "needs_llm_classification": True,  "no_event_data": False},
            {"signup_classified": False, "auto_default_match": False, "needs_llm_classification": False, "no_event_data": True},
        ]
        data_p, issues_p, config_p = _write_inputs(td, mvps, flags)
        out_p = os.path.join(td, "input.json")

        cmd_prepare(Args(data=data_p, issues=issues_p, config=config_p, output=out_p))

        result = json.load(open(out_p))
        assert result["to_skip"] == ["skip_me"]
        assert len(result["to_auto"]) == 2  # auto_me + empty_me
        names_auto = {e["name"] for e in result["to_auto"]}
        assert names_auto == {"auto_me", "empty_me"}
        assert len(result["to_llm"]) == 1
        assert result["to_llm"][0]["name"] == "llm_me"


def test_prepare_auto_strips_excluded():
    """When auto_default_match fires, excluded events are filtered out."""
    with tempfile.TemporaryDirectory() as td:
        mvps = [
            {"name": "tricky", "event_catalog": [
                {"event": "signup_complete"},
                {"event": "landing_view"},   # excluded; not a default whitelist member but defensive
            ]},
        ]
        flags = [{"signup_classified": False, "auto_default_match": True, "needs_llm_classification": False, "no_event_data": False}]
        data_p, issues_p, config_p = _write_inputs(td, mvps, flags, config={
            "signup_whitelist": ["signup_complete", "landing_view"],  # naughty whitelist entry
        })
        out_p = os.path.join(td, "input.json")
        cmd_prepare(Args(data=data_p, issues=issues_p, config=config_p, output=out_p))
        result = json.load(open(out_p))

        auto = next(e for e in result["to_auto"] if e["name"] == "tricky")
        assert "landing_view" not in auto["signup_events"]
        assert "signup_complete" in auto["signup_events"]


# ---------- persist subcommand ----------

def test_persist_respects_operator_override():
    """An existing mapping with classified_by=operator must NOT be overwritten."""
    with tempfile.TemporaryDirectory() as td:
        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({
                "mvp_mappings": {
                    "locked_mvp": {
                        "signup_events": ["operator_picked_event"],
                        "classified_by": "operator",
                        "owner": "alice",
                    }
                }
            }, open(config_p, "w"))
        except ImportError:
            return  # skip test if yaml not available

        input_p = os.path.join(td, "input.json")
        json.dump({
            "to_skip": [],
            "to_auto": [{"name": "locked_mvp", "signup_events": ["llm_would_pick_this"], "confidence": "strong", "rationale": "x"}],
            "to_llm": [],
        }, open(input_p, "w"))

        proposals_p = os.path.join(td, "proposals.json")
        json.dump([], open(proposals_p, "w"))

        summary_p = os.path.join(td, "summary.json")

        cmd_persist(Args(
            input=input_p, proposals=proposals_p, config=config_p, summary=summary_p
        ))

        # Re-read config
        config_after = yaml.safe_load(open(config_p))
        locked = config_after["mvp_mappings"]["locked_mvp"]
        assert locked["signup_events"] == ["operator_picked_event"]  # unchanged
        assert locked["classified_by"] == "operator"
        assert locked.get("owner") == "alice"  # preserved

        summary = json.load(open(summary_p))
        assert "locked_mvp" in summary["skipped_operator"]


def test_persist_filters_llm_excluded_events():
    """If LLM proposes an excluded event, persist strips it before writing."""
    with tempfile.TemporaryDirectory() as td:
        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({"mvp_mappings": {}}, open(config_p, "w"))
        except ImportError:
            return

        input_p = os.path.join(td, "input.json")
        json.dump({
            "to_skip": [],
            "to_auto": [],
            "to_llm": [{"name": "naughty_mvp", "event_catalog": []}],
        }, open(input_p, "w"))

        proposals_p = os.path.join(td, "proposals.json")
        json.dump([
            {"name": "naughty_mvp",
             "signup_events": ["signup_complete", "cta_click", "landing_view"],
             "confidence": "strong",
             "rationale": "LLM picked some bad events"}
        ], open(proposals_p, "w"))

        summary_p = os.path.join(td, "summary.json")
        cmd_persist(Args(
            input=input_p, proposals=proposals_p, config=config_p, summary=summary_p
        ))

        config_after = yaml.safe_load(open(config_p))
        events = config_after["mvp_mappings"]["naughty_mvp"]["signup_events"]
        assert events == ["signup_complete"]  # cta_click and landing_view stripped

        summary = json.load(open(summary_p))
        filtered = [e for e in summary["filtered_events"] if e["name"] == "naughty_mvp"]
        assert len(filtered) == 1
        assert set(filtered[0]["removed"]) == {"cta_click", "landing_view"}


def test_persist_writes_new_mvp():
    with tempfile.TemporaryDirectory() as td:
        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({"mvp_mappings": {}}, open(config_p, "w"))
        except ImportError:
            return

        input_p = os.path.join(td, "input.json")
        json.dump({
            "to_skip": [],
            "to_auto": [{"name": "new_mvp", "signup_events": ["signup_complete"], "confidence": "whitelist", "rationale": "Standard"}],
            "to_llm": [],
        }, open(input_p, "w"))

        proposals_p = os.path.join(td, "proposals.json")
        json.dump([], open(proposals_p, "w"))

        summary_p = os.path.join(td, "summary.json")
        cmd_persist(Args(
            input=input_p, proposals=proposals_p, config=config_p, summary=summary_p
        ))

        config_after = yaml.safe_load(open(config_p))
        new = config_after["mvp_mappings"]["new_mvp"]
        assert new["signup_events"] == ["signup_complete"]
        assert new["classified_by"] == "x2-whitelist"
        assert new["classified_at"]  # timestamp set


def test_persist_preserves_existing_owner_when_auto_classifying():
    """If operator set owner but no classified_by=operator, x2 can update signup_events but owner stays."""
    with tempfile.TemporaryDirectory() as td:
        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({
                "mvp_mappings": {
                    "mvp_with_owner": {"owner": "bob", "deploy_domain": "foo.com"}
                }
            }, open(config_p, "w"))
        except ImportError:
            return

        input_p = os.path.join(td, "input.json")
        json.dump({
            "to_skip": [],
            "to_auto": [{"name": "mvp_with_owner", "signup_events": ["signup_complete"], "confidence": "whitelist", "rationale": "Standard"}],
            "to_llm": [],
        }, open(input_p, "w"))

        proposals_p = os.path.join(td, "proposals.json")
        json.dump([], open(proposals_p, "w"))

        summary_p = os.path.join(td, "summary.json")
        cmd_persist(Args(
            input=input_p, proposals=proposals_p, config=config_p, summary=summary_p
        ))

        config_after = yaml.safe_load(open(config_p))
        m = config_after["mvp_mappings"]["mvp_with_owner"]
        assert m["signup_events"] == ["signup_complete"]
        assert m["owner"] == "bob"  # preserved
        assert m["deploy_domain"] == "foo.com"  # preserved


# ---------- finalize subcommand ----------

def test_finalize_applies_signup_counts():
    with tempfile.TemporaryDirectory() as td:
        data_p = os.path.join(td, "data.json")
        json.dump({"mvps": [
            {"name": "alpha", "gclid_visitors": 100},
            {"name": "beta",  "gclid_visitors": 30},
        ]}, open(data_p, "w"))

        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({"mvp_mappings": {
                "alpha": {"signup_events": ["signup_complete"], "classified_by": "x2-strong"},
                "beta":  {"signup_events": ["form_submitted"],   "classified_by": "x2-strong"},
            }}, open(config_p, "w"))
        except ImportError:
            return

        counts_p = os.path.join(td, "counts.json")
        json.dump({"results": [["alpha", 8], ["beta", 1]]}, open(counts_p, "w"))

        summary_p = os.path.join(td, "persist-summary.json")
        json.dump({"filtered_events": []}, open(summary_p, "w"))

        rc = cmd_finalize(Args(
            data=data_p, config=config_p, signup_counts=counts_p,
            persist_summary=summary_p, strict_sanity=False,
        ))
        assert rc == 0

        result = json.load(open(data_p))
        names = {m["name"]: m for m in result["mvps"]}
        assert names["alpha"]["signups"] == 8
        assert names["alpha"]["signup_events"] == ["signup_complete"]
        assert names["beta"]["signups"] == 1


def test_finalize_sanity_check_flags_high_ratio():
    """visitors=20, signups=15 → ratio 0.75 → suspect."""
    with tempfile.TemporaryDirectory() as td:
        data_p = os.path.join(td, "data.json")
        json.dump({"mvps": [
            {"name": "fake_signal", "gclid_visitors": 20},
        ]}, open(data_p, "w"))

        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({"mvp_mappings": {
                "fake_signal": {"signup_events": ["cta_click_actually_excluded"], "classified_by": "x2-loose"},
            }}, open(config_p, "w"))
        except ImportError:
            return

        counts_p = os.path.join(td, "counts.json")
        json.dump({"results": [["fake_signal", 15]]}, open(counts_p, "w"))

        summary_p = os.path.join(td, "persist-summary.json")
        json.dump({"filtered_events": []}, open(summary_p, "w"))

        # Default: warn only, exit 0
        rc = cmd_finalize(Args(
            data=data_p, config=config_p, signup_counts=counts_p,
            persist_summary=summary_p, strict_sanity=False,
        ))
        assert rc == 0

        # Strict mode: exit 1 on suspect
        rc = cmd_finalize(Args(
            data=data_p, config=config_p, signup_counts=counts_p,
            persist_summary=summary_p, strict_sanity=True,
        ))
        assert rc == 1


def test_finalize_sanity_skips_low_volume():
    """visitors=5, signups=3 → ratio 0.6 but volume <10 → NOT suspect."""
    with tempfile.TemporaryDirectory() as td:
        data_p = os.path.join(td, "data.json")
        json.dump({"mvps": [
            {"name": "low_vol", "gclid_visitors": 5},
        ]}, open(data_p, "w"))

        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({"mvp_mappings": {
                "low_vol": {"signup_events": ["signup_complete"], "classified_by": "x2-strong"},
            }}, open(config_p, "w"))
        except ImportError:
            return

        counts_p = os.path.join(td, "counts.json")
        json.dump({"results": [["low_vol", 3]]}, open(counts_p, "w"))

        summary_p = os.path.join(td, "persist-summary.json")
        json.dump({"filtered_events": []}, open(summary_p, "w"))

        rc = cmd_finalize(Args(
            data=data_p, config=config_p, signup_counts=counts_p,
            persist_summary=summary_p, strict_sanity=True,
        ))
        assert rc == 0  # no suspect despite high ratio because volume too low


def test_finalize_empty_signup_events_yields_zero_signups():
    """MVP with empty signup_events should get signups=0 even if counts.json has stale data."""
    with tempfile.TemporaryDirectory() as td:
        data_p = os.path.join(td, "data.json")
        json.dump({"mvps": [
            {"name": "no_signup_event", "gclid_visitors": 50},
        ]}, open(data_p, "w"))

        config_p = os.path.join(td, "config.yaml")
        try:
            import yaml
            yaml.safe_dump({"mvp_mappings": {
                "no_signup_event": {"signup_events": [], "classified_by": "x2-empty"},
            }}, open(config_p, "w"))
        except ImportError:
            return

        # Counts.json doesn't include this MVP (since it had no signup events to query)
        counts_p = os.path.join(td, "counts.json")
        json.dump({"results": []}, open(counts_p, "w"))

        summary_p = os.path.join(td, "persist-summary.json")
        json.dump({"filtered_events": []}, open(summary_p, "w"))

        cmd_finalize(Args(
            data=data_p, config=config_p, signup_counts=counts_p,
            persist_summary=summary_p, strict_sanity=False,
        ))

        result = json.load(open(data_p))
        m = result["mvps"][0]
        assert m["signups"] == 0
        assert m["signup_events"] == []


# Self-runner
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

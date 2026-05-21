#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_ga.py.

Run:
  python3 -m pytest .claude/scripts/tests/test_iterate_cross_ga.py -v
  # OR (no pytest dependency):
  python3 .claude/scripts/tests/test_iterate_cross_ga.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from iterate_cross_ga import (  # noqa: E402
    bucket_campaign,
    cmd_validate_csv,
    extract_mvp_name,
    is_placeholder_campaign,
    main,
    merge_ga_clicks,
    parse_ga_csv,
)


# ---------- extract_mvp_name (suffix stripping) ----------

def test_extract_strips_search_v1():
    assert extract_mvp_name("reset-app-search-v1") == "reset-app"


def test_extract_strips_underscored_search_v1():
    assert extract_mvp_name("CommissionIQ_Search_V1") == "CommissionIQ"


def test_extract_strips_validation_v1():
    assert extract_mvp_name("PubCheck_Search_Validation_V1") == "PubCheck"


def test_extract_strips_search_v2():
    assert extract_mvp_name("brigent-search-v2") == "brigent"


def test_extract_strips_v1_manual_suffix():
    assert extract_mvp_name("smelt-search-v1-manual") == "smelt"


def test_extract_strips_phase_search():
    assert extract_mvp_name("NeuralPost — Phase 1 — Search") == "NeuralPost"


def test_extract_strips_date_phase():
    assert extract_mvp_name("NeuralPost_5Day_Apr2026") == "NeuralPost"


def test_extract_strips_owner_suffix_lumen_parth():
    assert extract_mvp_name("Lumen-Parth") == "Lumen"


def test_extract_strips_owner_suffix_staylica_lew():
    assert extract_mvp_name("StaylicaAi-Lew") == "StaylicaAi"


def test_extract_strips_hashtag_number():
    assert extract_mvp_name("xpredict #2") == "xpredict"


def test_extract_handles_dubai_geo_suffix():
    assert extract_mvp_name("Handpick - Dubai Search") == "Handpick"


def test_extract_leaves_clean_names_alone():
    assert extract_mvp_name("flowops") == "flowops"
    assert extract_mvp_name("agent-cost-monitor") == "agent-cost-monitor"


# ---------- is_placeholder_campaign ----------

def test_placeholder_simple_form():
    assert is_placeholder_campaign("Campaign #1")
    assert is_placeholder_campaign("Campaign #42")
    assert is_placeholder_campaign("campaign 1")


def test_placeholder_with_owner_annotation():
    """`Campaign #1 (Parth)` — operator added a hint but never renamed."""
    assert is_placeholder_campaign("Campaign #1 (Parth)")
    assert is_placeholder_campaign("Campaign #1 (karan)")


def test_not_placeholder_real_name():
    assert not is_placeholder_campaign("xpredict")
    assert not is_placeholder_campaign("brigent-search-v2")


# ---------- bucket_campaign ----------

def test_bucket_substring_xpredict_to_x_predict():
    """match_key('xpredict') == match_key('x-predict') == 'xpredict' → substring match."""
    mvp, reason = bucket_campaign("xpredict", {"x-predict", "diarly", "lumen"})
    assert mvp == "x-predict"
    assert reason == "ph-substring"


def test_bucket_substring_with_numbered_variant():
    mvp, reason = bucket_campaign("xpredict #2", {"x-predict", "diarly"})
    assert mvp == "x-predict"
    assert reason == "ph-substring"


def test_bucket_substring_strips_search_v1():
    mvp, reason = bucket_campaign("brigent-search-v2", {"brigent", "diarly"})
    assert mvp == "brigent"
    assert reason == "ph-substring"


def test_bucket_substring_handles_compound_name():
    """rubber-duck-api-search-v1 → rubber-duck-api."""
    mvp, reason = bucket_campaign("rubber-duck-api-search-v1", {"rubber-duck-api", "x-predict"})
    assert mvp == "rubber-duck-api"
    assert reason == "ph-substring"


def test_bucket_substring_lumen_parth_to_lumen():
    mvp, reason = bucket_campaign("Lumen-Parth", {"lumen", "diarly"})
    assert mvp == "lumen"
    assert reason == "ph-substring"


def test_bucket_longest_match_wins():
    """When both 'agent' and 'agent-lens' exist, agent-lens (longer key) wins for agentlens-search-v1."""
    mvp, _ = bucket_campaign(
        "agent-lens-search-v1",
        {"agent", "agent-lens"},
    )
    assert mvp == "agent-lens"


def test_bucket_alias_for_typo():
    """StaylicaAi-Lew can't substring-match 'stylica-ai' (extra 'a'). Operator alias rescues."""
    aliases = {"staylicaai": "stylica-ai"}
    mvp, reason = bucket_campaign("StaylicaAi-Lew", {"stylica-ai", "diarly"}, aliases=aliases)
    assert mvp == "stylica-ai"
    assert reason == "alias"


def test_bucket_alias_for_disjoint_naming():
    """PubCheck_Search_Validation_V1 maps to 'verify' by operator alias only."""
    aliases = {"pubcheck": "verify"}
    mvp, reason = bucket_campaign(
        "PubCheck_Search_Validation_V1",
        {"verify", "diarly"},
        aliases=aliases,
    )
    assert mvp == "verify"
    assert reason == "alias"


def test_bucket_ga_only_auto_creation():
    """reset-app-search-v1 with no matching MVP → auto-create 'reset-app' as ga_only."""
    mvp, reason = bucket_campaign("reset-app-search-v1", {"diarly", "lumen"})
    assert mvp == "reset-app"
    assert reason == "ga-only-auto"


def test_bucket_ga_only_underscored_form():
    mvp, reason = bucket_campaign("CommissionIQ_Search_V1", {"diarly"})
    assert mvp == "commissioniq"
    assert reason == "ga-only-auto"


def test_bucket_placeholder_returns_unmatched():
    mvp, reason = bucket_campaign("Campaign #1", {"diarly"})
    assert mvp is None
    assert reason == "placeholder"


def test_bucket_skips_orphan_keys():
    """__orphan_*__ MVP keys are excluded from substring matching."""
    mvp, _reason = bucket_campaign("xpredict", {"__orphan_x__", "diarly"})
    # Falls through to ga-only-auto since no real MVP key matched
    assert mvp == "xpredict"


# ---------- parse_ga_csv ----------

def test_parse_ga_csv_with_header():
    """Real Google Ads CSV header form."""
    csv_text = "Campaign,Clicks,Conversions\nxpredict,1082,94\nbrigent-search-v2,158,0\n"
    parsed = parse_ga_csv(csv_text)
    assert len(parsed) == 2
    assert parsed[0]["name"] == "xpredict"
    assert parsed[0]["clicks"] == 1082
    assert parsed[0]["conv"] == 94.0


def test_parse_ga_csv_without_header_returns_empty():
    """Header is REQUIRED — parser must find Campaign + Clicks columns by name."""
    csv_text = "xpredict,1082\nbrigent,158\n"
    parsed = parse_ga_csv(csv_text)
    # First row is treated as header; finds no 'campaign'/'clicks' substring → []
    assert parsed == []


def test_parse_ga_csv_with_account():
    csv_text = "campaign,clicks,conv,account\nxpredict,1082,94,Lee MVP\n"
    parsed = parse_ga_csv(csv_text)
    assert parsed[0]["account"] == "Lee MVP"


def test_parse_ga_csv_arbitrary_column_order():
    """Column ORDER does not matter — parser indexes by header substring."""
    csv_text = "Account,Clicks,Conversions,Campaign\nLee MVP,1082,94,xpredict\n"
    parsed = parse_ga_csv(csv_text)
    assert len(parsed) == 1
    assert parsed[0]["name"] == "xpredict"
    assert parsed[0]["clicks"] == 1082
    assert parsed[0]["conv"] == 94.0
    assert parsed[0]["account"] == "Lee MVP"


def test_parse_ga_csv_strips_thousands_separator():
    """Google Ads CSV exports use `1,082` formatting."""
    csv_text = 'Campaign,Clicks,Conversions\nxpredict,"1,082","94"\n'
    parsed = parse_ga_csv(csv_text)
    assert parsed[0]["clicks"] == 1082
    assert parsed[0]["conv"] == 94.0


def test_parse_ga_csv_strips_utf8_bom():
    """Google Ads CSV exports as UTF-8 with BOM."""
    csv_text = "﻿Campaign,Clicks\nxpredict,1082\n"
    parsed = parse_ga_csv(csv_text)
    assert len(parsed) == 1
    assert parsed[0]["name"] == "xpredict"


def test_parse_ga_csv_skips_summary_total_row():
    """Google Ads CSV exports include a summary footer row starting with 'Total:'."""
    csv_text = "Campaign,Clicks\nxpredict,1082\nbrigent,158\nTotal,1240\n"
    parsed = parse_ga_csv(csv_text)
    assert len(parsed) == 2
    assert {c["name"] for c in parsed} == {"xpredict", "brigent"}


def test_parse_ga_csv_accepts_conv_dot_alias():
    """Header `Conv.` (Google Ads abbreviation) is recognized as conversions column."""
    csv_text = "Campaign,Clicks,Conv.\nxpredict,1082,94\n"
    parsed = parse_ga_csv(csv_text)
    assert parsed[0]["conv"] == 94.0


def test_parse_ga_csv_missing_required_columns_returns_empty():
    csv_text = "Foo,Bar\nbaz,42\n"
    parsed = parse_ga_csv(csv_text)
    assert parsed == []


def test_parse_ga_csv_skips_google_ads_preamble_and_exact_campaign_column():
    csv_text = (
        "Campaign report\n"
        "All time\n"
        "\n"
        "Campaign status,Campaign,Clicks\n"
        "Enabled,xpredict,1082\n"
    )
    parsed = parse_ga_csv(csv_text)
    assert len(parsed) == 1
    assert parsed[0]["name"] == "xpredict"
    assert parsed[0]["clicks"] == 1082


# ---------- merge_ga_clicks (end-to-end) ----------

def _mvp(name, gclid_visitors=0):
    return {
        "name": name,
        "gclid_visitors": gclid_visitors,
        "first_seen": "2026-02-01T00:00:00Z",
        "last_seen": "2026-05-01T00:00:00Z",
        "sample_utm_campaign": None,
        "owner": None,
        "deploy_domain": None,
        "phase_match": True,
        "orphan": False,
        "partial_tracking_pct": None,
    }


def test_merge_augments_existing_ph_mvp():
    mvps = [_mvp("x-predict", gclid_visitors=2545), _mvp("diarly", gclid_visitors=87)]
    campaigns = [
        {"name": "xpredict", "clicks": 1082, "conv": 94, "account": "Lee MVP"},
        {"name": "xpredict #2", "clicks": 973, "conv": 212, "account": "Lee MVP"},
        {"name": "diarly-search-v1", "clicks": 102, "conv": 0, "account": "Lew"},
    ]
    merged, unmatched = merge_ga_clicks(campaigns, mvps)
    by = {m["name"]: m for m in merged}
    assert by["x-predict"]["ga_clicks"] == 2055  # 1082 + 973
    assert by["x-predict"]["ga_conv"] == 306.0
    assert by["x-predict"]["ga_campaigns"] == sorted(["xpredict", "xpredict #2"])
    assert by["diarly"]["ga_clicks"] == 102
    assert unmatched == []


def test_merge_creates_ga_only_mvp():
    """reset-app-search-v1 → no PH MVP → creates 'reset-app' as ga_only."""
    mvps = [_mvp("diarly", gclid_visitors=87)]
    campaigns = [{"name": "reset-app-search-v1", "clicks": 58, "conv": 0, "account": "Radlin"}]
    merged, _ = merge_ga_clicks(campaigns, mvps)
    by = {m["name"]: m for m in merged}
    assert "reset-app" in by
    assert by["reset-app"]["ga_only"] is True
    assert by["reset-app"]["ga_clicks"] == 58
    assert by["reset-app"]["gclid_visitors"] == 0


def test_merge_handles_unmatched_placeholder():
    mvps = [_mvp("diarly", gclid_visitors=87)]
    campaigns = [{"name": "Campaign #1", "clicks": 21, "conv": 0, "account": "karan"}]
    _, unmatched = merge_ga_clicks(campaigns, mvps)
    assert len(unmatched) == 1
    assert unmatched[0]["reason"] == "placeholder"


def test_merge_uses_alias_map():
    mvps = [_mvp("verify"), _mvp("diarly")]
    campaigns = [{"name": "PubCheck_Search_Validation_V1", "clicks": 154, "conv": 0, "account": "Radlin"}]
    aliases = {"pubcheck": "verify"}
    merged, unmatched = merge_ga_clicks(campaigns, mvps, aliases=aliases)
    by = {m["name"]: m for m in merged}
    assert by["verify"]["ga_clicks"] == 154
    assert unmatched == []


def test_merge_idempotent_on_rerun():
    """Re-applying with the same input → same ga_clicks (not double-counted)."""
    mvps = [_mvp("x-predict", gclid_visitors=2545)]
    campaigns = [{"name": "xpredict", "clicks": 1082, "conv": 0, "account": "Lee MVP"}]
    merged1, _ = merge_ga_clicks(campaigns, mvps)
    merged2, _ = merge_ga_clicks(campaigns, merged1)
    assert merged2[0]["ga_clicks"] == 1082
    # Even when ga_clicks was already 1082, second pass overwrites cleanly


def test_merge_zero_click_campaigns_are_dropped_when_ga_only():
    """A ga-only auto-creation should not happen for a 0-click campaign."""
    mvps = []
    campaigns = [{"name": "suits-parth", "clicks": 0, "conv": 0, "account": "Parth"}]
    merged, _ = merge_ga_clicks(campaigns, mvps)
    assert merged == []


def test_merge_existing_mvp_with_zero_clicks_keeps_ga_clicks_zero():
    """If the operator has an MVP but no GA campaign clicks, ga_clicks stays 0."""
    mvps = [_mvp("ghostops", gclid_visitors=2)]
    campaigns = []
    merged, _ = merge_ga_clicks(campaigns, mvps)
    assert merged[0]["ga_clicks"] == 0


def test_merge_silent_skip_path_zeros_every_record():
    """Critical fallback path: with NO campaigns at all (Chrome MCP unavailable +
    no CSV), every existing MVP must still get ga_clicks=0 so the x0a VERIFY
    assertion (`ga_clicks in m`) passes. Without this, the silent-skip path
    would break the state machine.
    """
    mvps = [
        _mvp("x-predict", gclid_visitors=2545),
        _mvp("diarly", gclid_visitors=87),
        _mvp("__orphan_hospitica__", gclid_visitors=38),
    ]
    merged, unmatched = merge_ga_clicks([], mvps)
    # Every record has ga_clicks=0
    for m in merged:
        assert "ga_clicks" in m, f"{m['name']} missing ga_clicks"
        assert m["ga_clicks"] == 0
    # No new ga_only records added
    assert all(not m.get("ga_only") for m in merged)
    assert unmatched == []


def test_merge_silent_skip_does_not_clobber_other_fields():
    """Silent-skip must not erase pre-existing fields like gclid_visitors,
    partial_tracking_pct, or owner."""
    mvps = [{
        "name": "x-predict",
        "gclid_visitors": 2545,
        "owner": "lee",
        "partial_tracking_pct": 0.14,
        "first_seen": "2026-02-01T00:00:00Z",
        "last_seen": "2026-05-01T00:00:00Z",
    }]
    merged, _ = merge_ga_clicks([], mvps)
    assert merged[0]["gclid_visitors"] == 2545
    assert merged[0]["owner"] == "lee"
    assert merged[0]["partial_tracking_pct"] == 0.14


# ---------- merge edge cases ----------

def test_merge_attributes_ga_to_orphan_record_not_separate_ga_only():
    """When GA campaign name matches an existing __orphan_X__ record, attribute
    clicks to the orphan (not a new ga_only). Orphan = PH partial-tracking;
    ga_only = PH zero presence. The former is stricter PH presence.

    Real case: PostHog has `__orphan_hospitica__` (38 visitors with NULL
    project_name). Google Ads has `Hospitica-search-v2` (95 clicks). Merge
    must augment the orphan record, not create both rows.
    """
    mvps = [
        _mvp("diarly"),
        {
            "name": "__orphan_hospitica__",
            "gclid_visitors": 38,
            "first_seen": "2026-04-01T00:00:00Z",
            "last_seen": "2026-05-01T00:00:00Z",
            "orphan": True,
        },
    ]
    campaigns = [{"name": "Hospitica-search-v2", "clicks": 95, "conv": 0, "account": "Lew"}]
    merged, _ = merge_ga_clicks(campaigns, mvps)
    # No ga_only "hospitica" record created — clicks absorbed by orphan.
    by = {m["name"]: m for m in merged}
    assert "hospitica" not in by
    assert by["__orphan_hospitica__"]["ga_clicks"] == 95


def test_merge_alias_routes_autodropship_to_dropship_ops():
    """autodropship-search-v1 → dropship-ops via operator alias (no substring match)."""
    mvps = [_mvp("dropship-ops")]
    campaigns = [{"name": "autodropship-search-v1", "clicks": 35, "conv": 5, "account": "Lee"}]
    aliases = {"autodropship": "dropship-ops"}
    merged, _ = merge_ga_clicks(campaigns, mvps, aliases=aliases)
    by = {m["name"]: m for m in merged}
    assert by["dropship-ops"]["ga_clicks"] == 35
    assert "autodropship" not in by


def test_merge_full_experiment_data_shape_smoke():
    """Smoke test mirroring the operator-validated experiment.

    Covers: PH-substring match, alias, ga_only auto-create, placeholder skip,
    multi-campaign accumulation, idempotent suffix stripping.
    """
    mvps = [
        _mvp("x-predict", gclid_visitors=2545),
        _mvp("stylica-ai", gclid_visitors=201),
        _mvp("verify", gclid_visitors=102),
        _mvp("diarly", gclid_visitors=87),
    ]
    campaigns = [
        {"name": "xpredict", "clicks": 1082, "conv": 94, "account": "Lee MVP"},
        {"name": "xpredict #2", "clicks": 973, "conv": 212, "account": "Lee MVP"},
        {"name": "StaylicaAi-Lew", "clicks": 575, "conv": 0, "account": "Lew"},
        {"name": "verify-search-v1", "clicks": 106, "conv": 0, "account": "Lego"},
        {"name": "PubCheck_Search_Validation_V1", "clicks": 154, "conv": 0, "account": "Radlin"},
        {"name": "diarly-search-v1", "clicks": 102, "conv": 0, "account": "Lew"},
        {"name": "reset-app-search-v1", "clicks": 58, "conv": 0, "account": "Radlin"},
        {"name": "CommissionIQ_Search_V1", "clicks": 40, "conv": 0, "account": "Radlin"},
        {"name": "sdr-copilot-search-v1", "clicks": 27, "conv": 0, "account": "Radlin"},
        {"name": "Campaign #1", "clicks": 6, "conv": 0, "account": "Taran"},
    ]
    aliases = {"staylicaai": "stylica-ai", "pubcheck": "verify"}
    merged, unmatched = merge_ga_clicks(campaigns, mvps, aliases=aliases)
    by = {m["name"]: m for m in merged}

    assert by["x-predict"]["ga_clicks"] == 2055
    assert by["stylica-ai"]["ga_clicks"] == 575
    assert by["verify"]["ga_clicks"] == 260  # 106 (verify-search-v1) + 154 (PubCheck via alias)
    assert by["diarly"]["ga_clicks"] == 102
    assert by["reset-app"]["ga_only"] is True
    assert by["commissioniq"]["ga_only"] is True
    assert by["sdr-copilot"]["ga_only"] is True
    assert len(unmatched) == 1
    assert unmatched[0]["reason"] == "placeholder"


# ---------- validate-csv subcommand ----------

class _Args:
    """Minimal argparse.Namespace stand-in for direct cmd_validate_csv calls."""
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def test_validate_csv_missing_file_exits_nonzero(tmp_path=None):
    args = _Args(ga_csv=str(tempfile.mktemp(suffix=".csv")))
    assert cmd_validate_csv(args) == 2


def test_validate_csv_missing_required_columns_exits_nonzero():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
        f.write("Foo,Bar\nbaz,42\n")
        path = f.name
    try:
        rc = cmd_validate_csv(_Args(ga_csv=path))
        assert rc == 2
    finally:
        os.unlink(path)


def test_validate_csv_accepts_valid_export():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
        f.write("Campaign,Account,Clicks,Conversions\nxpredict,Lee MVP,1082,94\n")
        path = f.name
    try:
        rc = cmd_validate_csv(_Args(ga_csv=path))
        assert rc == 0
    finally:
        os.unlink(path)


def test_validate_csv_accepts_header_only_with_warning():
    """Legitimate case: date window had zero paid clicks. Soft-warn, exit 0."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
        f.write("Campaign,Clicks\n")
        path = f.name
    try:
        rc = cmd_validate_csv(_Args(ga_csv=path))
        assert rc == 0
    finally:
        os.unlink(path)


def test_validate_csv_rejects_header_only_when_context_has_gclid_traffic():
    with tempfile.TemporaryDirectory() as td:
        csv_path = os.path.join(td, "ga.csv")
        ctx_path = os.path.join(td, "ctx.json")
        open(csv_path, "w").write("Campaign,Clicks\n")
        json.dump({"mvps": [{"name": "x", "gclid_visitors": 1}]}, open(ctx_path, "w"))
        rc = cmd_validate_csv(_Args(ga_csv=csv_path, context=ctx_path))
        assert rc == 2


def test_validate_csv_handles_bom():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8") as f:
        f.write("﻿Campaign,Clicks\nxpredict,1082\n")
        path = f.name
    try:
        rc = cmd_validate_csv(_Args(ga_csv=path))
        assert rc == 0
    finally:
        os.unlink(path)


# ---------- main() integration ----------

def test_main_merge_subcommand_smoke():
    with tempfile.TemporaryDirectory() as td:
        ga_csv_path = os.path.join(td, "ga-clicks.csv")
        ctx_path = os.path.join(td, "context.json")
        unmatched_path = os.path.join(td, "unmatched.json")

        with open(ga_csv_path, "w", encoding="utf-8") as f:
            f.write("Campaign,Clicks,Conversions,Account\n")
            f.write("xpredict,1082,94,Lee MVP\n")
            f.write("reset-app-search-v1,58,0,Radlin\n")

        json.dump({
            "mvps": [_mvp("x-predict", gclid_visitors=2545)],
            "mode": "cross",
            "window_days": 90,
        }, open(ctx_path, "w"))

        rc = main([
            "merge",
            "--ga-csv", ga_csv_path,
            "--context", ctx_path,
            "--config", os.path.join(td, "no-such-config.yaml"),
            "--unmatched-out", unmatched_path,
        ])
        assert rc == 0

        result = json.load(open(ctx_path))
        by = {m["name"]: m for m in result["mvps"]}
        assert by["x-predict"]["ga_clicks"] == 1082
        assert "reset-app" in by  # ga_only auto-created
        assert by["reset-app"]["ga_only"] is True


def test_main_validate_csv_subcommand_smoke():
    with tempfile.TemporaryDirectory() as td:
        ga_csv_path = os.path.join(td, "ga.csv")
        with open(ga_csv_path, "w", encoding="utf-8") as f:
            f.write("Campaign,Clicks\nxpredict,1082\n")
        rc = main(["validate-csv", "--ga-csv", ga_csv_path])
        assert rc == 0

        # Now break the CSV — missing Clicks column
        with open(ga_csv_path, "w", encoding="utf-8") as f:
            f.write("Campaign,Account\nxpredict,Lee\n")
        rc = main(["validate-csv", "--ga-csv", ga_csv_path])
        assert rc == 2


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

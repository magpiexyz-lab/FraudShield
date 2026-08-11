#!/usr/bin/env python3
"""Tests for the phase2 decision ledger + run-metrics/archive tiers (x5a) and
the run-identity stalled-streak logic. Every case here is a concrete
counterexample from the /solve critic rounds that shaped the design.

Run:
  python3 -m pytest .claude/scripts/tests/test_iterate_cross_ledger_phase2.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import iterate_cross_ledger as L  # noqa: E402
import iterate_cross_runlog as R  # noqa: E402
from iterate_cross_verdicts import _read_prev_ledger, annotate_stalled  # noqa: E402

ALIASES = {"muse-ai": ["museai-studio"]}
THRESHOLDS = {
    "visitors_floor": 300,
    "channel_starve_min_days": 21,
    "stalled_escalate_days": 14,
}


def _p2_score(name="museai-studio", verdict="INSUFFICIENT_DATA", clicks=208,
              pay_intents=0, ads_stopped=False, **metric_overrides):
    metrics = {
        "ga_clicks": clicks,
        "pay_intents": pay_intents,
        "pay_intent_rate": 0.0,
        "revenue_intent_per_click": 0.0,
        "pay_intent_source": "ph",
        "campaign_age_days": None,
        "ga_impressions": None,
        "stalled_bucket": "none",
        "stalled_cause": None,
        "stalled_since": None,
        "stalled_streak": 0,
        "stalled_escalated": False,
    }
    metrics.update(metric_overrides)
    return {
        "name": name,
        "headline_verdict": verdict,
        "metrics": metrics,
        "phase2_ads_all_stopped": ads_stopped,
        "owner": "lee",
    }


def _ctx_mvp(name="museai-studio"):
    return {
        "name": name,
        "ga_cost": 123.45,
        "ga_cpc": 0.59,
        "ga_currency": "USD",
        "ga_conv": 2,
        "ga_impressions": 5000,
        "ga_campaigns": ["museai-search-phase2-v1"],
        # Structurally empty under --phase-filter runs (round-2 Concern 1):
        "ga_cost_phase2": None,
        "ga_campaigns_phase2": [],
    }


class TestPhase2Snapshot(unittest.TestCase):
    def test_reader_contract_fields_and_ctx_spend_whitelist(self):
        snap = L.phase2_current_snapshot(
            _p2_score(), _ctx_mvp(), "", "2026-08-03", "run-A", "2026-08-03T13:41:00Z")
        for key in ("ga_clicks", "last_run", "run_id", "stalled_bucket",
                    "stalled_cause", "stalled_since", "stalled_streak"):
            self.assertIn(key, snap)
        self.assertEqual(snap["ga_clicks"], 208)
        self.assertEqual(snap["last_run"], "2026-08-03")
        # Spend fields come from the ctx row, NOT the (cost-less) metrics —
        # and never from the structurally-empty *_phase2 slices.
        self.assertEqual(snap["ga_cost"], 123.45)
        self.assertEqual(snap["ga_currency"], "USD")
        self.assertEqual(snap["ga_campaigns"], ["museai-search-phase2-v1"])
        # No false lifecycle stamping (round-2 Concern: 'active' forever).
        self.assertNotIn("lifecycle_status", snap)

    def test_upsert_keys_raw_name_and_stamps_canonical(self):
        idx = L.build_alias_index(ALIASES)
        row = L.upsert_phase2_row(None, _p2_score(), idx, "2026-08-03", "",
                                  "run-A", "2026-08-03T13:41:00Z", _ctx_mvp())
        self.assertEqual(row["mvp"], "museai-studio")       # raw key
        self.assertEqual(row["mvp_canonical"], "muse-ai")   # canonical field
        self.assertEqual(row["phase"], "phase-2")
        self.assertEqual(row["first_seen_in_ledger"], "2026-08-03")

    def test_history_entries_carry_metrics_and_dedup_by_verdict_why(self):
        idx = L.build_alias_index({})
        row = L.upsert_phase2_row(None, _p2_score(), idx, "2026-08-03", "",
                                  "run-A", "t1", None)
        row2 = L.upsert_phase2_row(row, _p2_score(clicks=250), idx, "2026-08-05", "",
                                   "run-B", "t2", None)
        # Same verdict+why → single history entry despite the metric change.
        self.assertEqual(len(row2["verdict_history"]), 1)
        self.assertEqual(row2["verdict_history"][0]["ga_clicks"], 208)
        # current still tracks the newest run.
        self.assertEqual(row2["current"]["ga_clicks"], 250)
        self.assertEqual(row2["current"]["run_id"], "run-B")

    def test_config_killed_freezes_and_locks_terminal_verdict(self):
        idx = L.build_alias_index({})
        row = L.upsert_phase2_row(None, _p2_score(name="handpick", verdict="NO_GO",
                                                  clicks=307), idx,
                                  "2026-08-03", "terminal", "run-A", "t1", None,
                                  lifecycle_status="killed")
        self.assertEqual(row["archived_at"], "2026-08-03")
        self.assertEqual(row["current"]["verdict"], "NO_GO")
        # Post-teardown run (clicks collapse to 0) must NOT rewrite the record.
        row2 = L.upsert_phase2_row(row, _p2_score(name="handpick", clicks=0),
                                   idx, "2026-09-01", "", "run-B", "t2", None)
        self.assertEqual(row2["current"]["verdict"], "NO_GO")
        self.assertEqual(row2["current"]["ga_clicks"], 307)

    def test_alias_collision_hard_fails(self):
        idx = L.build_alias_index(ALIASES)
        with self.assertRaises(ValueError):
            L.assert_no_alias_key_collision({"muse-ai", "museai-studio"}, idx)
        L.assert_no_alias_key_collision({"museai-studio", "diarly"}, idx)  # no raise

    def test_phase2_why_is_mechanical_for_no_go(self):
        why = L.phase2_why(_p2_score(verdict="NO_GO", clicks=307,
                                     pay_intent_rate=0.0163),
                           {"pay_intent_rate_go": 0.02})
        self.assertIn("1.63%", why)
        self.assertIn("307", why)
        self.assertEqual(L.phase2_why(_p2_score(), {}), "")

    def test_early_pass_go_row_records_verbatim(self):
        """#2152: a sub-floor early GO (metrics.early_pass set, clicks < 300)
        persists as computed — the ledger never re-derives INSUF from clicks —
        and the sentinel rides in `current` so batch readers can tell a
        floor-guaranteed early GO from an at-floor GO."""
        snap = L.phase2_current_snapshot(
            _p2_score(verdict="GO", clicks=120, pay_intents=8,
                      pay_intent_rate=0.0667, pay_intent_source="db_real",
                      early_pass="worst_case_floor_bound"),
            _ctx_mvp(), "", "2026-08-07", "run-A", "t1")
        self.assertEqual(snap["verdict"], "GO")
        self.assertEqual(snap["ga_clicks"], 120)
        self.assertEqual(snap["early_pass"], "worst_case_floor_bound")
        # At-floor rows read back None — additive field, old rows unaffected.
        plain = L.phase2_current_snapshot(
            _p2_score(), _ctx_mvp(), "", "2026-08-07", "run-A", "t1")
        self.assertIsNone(plain["early_pass"])


class TestPersistPhase2EndToEnd(unittest.TestCase):
    def test_persist_skips_orphans_and_read_back_matches_raw_lookup(self):
        with tempfile.TemporaryDirectory() as td:
            scores_p = os.path.join(td, "scores.json")
            ctx_p = os.path.join(td, "ctx.json")
            cfg_p = os.path.join(td, "cfg.yaml")
            ledger_p = os.path.join(td, "p2.jsonl")
            json.dump({
                "reference_now": "2026-08-03T04:21:36Z",
                "thresholds": {"pay_intent_rate_go": 0.02},
                "mvps": [_p2_score(), _p2_score(name="__orphan_museai__")],
            }, open(scores_p, "w"))
            json.dump({"mvps": [_ctx_mvp()]}, open(ctx_p, "w"))
            import yaml
            yaml.safe_dump({"mvp_aliases": ALIASES, "mvp_mappings": {}}, open(cfg_p, "w"))

            rc = L.cmd_persist_phase2(scores_p, ctx_p, ledger_p, cfg_p,
                                      now_iso=None, run_id="run-A")
            self.assertEqual(rc, 0)
            prev = _read_prev_ledger(ledger_p)
            self.assertIn("museai-studio", prev)          # raw-name lookup works
            self.assertNotIn("__orphan_museai__", prev)   # orphans excluded
            cur = prev["museai-studio"]["current"]
            self.assertEqual(cur["last_run"], "2026-08-03")  # reference_now date
            self.assertEqual(cur["run_id"], "run-A")
            self.assertEqual(cur["ga_cost"], 123.45)


class TestRunIdentityStreak(unittest.TestCase):
    def _prev(self, run_id="run-A", streak=1, since="2026-07-01"):
        return {"museai-studio": {
            "mvp": "museai-studio",
            "first_seen_in_ledger": "2026-06-01",
            "current": {"ga_clicks": 208, "last_run": "2026-08-01",
                        "stalled_bucket": "stalled", "stalled_cause": None,
                        "stalled_since": since, "stalled_streak": streak,
                        "run_id": run_id},
        }}

    def test_distinct_run_id_advances_streak_on_frozen_clock(self):
        # Data clock frozen: ref date == prev last_run (delta_days == 0) —
        # the round-2 Concern 4 self-cancelling-clock counterexample.
        score = _p2_score()
        annotate_stalled([score], THRESHOLDS, self._prev(run_id="run-A"),
                         reference_now="2026-08-01T04:00:00Z",
                         current_run_id="run-B")
        m = score["metrics"]
        self.assertEqual(m["stalled_streak"], 2)
        self.assertEqual(m["stalled_bucket"], "stalled")
        self.assertTrue(m["stalled_escalated"])  # streak>=2, sustained 31d>=14d

    def test_same_run_id_re_run_stays_idempotent(self):
        score = _p2_score()
        annotate_stalled([score], THRESHOLDS, self._prev(run_id="run-A"),
                         reference_now="2026-08-01T04:00:00Z",
                         current_run_id="run-A")
        self.assertEqual(score["metrics"]["stalled_streak"], 1)  # carried verbatim

    def test_no_current_run_id_keeps_legacy_behavior(self):
        score = _p2_score()
        annotate_stalled([score], THRESHOLDS, self._prev(run_id="run-A"),
                         reference_now="2026-08-01T04:00:00Z")
        self.assertEqual(score["metrics"]["stalled_streak"], 1)  # carried verbatim

    def test_first_seen_in_ledger_age_fallback_with_null_start_date(self):
        # campaign_age_days=None on 8/8 live rows (no Start date in export) —
        # age must fall back to first_seen_in_ledger, and a young row stays
        # untouched (round-2 Concern 5's honest-horizon path).
        young_prev = self._prev()
        young_prev["museai-studio"]["first_seen_in_ledger"] = "2026-07-25"
        score = _p2_score()
        annotate_stalled([score], THRESHOLDS, young_prev,
                         reference_now="2026-08-05T00:00:00Z",
                         current_run_id="run-B")
        self.assertEqual(score["metrics"]["stalled_streak"], 0)  # age 11d < 21d gate


class TestRunlogTier(unittest.TestCase):
    def test_pii_guard_rejects_emails_including_utf16(self):
        with self.assertRaises(R.PiiViolation):
            R.assert_no_pii("contact user@example.com now")
        with self.assertRaises(R.PiiViolation):
            R.assert_no_pii("Campaign\tuser@example.com".encode("utf-16"))
        R.assert_no_pii("no addresses here")  # no raise

    def test_projection_is_whitelist_and_guard_rejects_forbidden_names(self):
        # Whitelist projection: a *_audit input key never reaches the row.
        row = R.build_run_metrics_row(2, "run-A", None, "t", {
            "name": "x", "metrics": {}, "db_signups_filter_audit": [{"e": 1}]})
        self.assertNotIn("db_signups_filter_audit", row)
        # The field-name guard catches a future editor adding one to a row.
        with self.assertRaises(R.PiiViolation):
            R.append_run_metrics([{"mvp": "x", "db_pay_intents_filter_audit": []}],
                                 path=os.devnull)
        row = R.build_run_metrics_row(2, "run-A", "2026-08-03T04:21:36Z", "t",
                                      _p2_score(), ctx_mvp=_ctx_mvp(),
                                      mvp_canonical="muse-ai")
        self.assertEqual(row["mvp_canonical"], "muse-ai")
        self.assertEqual(row["ga_cost"], 123.45)  # ctx fallback fills metric gap

    def test_early_pass_sentinel_projected(self):
        # #2152: batch/trend queries must distinguish a floor-guaranteed early
        # GO from an at-floor GO — the sentinel is whitelisted in _METRIC_KEYS.
        row = R.build_run_metrics_row(
            2, "run-A", None, "t",
            _p2_score(verdict="GO", clicks=120, pay_intents=8,
                      early_pass="worst_case_floor_bound"))
        self.assertEqual(row["verdict"], "GO")
        self.assertEqual(row["early_pass"], "worst_case_floor_bound")

    def test_orphans_included_in_run_metrics(self):
        row = R.build_run_metrics_row(2, "run-A", None, "t",
                                      _p2_score(name="__orphan_museai__"),
                                      ctx_mvp={"ga_campaigns": ["museai-x"]})
        self.assertTrue(row["orphan"])
        self.assertEqual(row["ga_campaigns"], ["museai-x"])

    def test_append_run_metrics_appends_jsonl(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "rm.jsonl")
            rows = [R.build_run_metrics_row(2, "run-A", None, "t", _p2_score())]
            self.assertEqual(R.append_run_metrics(rows, path=path), 1)
            self.assertEqual(R.append_run_metrics(rows, path=path), 1)
            lines = [json.loads(l) for l in open(path)]
            self.assertEqual(len(lines), 2)  # append-only, reader dedupes
            self.assertEqual(lines[0]["schema_version"], R.SCHEMA_VERSION)


class TestArchiveTier(unittest.TestCase):
    def _src(self, td, name, content=b"Campaign\tClicks\nx\t1\n"):
        p = os.path.join(td, name)
        with open(p, "wb") as f:
            f.write(content)
        return p

    def test_archive_writes_index_and_dedupes_identical_sha_set(self):
        with tempfile.TemporaryDirectory() as td:
            root = os.path.join(td, "runs-archive")
            src = self._src(td, "ga.csv")
            r1 = R.archive_run_files("cross", [(src, "ga.csv")], "run-A",
                                     archive_root=root)
            self.assertFalse(r1["skipped"])
            idx = [json.loads(l) for l in open(os.path.join(root, "index.jsonl"))]
            self.assertEqual(len(idx), 1)
            self.assertEqual(idx[0]["mode"], "cross")
            # Same bytes again (x3 re-run after persist) → skip, no new dir.
            r2 = R.archive_run_files("cross", [(src, "ga.csv")], "run-A",
                                     archive_root=root)
            self.assertTrue(r2["skipped"])

    def test_sha_mismatch_warns_and_flags_never_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            root = os.path.join(td, "runs-archive")
            src = self._src(td, "ga.csv")
            r = R.archive_run_files("cross", [(src, "ga.csv")], "run-A",
                                    expected_csv_sha="deadbeef" * 8,
                                    archive_root=root)
            self.assertFalse(r["skipped"])
            self.assertTrue(r["csv_changed_since_consume"])
            idx = [json.loads(l) for l in open(os.path.join(root, "index.jsonl"))]
            self.assertTrue(idx[0]["csv_changed_since_consume"])

    def test_existing_dir_fails_loud_and_pii_refused(self):
        import datetime
        with tempfile.TemporaryDirectory() as td:
            root = os.path.join(td, "runs-archive")
            src = self._src(td, "ga.csv")
            fixed = datetime.datetime(2026, 8, 7, 12, 0, 0,
                                      tzinfo=datetime.timezone.utc)
            R.archive_run_files("cross", [(src, "ga.csv")], "run-A",
                                archive_root=root, now=fixed)
            src2 = self._src(td, "other.csv", b"different bytes\n")
            with self.assertRaises(FileExistsError):
                R.archive_run_files("cross", [(src2, "ga.csv")], "run-B",
                                    archive_root=root, now=fixed)
            bad = self._src(td, "bad.json", b'{"email": "leak@example.com"}')
            with self.assertRaises(R.PiiViolation):
                R.archive_run_files("cross", [(bad, "bad.json")], "run-C",
                                    archive_root=root)


class TestPhase1Additive(unittest.TestCase):
    def test_phase1_snapshot_gains_spend_and_run_identity(self):
        score = {
            "name": "diarly", "headline_verdict": "INSUFFICIENT_DATA",
            "ga_campaigns": ["diarly-search-v1"],
            "metrics": {"ga_clicks": 164, "ga_cost": 96.7, "ga_cpc_usd": 0.59,
                        "ga_currency": "USD", "implied_cac_usd": None,
                        "cpc_payback_multiple": 1.2,
                        "effective_cpc_cap_usd": 2.5,
                        "cpc_unit_economics_fail": False},
        }
        snap = L.current_snapshot(score, "", "2026-08-07",
                                  run_id="run-A", persisted_at="t")
        self.assertEqual(snap["ga_cost"], 96.7)
        self.assertEqual(snap["ga_campaigns"], ["diarly-search-v1"])
        self.assertEqual(snap["run_id"], "run-A")
        # Old readers tolerate the additive fields; core fields intact.
        self.assertEqual(snap["ga_clicks"], 164)


if __name__ == "__main__":
    unittest.main(verbosity=2)

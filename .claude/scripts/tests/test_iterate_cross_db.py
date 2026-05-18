#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_db.py.

Pure-function units: normalize_name, fuzzy_match_projects, sanity flags.
Network code (_management_api_query) is isolated and tested by monkeypatch.

Run:
  python3 .claude/scripts/tests/test_iterate_cross_db.py
  # OR:
  python3 -m pytest .claude/scripts/tests/test_iterate_cross_db.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import iterate_cross_db as db  # noqa: E402
import iterate_cross_verdicts as verdicts  # noqa: E402


class NormalizeNameTests(unittest.TestCase):
    def test_strips_punctuation(self):
        self.assertEqual(db.normalize_name("stylica-ai"), "stylicaai")
        self.assertEqual(db.normalize_name("agent-cost-monitor"), "agentcostmonitor")

    def test_handles_empty_and_none(self):
        self.assertEqual(db.normalize_name(""), "")
        self.assertEqual(db.normalize_name(None), "")

    def test_lowercases(self):
        self.assertEqual(db.normalize_name("DiArly"), "diarly")


class FuzzyMatchProjectsTests(unittest.TestCase):
    def setUp(self):
        self.projects = [
            {"id": "ref_stylica", "name": "stylica-ai"},
            {"id": "ref_neuralpost", "name": "neuralpost-prod"},
            {"id": "ref_diarly", "name": "diarly"},
            {"id": "ref_agentcost_v2", "name": "agent-cost-monitor"},
            {"id": "ref_staging_stylica", "name": "stylica-ai-staging"},
        ]

    def test_exact_match_wins(self):
        result = db.fuzzy_match_projects(["stylica-ai"], self.projects)
        self.assertEqual(result["stylica-ai"]["id"], "ref_stylica")
        self.assertEqual(result["stylica-ai"]["match_type"], "exact")

    def test_project_name_contains_mvp(self):
        # 'neuralpost' MVP → 'neuralpost-prod' project (only one candidate)
        result = db.fuzzy_match_projects(["neuralpost"], self.projects)
        self.assertEqual(result["neuralpost"]["id"], "ref_neuralpost")
        self.assertEqual(result["neuralpost"]["match_type"], "project_contains_mvp")

    def test_ambiguous_project_contains_mvp(self):
        # 'stylica' → both 'stylica-ai' (exact) doesn't apply here; both
        # 'stylica-ai' and 'stylica-ai-staging' CONTAIN 'stylica'.
        projects_no_exact = [
            {"id": "ref_a", "name": "stylica-ai"},
            {"id": "ref_b", "name": "stylica-ai-staging"},
        ]
        result = db.fuzzy_match_projects(["stylica"], projects_no_exact)
        self.assertEqual(result["stylica"]["match_type"], "ambiguous_project_contains_mvp")
        # Prefer shortest (less staging-likely) name
        self.assertEqual(result["stylica"]["id"], "ref_a")
        self.assertEqual(result["stylica"]["alternatives"], ["ref_b"])

    def test_mvp_contains_project(self):
        # 'agent-cost-monitor-v2' → 'agent-cost-monitor' (project name is substring of MVP)
        result = db.fuzzy_match_projects(["agent-cost-monitor-v2"], self.projects)
        self.assertEqual(result["agent-cost-monitor-v2"]["match_type"], "mvp_contains_project")
        self.assertEqual(result["agent-cost-monitor-v2"]["id"], "ref_agentcost_v2")

    def test_no_match_returns_none(self):
        result = db.fuzzy_match_projects(["unknown-mvp"], self.projects)
        self.assertIsNone(result["unknown-mvp"])

    def test_empty_mvp_name_returns_none(self):
        result = db.fuzzy_match_projects([""], self.projects)
        self.assertIsNone(result[""])


class DiscoverSignupTablesTests(unittest.TestCase):
    """The discover_signup_tables function calls _management_api_query.
    Patch that to return canned schema rows; assert correct prioritization."""

    @patch("iterate_cross_db._management_api_query")
    def test_picks_signup_table_first(self, mock_api):
        # Catalog from a hospitica-like project: only public.signups + public.access_tokens
        mock_api.return_value = [
            {"table_name": "access_tokens", "columns": "id,token,expires_at"},
            {"table_name": "signups", "columns": "id,email,created_at"},
            {"table_name": "users", "columns": "id,email,inserted_at"},
        ]
        tables = db.discover_signup_tables("test-ref")
        names = [t["table"] for t in tables]
        # signups (priority 0) before users (priority 6)
        self.assertEqual(names[0], "signups")
        # access_tokens does not match any pattern → excluded
        self.assertNotIn("access_tokens", names)

    @patch("iterate_cross_db._management_api_query")
    def test_finds_timestamp_column(self, mock_api):
        mock_api.return_value = [
            {"table_name": "waitlist", "columns": "id,email,created_at,name"},
            {"table_name": "early_access", "columns": "id,email"},  # no ts
        ]
        tables = db.discover_signup_tables("test-ref")
        by_name = {t["table"]: t for t in tables}
        self.assertEqual(by_name["waitlist"]["timestamp_column"], "created_at")
        self.assertIsNone(by_name["early_access"]["timestamp_column"])

    @patch("iterate_cross_db._management_api_query")
    def test_excludes_known_false_positives(self, mock_api):
        mock_api.return_value = [
            {"table_name": "team_members", "columns": "id,user_id"},
            {"table_name": "team_invites", "columns": "id,email"},
            {"table_name": "billing_users", "columns": "id"},
            {"table_name": "users", "columns": "id,email,created_at"},
        ]
        tables = db.discover_signup_tables("test-ref")
        names = [t["table"] for t in tables]
        self.assertNotIn("team_members", names)
        self.assertNotIn("team_invites", names)
        self.assertNotIn("billing_users", names)
        self.assertIn("users", names)


class QueryMvpGroundTruthTests(unittest.TestCase):
    """End-to-end probe with mocked API responses."""

    @patch("iterate_cross_db._management_api_query")
    def test_picks_max_count_table(self, mock_api):
        """When both auth.users and public.waitlist exist, take MAX (the larger one)
        as ground truth — diarly/smelt pattern where both surfaces accept signups."""
        # Simulate the sequence of API calls:
        # 1. count_auth_users_in_window
        # 2. discover_signup_tables (schema query)
        # 3. count_signups_in_window for each candidate
        mock_api.side_effect = [
            [{"total": 30, "confirmed": 23, "first_at": "2026-04-15T00:00:00+00:00"}],  # auth.users
            [  # schema
                {"table_name": "waitlist", "columns": "id,email,created_at"},
                {"table_name": "profiles", "columns": "id,user_id,created_at"},
            ],
            [{"n": 5, "first_at": "2026-04-20T00:00:00+00:00"}],   # public.waitlist count
            [{"n": 50, "first_at": "2026-04-10T00:00:00+00:00"}],  # public.profiles count
        ]
        result = db.query_mvp_ground_truth("test-ref", window_days=90)
        # profiles (50) > auth.users.confirmed (23) > waitlist (5). Profiles wins.
        self.assertEqual(result["db_signups"], 50)
        self.assertEqual(result["db_signups_table"], "public.profiles")
        # Earliest across all tables propagates as db_first_signup_at.
        self.assertEqual(result["db_first_signup_at"], "2026-04-10T00:00:00+00:00")
        self.assertIn("auth.users.confirmed", result["db_breakdown"])
        self.assertIn("public.waitlist", result["db_breakdown"])
        self.assertIn("public.profiles", result["db_breakdown"])

    @patch("iterate_cross_db._management_api_query")
    def test_auth_users_only(self, mock_api):
        """stylica-ai pattern: auth.users is the sole signup table."""
        mock_api.side_effect = [
            [{"total": 7, "confirmed": 5, "first_at": "2026-04-13T15:08:55+00:00"}],
            [  # schema — no signup-shape tables in public
                {"table_name": "contact_messages", "columns": "id,name,message"},
                {"table_name": "generations", "columns": "id,user_id,image_url"},
            ],
        ]
        result = db.query_mvp_ground_truth("test-ref", window_days=90)
        self.assertEqual(result["db_signups"], 5)
        self.assertEqual(result["db_signups_table"], "auth.users.confirmed")

    @patch("iterate_cross_db._management_api_query")
    def test_operator_override_skips_discovery(self, mock_api):
        """When operator specifies db_signup_table, only that table is queried."""
        mock_api.side_effect = [
            [  # schema query (called by override path to find ts column)
                {"table_name": "waitlist_subscribers_only", "columns": "id,email,created_at"},
            ],
            [{"n": 17, "first_at": "2026-04-15T00:00:00+00:00"}],
        ]
        result = db.query_mvp_ground_truth(
            "test-ref",
            window_days=90,
            operator_override_table="public.waitlist_subscribers_only",
        )
        self.assertEqual(result["db_signups"], 17)
        self.assertEqual(result["db_signups_table"], "public.waitlist_subscribers_only")

    @patch("iterate_cross_db._management_api_query")
    def test_api_error_is_captured(self, mock_api):
        mock_api.return_value = {"error": "401 unauthorized"}
        result = db.query_mvp_ground_truth("test-ref", window_days=90)
        # auth.users error + schema error → fallthrough to "no tables found"
        self.assertIsNone(result["db_signups"])
        self.assertTrue(result["errors"])


class MergeIntoContextSourceStampTests(unittest.TestCase):
    """Supabase pass must set db_source='supabase' on successful queries.

    Without this stamp, the schema is asymmetric with the Railway pass
    (which sets db_source='railway'): x4 would see db_source=None for all
    Supabase rows and read it as "unknown source" rather than the actual
    default Supabase attribution.
    """

    @patch("iterate_cross_db.list_supabase_projects")
    @patch("iterate_cross_db.query_mvp_ground_truth")
    def test_supabase_success_stamps_db_source(self, mock_q, mock_list):
        mock_list.return_value = [{"id": "ref_alpha", "name": "alpha"}]
        mock_q.return_value = {
            "db_signups": 12, "db_signups_table": "public.users",
            "db_first_signup_at": "2026-04-01", "db_breakdown": {"public.users": 12},
            "errors": None,
        }
        with tempfile.TemporaryDirectory() as t:
            ctx_path = os.path.join(t, "ctx.json")
            cfg_path = os.path.join(t, "cfg.yaml")
            with open(ctx_path, "w") as f:
                json.dump({"window_days": 90, "mvps": [
                    {"name": "alpha"},
                ]}, f)
            import yaml as _yaml
            with open(cfg_path, "w") as f:
                _yaml.safe_dump({"mvp_mappings": {
                    "alpha": {"supabase_project_ref": "ref_alpha"},
                }}, f)
            _ = db.merge_into_context(ctx_path, cfg_path, auto_confirm=True)
            updated = json.load(open(ctx_path))
            m = updated["mvps"][0]
            self.assertEqual(m["db_signups"], 12)
            self.assertEqual(m["db_source"], "supabase")

    @patch("iterate_cross_db.list_supabase_projects")
    @patch("iterate_cross_db.query_mvp_ground_truth")
    def test_supabase_no_signups_does_not_stamp_db_source(self, mock_q, mock_list):
        # When query returns None, don't claim Supabase as the source — there's
        # no source to attribute and the Railway fallback might fill it later.
        mock_list.return_value = [{"id": "ref_alpha", "name": "alpha"}]
        mock_q.return_value = {
            "db_signups": None, "db_signups_table": None,
            "db_first_signup_at": None, "db_breakdown": {},
            "errors": ["query failed"],
        }
        with tempfile.TemporaryDirectory() as t:
            ctx_path = os.path.join(t, "ctx.json")
            cfg_path = os.path.join(t, "cfg.yaml")
            with open(ctx_path, "w") as f:
                json.dump({"window_days": 90, "mvps": [{"name": "alpha"}]}, f)
            import yaml as _yaml
            with open(cfg_path, "w") as f:
                _yaml.safe_dump({"mvp_mappings": {
                    "alpha": {"supabase_project_ref": "ref_alpha"},
                }}, f)
            _ = db.merge_into_context(ctx_path, cfg_path, auto_confirm=True)
            updated = json.load(open(ctx_path))
            m = updated["mvps"][0]
            self.assertIsNone(m["db_signups"])
            # db_source not set — leaves the field absent so Railway can fill in.
            self.assertNotIn("db_source", m)


class SanityFlagTests(unittest.TestCase):
    """compute_db_sanity_flags is the heart of x3's cross-check.
    Each flag has a single decisive scenario."""

    def test_no_db_signal_no_flags(self):
        flags = verdicts.compute_db_sanity_flags(
            paid_signups=5,
            db_signups=None,  # unmapped
            db_first_signup_at=None,
            first_seen=None,
            ga_clicks=100,
        )
        self.assertEqual(flags, [])

    def test_ph_attribution_broken_fires(self):
        """x-predict canonical: DB has signups, PH paid is zero."""
        flags = verdicts.compute_db_sanity_flags(
            paid_signups=0,
            db_signups=18,
            db_first_signup_at="2026-04-15T00:00:00+00:00",
            first_seen="2026-04-15T00:00:00+00:00",
            ga_clicks=2055,
        )
        self.assertTrue(any(f["flag"] == "ph_attribution_broken" for f in flags))

    def test_ph_attribution_broken_skipped_when_no_ga_spend(self):
        """No paid spend → no expectation of paid signups; suppress the flag."""
        flags = verdicts.compute_db_sanity_flags(
            paid_signups=0,
            db_signups=18,
            db_first_signup_at="2026-04-15T00:00:00+00:00",
            first_seen="2026-04-15T00:00:00+00:00",
            ga_clicks=0,
        )
        self.assertFalse(any(f["flag"] == "ph_attribution_broken" for f in flags))

    def test_ph_overcount_fires_on_activate_misclassification(self):
        """stylica-ai before the fix: PH paid=33 (signup_complete + activate), DB=6."""
        flags = verdicts.compute_db_sanity_flags(
            paid_signups=33,
            db_signups=6,
            db_first_signup_at="2026-04-13T00:00:00+00:00",
            first_seen="2026-04-13T00:00:00+00:00",
            ga_clicks=575,
        )
        self.assertTrue(any(f["flag"] == "ph_overcount" for f in flags))

    def test_ph_undercount_fires(self):
        flags = verdicts.compute_db_sanity_flags(
            paid_signups=2,
            db_signups=10,
            db_first_signup_at="2026-04-13T00:00:00+00:00",
            first_seen="2026-04-14T00:00:00+00:00",
            ga_clicks=100,
        )
        self.assertTrue(any(f["flag"] == "ph_undercount" for f in flags))

    def test_late_instrumentation_fires(self):
        """stylica-ai canonical: DB first row 2026-04-13, PH first event 2026-04-30."""
        flags = verdicts.compute_db_sanity_flags(
            paid_signups=2,
            db_signups=2,  # equal counts within window; sole signal is the timestamp gap
            db_first_signup_at="2026-04-13T15:08:55+00:00",
            first_seen="2026-04-30T04:04:06+00:00",
            ga_clicks=575,
        )
        self.assertTrue(any(f["flag"] == "late_instrumentation" for f in flags))

    def test_aligned_data_emits_no_flags(self):
        flags = verdicts.compute_db_sanity_flags(
            paid_signups=8,
            db_signups=9,
            db_first_signup_at="2026-04-15T00:00:00+00:00",
            first_seen="2026-04-15T00:00:00+00:00",
            ga_clicks=102,
        )
        self.assertEqual(flags, [])


class VerdictIntegrationTests(unittest.TestCase):
    """End-to-end: compute_headline_verdict carries db_signups + sanity flags
    into the score record so x4's renderer can consume them."""

    def test_db_signups_propagates_to_score(self):
        mvp = {
            "name": "stylica-ai",
            "gclid_visitors": 201,
            "ga_clicks": 575,
            "signups": 33,
            "signup_events": ["signup_complete", "activate"],
            "db_signups": 6,
            "db_first_signup_at": "2026-04-13T15:08:55+00:00",
            "first_seen": "2026-04-30T04:04:06+00:00",
        }
        issues = {}
        thresholds = {"signups_go": 3, "visitors_floor": 50}
        score = verdicts.compute_headline_verdict(mvp, issues, thresholds)
        self.assertEqual(score["metrics"]["db_signups"], 6)
        flags = score["tracking_sanity_flags"]
        # Two high-severity flags should fire: overcount + late_instrumentation
        flag_names = {f["flag"] for f in flags}
        self.assertIn("ph_overcount", flag_names)
        self.assertIn("late_instrumentation", flag_names)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_railway_db.py.

Network-touching calls (railway CLI, psql) are isolated in named module
functions and monkeypatched. Pure-function units (table discovery, ground
truth aggregation) get direct coverage.

Run:
  python3 .claude/scripts/tests/test_iterate_cross_railway_db.py
  # OR:
  python3 -m pytest .claude/scripts/tests/test_iterate_cross_railway_db.py -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import iterate_cross_railway_db as rw  # noqa: E402


class ProjectsWithPostgresTests(unittest.TestCase):
    def test_filters_postgres_only(self):
        projs = [
            {
                "id": "p1", "name": "alpha", "workspace": "w",
                "services": [{"id": "s1", "name": "api"}, {"id": "s2", "name": "Postgres"}],
            },
            {
                "id": "p2", "name": "beta", "workspace": "w",
                "services": [{"id": "s3", "name": "Redis"}],
            },
            {
                "id": "p3", "name": "gamma", "workspace": "w",
                "services": [{"id": "s4", "name": "Postgres-5HUP"}, {"id": "s5", "name": "Postgres"}],
            },
        ]
        out = rw.projects_with_postgres(projs)
        self.assertEqual({p["name"] for p in out}, {"alpha", "gamma"})
        # gamma should expose both Postgres services
        gamma = next(p for p in out if p["name"] == "gamma")
        self.assertEqual(len(gamma["postgres_services"]), 2)

    def test_case_insensitive_match(self):
        projs = [
            {"id": "p", "name": "x", "workspace": "w",
             "services": [{"id": "s", "name": "POSTGRES"}]},
        ]
        self.assertEqual(len(rw.projects_with_postgres(projs)), 1)

    def test_excludes_database_word_alone(self):
        # 'Database' service name doesn't imply Postgres — could be Mongo/MySQL.
        # We only claim Postgres-shape services.
        projs = [
            {"id": "p", "name": "x", "workspace": "w",
             "services": [{"id": "s", "name": "Database"}]},
        ]
        self.assertEqual(rw.projects_with_postgres(projs), [])


class DiscoverSignupTablesPgTests(unittest.TestCase):
    @patch("iterate_cross_railway_db._psql_query")
    def test_prioritizes_signup_over_users(self, mock_psql):
        # Same shape as Supabase test — verifies pattern reuse.
        mock_psql.return_value = {
            "rows": [
                ["access_tokens", "id,token,expires_at"],
                ["signups", "id,email,created_at"],
                ["users", "id,email,inserted_at"],
            ],
            "error": None,
        }
        tables = rw.discover_signup_tables_pg("postgresql://fake")
        names = [t["table"] for t in tables]
        self.assertEqual(names[0], "signups")  # priority 0 wins
        self.assertNotIn("access_tokens", names)  # no pattern match

    @patch("iterate_cross_railway_db._psql_query")
    def test_handles_psql_error(self, mock_psql):
        mock_psql.return_value = {"rows": [], "error": "FATAL: connection refused"}
        self.assertEqual(rw.discover_signup_tables_pg("postgresql://bad"), [])

    @patch("iterate_cross_railway_db._psql_query")
    def test_excludes_known_false_positives(self, mock_psql):
        mock_psql.return_value = {
            "rows": [
                ["team_members", "id,user_id"],
                ["billing_users", "id,plan"],
                ["users", "id,email,created_at"],
            ],
            "error": None,
        }
        tables = rw.discover_signup_tables_pg("postgresql://fake")
        names = [t["table"] for t in tables]
        self.assertIn("users", names)
        self.assertNotIn("team_members", names)
        self.assertNotIn("billing_users", names)


class QueryMvpGroundTruthRailwayTests(unittest.TestCase):
    @patch("iterate_cross_railway_db._psql_query")
    def test_picks_max_count_table_and_prefixes_railway(self, mock_psql):
        # schema query, then per-table counts.
        mock_psql.side_effect = [
            {"rows": [
                ["waitlist", "id,email,created_at"],
                ["users", "id,email,inserted_at"],
            ], "error": None},
            {"rows": [["12", "2026-04-10T00:00:00+00:00"]], "error": None},  # waitlist
            {"rows": [["45", "2026-04-05T00:00:00+00:00"]], "error": None},  # users
        ]
        result = rw.query_mvp_ground_truth_railway("postgresql://fake", window_days=90)
        self.assertEqual(result["db_signups"], 45)
        # Prefix tells x3/x4 the number came from Railway, not Supabase
        self.assertEqual(result["db_signups_table"], "railway:public.users")
        # Earliest across all tables wins
        self.assertEqual(result["db_first_signup_at"], "2026-04-05T00:00:00+00:00")

    @patch("iterate_cross_railway_db._psql_query")
    def test_returns_none_when_no_tables(self, mock_psql):
        mock_psql.return_value = {"rows": [], "error": None}
        result = rw.query_mvp_ground_truth_railway("postgresql://fake", 90)
        self.assertIsNone(result["db_signups"])
        self.assertIn("no signup-shape tables", result["errors"][0])

    @patch("iterate_cross_railway_db._psql_query")
    def test_operator_override_only_queries_one_table(self, mock_psql):
        mock_psql.side_effect = [
            # discover schema (to find ts col for override path)
            {"rows": [["waitlist_only", "id,email,created_at"]], "error": None},
            # count on the override table
            {"rows": [["17", "2026-04-15T00:00:00+00:00"]], "error": None},
        ]
        result = rw.query_mvp_ground_truth_railway(
            "postgresql://fake", window_days=90,
            operator_override_table="public.waitlist_only",
        )
        self.assertEqual(result["db_signups"], 17)
        self.assertEqual(result["db_signups_table"], "railway:public.waitlist_only")

    @patch("iterate_cross_railway_db._psql_query")
    def test_count_errors_get_captured(self, mock_psql):
        mock_psql.side_effect = [
            {"rows": [["users", "id,email,created_at"]], "error": None},
            {"rows": [], "error": "permission denied for table users"},
        ]
        result = rw.query_mvp_ground_truth_railway("postgresql://fake", 90)
        self.assertIsNone(result["db_signups"])
        self.assertTrue(any("permission denied" in e for e in result["errors"]))

    def test_auth_schema_override_rejected_clearly(self):
        # Operator copies a Supabase-style override onto a Railway MVP. Silent
        # rewrite to public.<X> would query the wrong table — must reject.
        result = rw.query_mvp_ground_truth_railway(
            "postgresql://fake", window_days=90,
            operator_override_table="auth.users",
        )
        self.assertIsNone(result["db_signups"])
        self.assertTrue(result["errors"], "must surface an error")
        msg = result["errors"][0]
        self.assertIn("auth.users", msg)
        self.assertIn("public.", msg)  # fix-it guidance
        # Sentinel table value still set so downstream can see what operator wrote
        self.assertEqual(result["db_signups_table"], "railway:auth.users")


class CheckPsqlAvailableTests(unittest.TestCase):
    @patch("iterate_cross_railway_db.subprocess.run")
    def test_returns_none_when_psql_present(self, mock_run):
        from unittest.mock import MagicMock
        mock_run.return_value = MagicMock(returncode=0, stdout="psql (PostgreSQL) 14.13", stderr="")
        self.assertIsNone(rw._check_psql_available())

    @patch("iterate_cross_railway_db.subprocess.run", side_effect=FileNotFoundError())
    def test_returns_install_hint_when_missing(self, _mock_run):
        msg = rw._check_psql_available()
        self.assertIsNotNone(msg)
        self.assertIn("psql", msg.lower())
        self.assertIn("install", msg.lower())

    @patch("iterate_cross_railway_db.subprocess.run")
    def test_returns_error_when_psql_broken(self, mock_run):
        from unittest.mock import MagicMock
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="libpq missing")
        msg = rw._check_psql_available()
        self.assertIsNotNone(msg)
        self.assertIn("returned 1", msg)


class CheckRailwayAuthMissingCliTests(unittest.TestCase):
    @patch("iterate_cross_railway_db.subprocess.run", side_effect=FileNotFoundError())
    def test_returns_install_hint_when_cli_missing(self, _mock_run):
        msg = rw._check_railway_auth()
        self.assertIsNotNone(msg)
        self.assertIn("Railway CLI not installed", msg)


class MergeIntoContextPsqlMissingTests(unittest.TestCase):
    """Verify merge_into_context returns skipped_no_psql when psql absent."""

    def _write_context(self, tmpdir, mvps):
        path = os.path.join(tmpdir, "ctx.json")
        with open(path, "w") as f:
            json.dump({"window_days": 90, "mvps": mvps}, f)
        return path

    def _write_config(self, tmpdir):
        import yaml as _yaml
        path = os.path.join(tmpdir, "cfg.yaml")
        with open(path, "w") as f:
            _yaml.safe_dump({"mvp_mappings": {}}, f)
        return path

    @patch("iterate_cross_railway_db._check_railway_auth", return_value=None)
    @patch("iterate_cross_railway_db._check_psql_available")
    def test_skips_when_psql_missing(self, mock_psql, _mock_auth):
        mock_psql.return_value = "psql not installed"
        with tempfile.TemporaryDirectory() as t:
            ctx = self._write_context(t, [{"name": "alpha", "db_signups": None, "db_unmapped_reason": "no_match"}])
            cfg = self._write_config(t)
            result = rw.merge_into_context(ctx, cfg, auto_confirm=True)
        self.assertEqual(result["step"], "skipped_no_psql")
        self.assertIn("psql", result["reason"])

    @patch("iterate_cross_railway_db._check_railway_auth", return_value=None)
    @patch("iterate_cross_railway_db._check_psql_available", return_value=None)
    @patch("iterate_cross_railway_db.list_railway_projects")
    @patch("iterate_cross_railway_db.get_database_url")
    @patch("iterate_cross_railway_db.query_mvp_ground_truth_railway")
    def test_success_sets_db_source_railway(self, mock_q, mock_url, mock_list, *_):
        # Verify db_source='railway' flows through on success.
        mock_list.return_value = [
            {"id": "rp1", "name": "alpha", "workspace": "w",
             "services": [{"id": "s", "name": "Postgres"}]},
        ]
        mock_url.return_value = {"url": "postgresql://fake", "error": None}
        mock_q.return_value = {
            "db_signups": 12, "db_signups_table": "railway:public.users",
            "db_first_signup_at": None, "db_breakdown": {"public.users": 12}, "errors": None,
        }
        with tempfile.TemporaryDirectory() as t:
            ctx = self._write_context(t, [
                {"name": "alpha", "db_signups": None, "db_unmapped_reason": "no_match"},
            ])
            cfg = self._write_config(t)
            rw.merge_into_context(ctx, cfg, auto_confirm=True)
            updated = json.load(open(ctx))
            m = updated["mvps"][0]
            self.assertEqual(m["db_source"], "railway")


class MergeIntoContextTests(unittest.TestCase):
    """Orchestrator-level tests: context I/O, candidate filtering, persistence."""

    def _write_context(self, tmpdir, mvps):
        path = os.path.join(tmpdir, "ctx.json")
        with open(path, "w") as f:
            json.dump({"window_days": 90, "mvps": mvps}, f)
        return path

    def _write_config(self, tmpdir, mappings=None):
        path = os.path.join(tmpdir, "cfg.yaml")
        import yaml as _yaml
        with open(path, "w") as f:
            _yaml.safe_dump({"mvp_mappings": mappings or {}}, f)
        return path

    @patch("iterate_cross_railway_db._check_railway_auth")
    def test_skips_when_not_authed(self, mock_auth):
        mock_auth.return_value = "Run railway login first"
        with tempfile.TemporaryDirectory() as t:
            ctx = self._write_context(t, [{"name": "alpha", "db_signups": None, "db_unmapped_reason": "no_match"}])
            cfg = self._write_config(t)
            result = rw.merge_into_context(ctx, cfg, auto_confirm=True)
        self.assertEqual(result["step"], "skipped_auth")

    @patch("iterate_cross_railway_db._check_railway_auth", return_value=None)
    @patch("iterate_cross_railway_db.list_railway_projects")
    def test_no_postgres_projects(self, mock_list, _mock_auth):
        # Workspace has projects but none with Postgres → graceful exit.
        mock_list.return_value = [
            {"id": "p", "name": "x", "workspace": "w",
             "services": [{"id": "s", "name": "Redis"}]},
        ]
        with tempfile.TemporaryDirectory() as t:
            ctx = self._write_context(t, [
                {"name": "alpha", "db_signups": None, "db_unmapped_reason": "no_match"},
            ])
            cfg = self._write_config(t)
            result = rw.merge_into_context(ctx, cfg, auto_confirm=True)
        self.assertEqual(result["step"], "no_postgres_projects")
        self.assertEqual(result["unmapped"], 1)

    @patch("iterate_cross_railway_db._check_railway_auth", return_value=None)
    @patch("iterate_cross_railway_db.list_railway_projects")
    def test_only_targets_candidates_not_already_mapped(self, mock_list, _mock_auth):
        # MVP with db_signups already set (from Supabase pass) must NOT be touched.
        mock_list.return_value = [
            {"id": "rp1", "name": "alpha", "workspace": "w",
             "services": [{"id": "s", "name": "Postgres"}]},
        ]
        with tempfile.TemporaryDirectory() as t:
            ctx = self._write_context(t, [
                {"name": "alpha", "db_signups": 50, "db_signups_table": "auth.users.confirmed"},
                {"name": "beta",  "db_signups": None, "db_unmapped_reason": "no_match"},
            ])
            cfg = self._write_config(t)
            # auto-confirm so we get to query/persist phase
            with patch("iterate_cross_railway_db.get_database_url") as mock_url, \
                 patch("iterate_cross_railway_db.query_mvp_ground_truth_railway") as mock_q:
                mock_url.return_value = {"url": "postgresql://fake", "error": None}
                mock_q.return_value = {
                    "db_signups": 7, "db_signups_table": "railway:public.users",
                    "db_first_signup_at": None, "db_breakdown": {}, "errors": None,
                }
                _ = rw.merge_into_context(ctx, cfg, auto_confirm=True)
            # Re-read and verify: alpha untouched (50 + supabase), beta updated.
            updated = json.load(open(ctx))
            alpha = next(m for m in updated["mvps"] if m["name"] == "alpha")
            beta = next(m for m in updated["mvps"] if m["name"] == "beta")
            self.assertEqual(alpha["db_signups"], 50)
            self.assertEqual(alpha.get("db_signups_table"), "auth.users.confirmed")
            # beta got Railway data (only if it fuzzy-matched 'alpha'... it doesn't,
            # so it falls into no_match_neither branch). To test SUCCESS, rename:

    @patch("iterate_cross_railway_db._check_railway_auth", return_value=None)
    @patch("iterate_cross_railway_db.list_railway_projects")
    @patch("iterate_cross_railway_db.get_database_url")
    @patch("iterate_cross_railway_db.query_mvp_ground_truth_railway")
    def test_success_path_writes_railway_fields(self, mock_q, mock_url, mock_list, _mock_auth):
        # MVP name = Railway project name (exact match)
        mock_list.return_value = [
            {"id": "rp1", "name": "neuralpost", "workspace": "w",
             "services": [{"id": "s", "name": "Postgres"}]},
        ]
        mock_url.return_value = {"url": "postgresql://fake", "error": None}
        mock_q.return_value = {
            "db_signups": 23,
            "db_signups_table": "railway:public.users",
            "db_first_signup_at": "2026-04-01T00:00:00+00:00",
            "db_breakdown": {"public.users": 23},
            "errors": None,
        }
        with tempfile.TemporaryDirectory() as t:
            ctx = self._write_context(t, [
                {"name": "neuralpost", "db_signups": None, "db_unmapped_reason": "no_match"},
            ])
            cfg = self._write_config(t)
            result = rw.merge_into_context(ctx, cfg, auto_confirm=True)
            self.assertEqual(result["step"], "merged")
            self.assertEqual(result["queried"], 1)
            updated = json.load(open(ctx))
            m = updated["mvps"][0]
            self.assertEqual(m["db_signups"], 23)
            self.assertEqual(m["db_source"], "railway")
            self.assertEqual(m["railway_project_id"], "rp1")
            self.assertEqual(m["railway_service_name"], "Postgres")
            self.assertIsNone(m["db_unmapped_reason"])
            # Config got the mapping persisted (idempotency anchor for next run)
            import yaml as _yaml
            cfg_after = _yaml.safe_load(open(cfg))
            self.assertEqual(
                cfg_after["mvp_mappings"]["neuralpost"]["railway_project_id"], "rp1"
            )

    @patch("iterate_cross_railway_db._check_railway_auth", return_value=None)
    @patch("iterate_cross_railway_db.list_railway_projects")
    def test_no_candidates_when_supabase_covered_everything(self, mock_list, _mock_auth):
        mock_list.return_value = [
            {"id": "rp1", "name": "neuralpost", "workspace": "w",
             "services": [{"id": "s", "name": "Postgres"}]},
        ]
        with tempfile.TemporaryDirectory() as t:
            # Every MVP has db_signups from Supabase already
            ctx = self._write_context(t, [
                {"name": "neuralpost", "db_signups": 19, "db_signups_table": "public.early_access"},
                {"name": "diarly",     "db_signups": 30, "db_signups_table": "public.profiles"},
            ])
            cfg = self._write_config(t)
            result = rw.merge_into_context(ctx, cfg, auto_confirm=True)
        self.assertEqual(result["step"], "no_candidates")


class GetDatabaseUrlTests(unittest.TestCase):
    """Tests the link + variables subprocess sequencing in a temp dir."""

    @patch("iterate_cross_railway_db.subprocess.run")
    def test_prefers_public_url_over_internal(self, mock_run):
        # Sequence: link (success), variables --json (returns both URLs)
        from unittest.mock import MagicMock
        link = MagicMock(returncode=0, stdout="Project linked successfully! 🎉", stderr="")
        vars_r = MagicMock(returncode=0, stdout=json.dumps({
            "DATABASE_URL": "postgresql://u:p@postgres.railway.internal:5432/db",
            "DATABASE_PUBLIC_URL": "postgresql://u:p@proxy.rlwy.net:50318/db",
        }), stderr="")
        mock_run.side_effect = [link, vars_r]
        r = rw.get_database_url("test-project-id", "Postgres")
        self.assertEqual(r["error"], None)
        self.assertIn("proxy.rlwy.net", r["url"])

    @patch("iterate_cross_railway_db.subprocess.run")
    def test_link_failure_returns_error(self, mock_run):
        from unittest.mock import MagicMock
        link = MagicMock(returncode=1, stdout="", stderr="project not found")
        mock_run.return_value = link
        r = rw.get_database_url("bad-id", "Postgres")
        self.assertIsNone(r["url"])
        self.assertIn("link failed", r["error"])

    @patch("iterate_cross_railway_db.subprocess.run")
    def test_missing_database_url_in_vars(self, mock_run):
        from unittest.mock import MagicMock
        link = MagicMock(returncode=0, stdout="Project linked successfully!", stderr="")
        vars_r = MagicMock(returncode=0, stdout=json.dumps({
            "REDIS_URL": "redis://x",  # wrong service shape
        }), stderr="")
        mock_run.side_effect = [link, vars_r]
        r = rw.get_database_url("test-id", "Redis")
        self.assertIsNone(r["url"])
        self.assertIn("no DATABASE_PUBLIC_URL", r["error"])


if __name__ == "__main__":
    unittest.main()

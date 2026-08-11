#!/usr/bin/env python3
"""Tests for .claude/scripts/lib/iterate_cross_census.py (x4c off-fleet census).

Run:
  python3 -m pytest .claude/scripts/tests/test_iterate_cross_census.py -v
  # OR (no pytest dependency):
  python3 .claude/scripts/tests/test_iterate_cross_census.py
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import iterate_cross_census as C  # noqa: E402


REPO_RECORDS = [
    {"name": "AssetDelta", "description": "assetdelta: Verified marketplace for used equipment",
     "pushed_at": "2026-08-01T00:00:00Z", "homepage": ""},
    {"name": "Echo", "description": "echo: review management",
     "pushed_at": "2026-05-28T00:00:00Z", "homepage": ""},
    {"name": "dsarflow", "description": "no-prefix description here",
     "pushed_at": "2026-06-01T00:00:00Z", "homepage": ""},
]
NAME_INDEX = {
    # dirty key with the experiment.yaml comment tail (real-world shape)
    'dsar-flow              # Lowercase slug, hyphens only': "dsarflow",
}
NOW = datetime(2026, 8, 4, tzinfo=timezone.utc)
CONFIG = {
    "mvp_mappings": {"echo": {"owner": "alan"}},
    "team_roster": {"lee": {"github": "balflee"}, "alan": {"github": "alanmagpie"}},
    "census": {"shared_infra": ["agentbus"], "claims": {"larkby": {"owner": "lee"}},
               "active_window_days": 30},
}


class TestCanonicals(unittest.TestCase):
    def test_description_prefix_and_dirty_index_keys(self):
        idx = C.repo_canonicals(REPO_RECORDS, NAME_INDEX)
        self.assertEqual(idx[C.match_key("AssetDelta")]["canonical"], "assetdelta")
        self.assertEqual(idx[C.match_key("assetdelta")]["repo"], "AssetDelta")
        # dirty name-index key is cleaned and joins the repo lacking a prefix
        self.assertEqual(idx[C.match_key("dsar-flow")]["repo"], "dsarflow")

    def test_description_prefix_rejects_prose(self):
        self.assertIsNone(C.canonical_from_description("A long sentence: with spaces before colon"))
        self.assertEqual(C.canonical_from_description("echo: x"), "echo")
        self.assertIsNone(C.canonical_from_description(None))


class TestClusters(unittest.TestCase):
    def _clusters(self, supabase=(), railway=(), vercel_rows=()):
        idx = C.repo_canonicals(REPO_RECORDS, NAME_INDEX)
        return {
            c["key"]: c
            for c in C.build_clusters(
                list(supabase), list(railway), list(vercel_rows), idx, CONFIG, now=NOW
            )
        }

    def test_fleet_shared_claimed_active_dormant_unjoined(self):
        by = self._clusters(
            supabase=[
                {"id": "r1", "name": "Echo", "status": "ACTIVE_HEALTHY"},        # fleet
                {"id": "r2", "name": "agentbus", "status": "ACTIVE_HEALTHY"},    # shared
                {"id": "r3", "name": "larkby", "status": "ACTIVE_HEALTHY"},      # claimed
                {"id": "r4", "name": "AssetDelta", "status": "ACTIVE_HEALTHY"},  # active (pushed 08-01)
                {"id": "r5", "name": "dsarflow", "status": "ACTIVE_HEALTHY"},    # dormant (06-01)
                {"id": "r6", "name": "HRMS", "status": "ACTIVE_HEALTHY"},        # unjoined
            ],
        )
        self.assertEqual(by[C.match_key("echo")]["classification"], "fleet")
        self.assertEqual(by[C.match_key("agentbus")]["classification"], "shared_infra")
        claimed = by[C.match_key("larkby")]
        self.assertEqual(claimed["classification"], "claimed")
        self.assertEqual(claimed["owner"], "lee")
        self.assertEqual(by[C.match_key("assetdelta")]["classification"], "active")
        self.assertEqual(by[C.match_key("dsar-flow")]["classification"], "dormant")
        self.assertEqual(by[C.match_key("HRMS")]["classification"], "unjoined")

    def test_vercel_repo_slug_joins_and_merges_with_supabase(self):
        by = self._clusters(
            supabase=[{"id": "r4", "name": "assetdelta", "status": "ACTIVE_HEALTHY"}],
            vercel_rows=[{"id": "prj1", "name": "asset-delta", "team_id": "t",
                          "repo_slug": "magpiexyz-lab/AssetDelta"}],
        )
        c = by[C.match_key("assetdelta")]
        self.assertEqual(sorted(c["platforms"]), ["supabase", "vercel"])
        self.assertEqual(c["repo"], "AssetDelta")
        self.assertEqual(c["classification"], "active")


class TestPersistClaims(unittest.TestCase):
    def test_roster_validation_and_no_overwrite(self):
        import tempfile, yaml, json  # noqa: F401
        with tempfile.TemporaryDirectory() as td:
            cfg_p = os.path.join(td, "cfg.yaml")
            yaml.safe_dump({
                "team_roster": {"lee": {"github": "balflee"},
                                "gone": {"github": "g", "status": "departed"}},
                "census": {"claims": {"already": {"owner": "lee"}}},
            }, open(cfg_p, "w"))
            res = C.persist_claims(cfg_p, [
                {"key": "newone", "owner": "lee", "platforms": ["supabase"]},
                {"key": "already", "owner": "lee"},
            ], shared_infra=["agentbus"])
            self.assertEqual(res["written"], ["newone"])
            self.assertEqual(res["skipped_existing"], ["already"])
            self.assertEqual(res["shared_infra_added"], ["agentbus"])
            cfg = yaml.safe_load(open(cfg_p))
            self.assertEqual(cfg["census"]["claims"]["newone"]["owner"], "lee")
            with self.assertRaises(ValueError):
                C.persist_claims(cfg_p, [{"key": "x", "owner": "gone"}])
            with self.assertRaises(ValueError):
                C.persist_claims(cfg_p, [{"key": "x", "owner": "stranger"}])


class TestFleetRefJoin(unittest.TestCase):
    def test_ref_mapped_project_is_fleet_despite_name_mismatch(self):
        """neuralpost-prod class: project NAME matches nothing, but its ref is
        in mvp_mappings — the ref join must classify it fleet."""
        cfg = {
            "mvp_mappings": {"neuralpost": {"owner": "lego",
                                            "supabase_project_ref": "laelnucr"}},
            "team_roster": {},
            "census": {},
        }
        idx = C.repo_canonicals([], {})
        by = {c["key"]: c for c in C.build_clusters(
            [{"id": "laelnucr", "name": "neuralpost-prod", "status": "ACTIVE_HEALTHY"}],
            [], [], idx, cfg, now=NOW)}
        c = by[C.match_key("neuralpost")]
        self.assertEqual(c["classification"], "fleet")
        self.assertIn("config ref", c["evidence"][0])




class TestFuzzyJoin(unittest.TestCase):
    REPOS = [
        {"name": "kol-finder", "description": "kol-finder: Find KOLs",
         "pushed_at": "2026-06-01T00:00:00Z", "homepage": ""},
        {"name": "Liquidity-Srategy", "description": "A Ponzi scheme built by liquidity yield.",
         "pushed_at": "2026-03-02T00:00:00Z", "homepage": ""},
    ]

    def _cfg(self):
        return {"mvp_mappings": {}, "team_roster": {}, "census": {
            "db_fingerprint_probe": False, "railway_git_probe": False}}

    def test_suffix_strip_joins_worker_to_repo(self):
        idx = C.repo_canonicals(self.REPOS, {})
        by = {c["key"]: c for c in C.build_clusters(
            [], [{"id": "rw1", "name": "kol-finder-worker", "services": ["w"],
                  "service_count": 1}], [], idx, self._cfg(), now=NOW)}
        # fuzzy joins never rekey (claims continuity) — cluster keeps its own key
        c = by[C.match_key("kol-finder-worker")]
        self.assertEqual(c["repo"], "kol-finder")
        self.assertTrue(any("(fuzzy name)" in e for e in c["evidence"]))

    def test_edit_distance_one_joins_typoed_repo(self):
        idx = C.repo_canonicals(self.REPOS, {})
        by = {c["key"]: c for c in C.build_clusters(
            [{"id": "sb1", "name": "liquidity-strategy", "status": "ACTIVE_HEALTHY"}],
            [], [], idx, self._cfg(), now=NOW)}
        c = by[C.match_key("liquidity-strategy")]  # platform key retained
        self.assertEqual(c["repo"], "Liquidity-Srategy")
        self.assertTrue(any("(fuzzy name)" in e for e in c["evidence"]))

    def test_ambiguous_edit_distance_never_joins(self):
        repos = [
            {"name": "keptline", "description": "", "pushed_at": None, "homepage": ""},
            {"name": "keptlines", "description": "", "pushed_at": None, "homepage": ""},
        ]
        idx = C.repo_canonicals(repos, {})
        entry, note = C.lookup_repo_entry(idx, "keptlinex")  # distance 1 to BOTH
        self.assertIsNone(entry)
        self.assertIsNone(note)

    def test_fuzzy_joined_proposal_capped_at_medium(self):
        cluster = {"key": "x", "display": "x", "classification": "dormant",
                   "platforms": {}, "repo": "X", "canonical": "x",
                   "pushed_at": None, "evidence": ["railway:x-worker → repo:X (fuzzy name)"]}
        self.assertEqual(C._cap_confidence("high", cluster), "medium")
        self.assertEqual(C._cap_confidence("medium", cluster), "medium")
        clean = dict(cluster, evidence=["railway:x → repo:X (name match)"])
        self.assertEqual(C._cap_confidence("high", clean), "high")


class TestRosterReconciliation(unittest.TestCase):
    CFG = {"team_roster": {
        "lee": {"github": "balflee", "github_aliases": ["balflearlee"],
                "email": "lee@magpiexyz.io"},
        "deepak": {"github": "deepakpalrocks", "status": "departed"},  # no email key
        "priyanshu": {"github": "pcentric", "email": None},            # null email
    }}

    def test_gaps_detected_and_known_covered(self):
        errors = []
        gaps = C.reconcile_rosters(
            self.CFG, errors,
            gh_members=["balflee", "BALFLEARLEE", "grimmace123", "alanmagpie"],
            sb_members=[{"email": "lee@magpiexyz.io", "user_name": "balflee"},
                        {"email": "grimmace@magpiexyz.io", "user_name": "g"},
                        {"email": "admin@magpiexyz.io", "user_name": "op"}],
        )
        self.assertEqual(gaps["github"], ["grimmace123"])
        self.assertEqual(gaps["supabase"], ["grimmace@magpiexyz.io"])
        self.assertEqual(errors, [])

    def test_email_aliases_cover_org_membership(self):
        cfg = {"team_roster": {"taran": {"github": "nukeTK",
                                         "email": "personal@gmail.com",
                                         "email_aliases": ["taran@magpiexyz.io"]}}}
        gaps = C.reconcile_rosters(cfg, [], gh_members=[],
                                   sb_members=[{"email": "taran@magpiexyz.io", "user_name": "t"}])
        self.assertEqual(gaps["supabase"], [])
        # fingerprint map resolves both addresses to the member
        m = C._roster_email_map(cfg["team_roster"])
        self.assertEqual(m["taran@magpiexyz.io"], "taran")
        self.assertEqual(m["personal@gmail.com"], "taran")

    def test_full_coverage_yields_empty_gaps(self):
        gaps = C.reconcile_rosters(self.CFG, [], gh_members=["balflee"],
                                   sb_members=[{"email": "lee@magpiexyz.io", "user_name": "x"}])
        self.assertEqual(gaps, {"github": [], "supabase": []})


class TestDbFingerprint(unittest.TestCase):
    CFG = {"team_roster": {
        "lego": {"github": "LCODES25", "email": "lego@magpiexyz.io"},
        "parth": {"github": "parthmagpie", "email": "parthgera@magpiexyz.io",
                  "status": "departed"},
        "alan": {"github": "alanmagpie", "email": "alan@magpiexyz.io"},
    }, "census": {}}

    def test_sole_roster_registrant_is_high(self):
        from unittest.mock import patch
        with patch("iterate_cross_db.get_project_detail",
                   return_value={"created_at": "2026-03-03T00:00:00Z"}), \
             patch("iterate_cross_db._management_api_query",
                   return_value=[{"email": "LEGO@magpiexyz.io",
                                  "created_at": "2026-03-06 00:00:00+00"}]):
            fp = C.db_fingerprint("ref1", self.CFG)
        self.assertEqual(fp["owner"], "lego")
        self.assertEqual(fp["confidence"], "high")
        self.assertEqual(fp["matched_email_redacted"], "LEG***@magpiexyz.io")

    def test_departed_registrant_remaps_to_operator(self):
        from unittest.mock import patch
        with patch("iterate_cross_db.get_project_detail",
                   return_value={"created_at": "2026-03-03T00:00:00Z"}), \
             patch("iterate_cross_db._management_api_query",
                   return_value=[{"email": "parthgera@magpiexyz.io",
                                  "created_at": "2026-03-04 00:00:00+00"},
                                 {"email": "stranger@gmail.com",
                                  "created_at": "2026-03-05 00:00:00+00"}]):
            fp = C.db_fingerprint("ref2", self.CFG)
        self.assertEqual(fp["owner"], "alan")
        self.assertEqual(fp["inferred_original"], "parth")
        self.assertEqual(fp["confidence"], "medium")  # not the sole registrant

    def test_malicious_created_at_is_rejected_not_interpolated(self):
        from unittest.mock import patch
        with patch("iterate_cross_db.get_project_detail",
                   return_value={"created_at": "2026-01-01'; drop table users; --"}):
            fp = C.db_fingerprint("ref4", self.CFG)
        self.assertIn("error", fp)
        self.assertNotIn("owner", fp)

    def test_non_roster_registrants_become_evidence_only(self):
        from unittest.mock import patch
        with patch("iterate_cross_db.get_project_detail",
                   return_value={"created_at": "2026-03-03T00:00:00Z"}), \
             patch("iterate_cross_db._management_api_query",
                   return_value=[{"email": "bhavinpersonal@gmail.com",
                                  "created_at": "2026-03-03 12:00:00+00"}]):
            fp = C.db_fingerprint("ref3", self.CFG)
        self.assertNotIn("owner", fp)
        self.assertEqual(fp["first_signups"],
                         [{"email": "bha***@gmail.com", "created": "2026-03-03"}])


class TestRailwaySourceProbe(unittest.TestCase):
    GRAPHQL = {"data": {"project": {"services": {"edges": [
        {"node": {"name": "api", "serviceInstances": {"edges": [
            {"node": {"source": {"repo": "nukeTK/StreakBets"}}}]}}},
        {"node": {"name": "Redis", "serviceInstances": {"edges": [
            {"node": {"source": None}}]}}},   # image/CLI service: no source.repo
    ]}}}}

    def test_parses_repo_and_skips_sourceless_services(self):
        from unittest.mock import patch
        with patch.object(C, "_railway_graphql", return_value=self.GRAPHQL):
            rows = C.railway_source_repos("pid")
        self.assertEqual(rows, [{"service": "api", "repo": "nukeTK/StreakBets"}])

    def test_api_failure_and_missing_id_yield_empty(self):
        from unittest.mock import patch
        with patch.object(C, "_railway_graphql", return_value=None):
            self.assertEqual(C.railway_source_repos("pid"), [])
        self.assertEqual(C.railway_source_repos(""), [])


class TestRailwaySourceChannel(unittest.TestCase):
    CFG = {
        "mvp_mappings": {},
        "team_roster": {"taran": {"github": "nukeTK"}},
        "census": {"railway_git_probe": False, "db_fingerprint_probe": False},
    }

    def _cluster(self):
        return {"key": "streakbet", "display": "StreakBet",
                "classification": "unjoined", "repo": None, "canonical": None,
                "platforms": {"railway": [{"id": "pid", "services": ["api"]}]},
                "evidence": []}

    def test_personal_source_repo_yields_medium_proposal(self):
        from unittest.mock import patch
        with patch.object(C, "railway_source_repos",
                          return_value=[{"service": "api",
                                         "repo": "nukeTK/StreakBets"}]), \
             patch.object(C.vercel, "vercel_token", return_value=None):
            out = C.propose_cluster_owners([self._cluster()], self.CFG)
        self.assertEqual(len(out["proposals"]), 1)
        p = out["proposals"][0]
        self.assertEqual(p["owner"], "taran")
        self.assertEqual(p["confidence"], "medium")
        self.assertIn("Railway source repo nukeTK/StreakBets", p["owner_note"])
        self.assertEqual(p["repo"], "nukeTK/StreakBets")
        self.assertEqual(out["needs_claim"], [])

    def test_org_source_repo_stays_evidence_only(self):
        from unittest.mock import patch
        with patch.object(C, "railway_source_repos",
                          return_value=[{"service": "api",
                                         "repo": "magpiexyz-lab/agentbus"}]), \
             patch.object(C.vercel, "vercel_token", return_value=None):
            out = C.propose_cluster_owners([self._cluster()], self.CFG)
        self.assertEqual(out["proposals"], [])
        self.assertEqual(out["needs_claim"][0]["railway_source"],
                         ["magpiexyz-lab/agentbus"])

    def test_flag_off_skips_probe(self):
        from unittest.mock import MagicMock, patch
        cfg = {**self.CFG, "census": {"railway_source_probe": False,
                                      "railway_git_probe": False,
                                      "db_fingerprint_probe": False}}
        probe = MagicMock()
        with patch.object(C, "railway_source_repos", probe), \
             patch.object(C.vercel, "vercel_token", return_value=None):
            out = C.propose_cluster_owners([self._cluster()], cfg)
        probe.assert_not_called()
        self.assertEqual(out["proposals"], [])
        self.assertNotIn("railway_source", out["needs_claim"][0])


class TestRailwayGitProbe(unittest.TestCase):
    def test_git_vars_yield_repo_and_author(self):
        from unittest.mock import patch
        with patch.object(C, "_railway_service_variables",
                          return_value=({"RAILWAY_GIT_REPO_OWNER": "magpiexyz-lab",
                                         "RAILWAY_GIT_REPO_NAME": "DryRunSecAgent",
                                         "RAILWAY_GIT_AUTHOR": "balflee",
                                         "OTHER": "x"}, None)):
            meta = C.railway_git_meta("pid", ["svc"])
        self.assertEqual(meta["repo_name"], "DryRunSecAgent")
        self.assertEqual(meta["author"], "balflee")

    def test_cli_deployed_services_yield_empty(self):
        from unittest.mock import patch
        with patch.object(C, "_railway_service_variables",
                          return_value=({"DATABASE_URL": "postgres://x"}, None)):
            meta = C.railway_git_meta("pid", ["a", "b"])
        self.assertEqual(meta, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)

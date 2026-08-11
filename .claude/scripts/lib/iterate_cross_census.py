#!/usr/bin/env python3
"""iterate_cross_census.py — Off-fleet infrastructure census for /iterate --cross x4c.

Why this exists (first-principles): /iterate --cross discovers MVPs from PAID
TRAFFIC (gclid events + GA CSV), but cost attaches to RESOURCE EXISTENCE —
Supabase/Railway/Vercel projects are provisioned before ads start and keep
billing after ads stop. Projects that never reach (or never reached) ads are
structurally invisible to the fleet loop while costing real money (2026-08-04
audit: 53 unmapped Supabase projects ≈ $530+/mo at Micro floor). This module
widens the census root from "has paid traffic" to "exists on a billed
platform", joins the per-platform namespaces into clusters, classifies each
cluster's lifecycle, and proposes owners through the SAME operator-confirm
discipline as the fleet owner channel.

Identity joins (strongest first):
  1. vercel.repo_slug -> GitHub repo               (machine link)
  2. repo description "name: ..." prefix / org-wide experiment.yaml
     name-index -> canonical name                   (org convention)
  3. cross-platform name co-occurrence via match_key (fallback)
Owner inference reuses iterate_cross_owner_infer's commit-history channel
(first+majority author, roster mapping, departed→operator remap) and the
Vercel deploy-author fallback. Proposals only — persistence happens
exclusively via `persist-claims --confirm` into the config `census:` section
(never into mvp_mappings: off-fleet clusters are not MVPs and must not feed
the verdict machinery).

Lifecycle classification:
  fleet        — cluster matches an mvp_mappings row (governed by cross)
  shared_infra — operator-allowlisted infrastructure (census.shared_infra)
  claimed      — operator already confirmed an owner (census.claims)
  active       — pushed/deployed within census.active_window_days (default 30)
                 — the "still building, pre-ads" class; never proposed for pause
  dormant      — no ads history and no recent activity → pause candidate
  unjoined     — no repo/activity evidence at all → human claim queue

Fail-soft: every platform collector records errors instead of raising; a
platform being down degrades coverage, never the run.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iterate_cross_classify import load_yaml, match_key  # noqa: E402
import iterate_cross_pricing as pricing  # noqa: E402
import iterate_cross_vercel as vercel  # noqa: E402
import iterate_cross_owner_infer as owner_infer  # noqa: E402

DEFAULT_OUTPUT = ".runs/iterate-cross-census.json"
DEFAULT_ACTIVE_WINDOW_DAYS = 30
DEFAULT_SUPABASE_MICRO_USD = 10.0


# ---------- canonical-name helpers ----------

def _clean_index_name(raw: str) -> str:
    """Name-index keys can carry the experiment.yaml comment tail — strip it."""
    return (raw or "").split("#", 1)[0].strip()


def canonical_from_description(description: str | None) -> str | None:
    """Org convention: repo description starts with '<canonical-name>: ...'."""
    if not description:
        return None
    head = description.split(":", 1)[0].strip()
    if not head or len(head) > 40 or " " in head:
        return None
    return head


_SERVICE_SUFFIXES = {"worker", "bot", "api", "service", "server", "agent", "app"}


def _join_key_candidates(name: str) -> list[str]:
    """match_key candidates for a platform name, strongest first.

    Beyond the exact key, strip TRAILING service-style tokens so
    `kol-finder-worker` also tries `kolfinder` (the 2026-08-04 near-miss).
    """
    base = match_key(name)
    out = [base] if base else []
    tokens = [t for t in re.split(r"[\s_\-/]+", (name or "").strip()) if t]
    while len(tokens) > 1 and tokens[-1].lower() in _SERVICE_SUFFIXES:
        tokens = tokens[:-1]
        key = match_key("-".join(tokens))
        if key and key not in out:
            out.append(key)
    return out


def _within_edit1(a: str, b: str) -> bool:
    """Damerau-free edit distance ≤ 1 (insert/delete/substitute one char)."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la > lb:
        a, b, la, lb = b, a, lb, la
    i = j = diff = 0
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        diff += 1
        if diff > 1:
            return False
        if la == lb:
            i += 1
        j += 1
    return True


def lookup_repo_entry(repo_index: dict[str, dict], name: str) -> tuple[dict | None, str | None]:
    """Repo-index lookup with suffix + typo tolerance.

    Returns (entry, fuzzy_note). fuzzy_note is None for an exact first-key
    hit, else a short marker ('suffix' / 'edit-distance') — callers append it
    to cluster evidence as '(fuzzy name)' and owner proposals derived from a
    fuzzy-joined repo are confidence-capped at medium. The edit-distance
    fallback only fires on a UNIQUE ≤1 match (two candidates → no join): the
    Liquidity-Srategy typo joins, ambiguous names never do.
    """
    candidates = _join_key_candidates(name)
    for i, key in enumerate(candidates):
        entry = repo_index.get(key)
        if entry is not None:
            return entry, (None if i == 0 else "suffix")
    base = candidates[0] if candidates else ""
    if len(base) >= 6:  # short keys make distance-1 matches meaningless
        near = {id(v): v for k, v in repo_index.items() if _within_edit1(base, k)}
        if len(near) == 1:
            return next(iter(near.values())), "edit-distance"
    return None, None


def repo_canonicals(records: list[dict], name_index: dict) -> dict[str, dict]:
    """match_key -> {repo, canonical, pushed_at} for every org repo.

    Both the repo's own name and its canonical (description prefix or
    name-index experiment name) key the same entry, so platform names join on
    either form.
    """
    by_key: dict[str, dict] = {}
    index_by_repo: dict[str, str] = {}
    for raw_name, repo in (name_index or {}).items():
        cleaned = _clean_index_name(str(raw_name))
        if cleaned and repo not in index_by_repo:
            index_by_repo[str(repo)] = cleaned
    for rec in records or []:
        repo = rec.get("name") or ""
        if not repo:
            continue
        canonical = (
            canonical_from_description(rec.get("description"))
            or index_by_repo.get(repo)
            or repo
        )
        entry = {
            "repo": repo,
            "canonical": canonical,
            "pushed_at": rec.get("pushed_at"),
            "homepage": rec.get("homepage") or "",
        }
        for key in {match_key(repo), match_key(canonical)}:
            if key:
                by_key.setdefault(key, entry)
    return by_key


# ---------- platform collectors (fail-soft) ----------

def collect_supabase(errors: list[str]) -> list[dict]:
    try:
        from iterate_cross_db import _read_token, probe_supabase_projects
        probe = probe_supabase_projects(_read_token())
        if not probe.get("ok"):
            errors.append(f"supabase: probe failed ({probe.get('reason')})")
            return []
        return [
            {"id": p.get("id"), "name": str(p.get("name") or ""), "status": p.get("status")}
            for p in probe.get("projects") or []
        ]
    except Exception as exc:  # noqa: BLE001 — collector must not kill the census
        errors.append(f"supabase: {type(exc).__name__}: {exc}")
        return []


def collect_railway(errors: list[str]) -> list[dict]:
    try:
        proc = subprocess.run(
            ["railway", "list", "--json"], capture_output=True, text=True, timeout=60
        )
        if proc.returncode != 0:
            errors.append(f"railway: exit {proc.returncode}: {proc.stderr.strip()[:120]}")
            return []
        data = json.loads(proc.stdout or "[]")
        projects = data if isinstance(data, list) else data.get("projects") or []
        rows = []
        for p in projects:
            if not isinstance(p, dict):
                continue
            svcs = p.get("services") or []
            if isinstance(svcs, dict):
                svcs = svcs.get("edges") or []
            names = []
            for s in svcs:
                node = s.get("node") if isinstance(s, dict) else None
                names.append(str((node or s or {}).get("name") or "?") if isinstance(s, dict) else "?")
            rows.append({
                "id": p.get("id"),
                "name": str(p.get("name") or ""),
                "services": names,
                "service_count": len(svcs),
            })
        return rows
    except FileNotFoundError:
        errors.append("railway: CLI not installed")
        return []
    except Exception as exc:  # noqa: BLE001
        errors.append(f"railway: {type(exc).__name__}: {exc}")
        return []


def collect_vercel(errors: list[str]) -> list[dict]:
    try:
        tok = vercel.vercel_token()
        if not tok:
            errors.append("vercel: no token")
            return []
        return vercel.list_projects(tok)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"vercel: {type(exc).__name__}: {exc}")
        return []


def collect_github(errors: list[str]) -> tuple[list[dict], dict]:
    try:
        if not pricing.gh_available():
            errors.append("github: gh unavailable")
            return [], {}
        records = pricing.list_org_repo_records()
        index = pricing.load_or_refresh_name_index(records) if records else {}
        return records, index
    except Exception as exc:  # noqa: BLE001
        errors.append(f"github: {type(exc).__name__}: {exc}")
        return [], {}


# ---------- clustering + classification ----------

def _fleet_keys(mvp_mappings: dict) -> set[str]:
    keys = set()
    for name in mvp_mappings or {}:
        if isinstance(name, str) and not name.startswith("__orphan"):
            keys.add(match_key(name))
    return keys


def _fleet_refs(mvp_mappings: dict) -> dict[str, str]:
    """Platform resource ID → MVP name (the strongest fleet join: a Supabase
    project named 'neuralpost-prod' is fleet because its REF is mapped, even
    though its name match_keys to nothing in config)."""
    refs: dict[str, str] = {}
    for name, entry in (mvp_mappings or {}).items():
        if not isinstance(entry, dict) or str(name).startswith("__orphan"):
            continue
        for field in ("supabase_project_ref", "railway_project_id"):
            if entry.get(field):
                refs[str(entry[field])] = str(name)
    return refs


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def build_clusters(
    supabase_rows: list[dict],
    railway_rows: list[dict],
    vercel_rows: list[dict],
    repo_index: dict[str, dict],
    config: dict,
    now: datetime | None = None,
) -> list[dict]:
    """Join platform rows into clusters and classify each one."""
    census_cfg = config.get("census") or {}
    mvp_mappings = config.get("mvp_mappings") or {}
    fleet = _fleet_keys(mvp_mappings)
    shared = {match_key(str(n)) for n in census_cfg.get("shared_infra") or []}
    claims = {match_key(str(k)): v for k, v in (census_cfg.get("claims") or {}).items()}
    window_days = int(census_cfg.get("active_window_days", DEFAULT_ACTIVE_WINDOW_DAYS))
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=window_days)

    clusters: dict[str, dict] = {}

    def touch(key: str, display: str) -> dict:
        return clusters.setdefault(key, {
            "key": key,
            "display": display,
            "platforms": {},
            "repo": None,
            "canonical": None,
            "pushed_at": None,
            "evidence": [],
        })

    for row in vercel_rows:
        name = row.get("name") or ""
        slug = row.get("repo_slug") or ""
        repo_entry = None
        if slug:
            bare = slug.split("/", 1)[-1]
            repo_entry = repo_index.get(match_key(bare))
        fuzzy = None
        if repo_entry is None:
            repo_entry, fuzzy = lookup_repo_entry(repo_index, name)
        # Fuzzy joins attach repo evidence but never rekey the cluster —
        # rekeying would break census.claims continuity (the Liquidity-Srategy
        # typo would flip an already-claimed cluster back to unclaimed).
        if repo_entry and not fuzzy:
            key = match_key(repo_entry["canonical"]) or match_key(name)
        else:
            key = match_key(name)
        if not key:
            continue
        c = touch(key, repo_entry["canonical"] if repo_entry else name)
        c["platforms"].setdefault("vercel", []).append(
            {"name": name, "id": row.get("id"), "repo_slug": slug or None}
        )
        if repo_entry:
            c["repo"] = repo_entry["repo"]
            c["canonical"] = repo_entry["canonical"]
            c["pushed_at"] = repo_entry.get("pushed_at")
            c["evidence"].append(
                f"vercel:{name} → repo:{repo_entry['repo']}"
                + (" (git link)" if slug else (" (fuzzy name)" if fuzzy else " (name match)"))
            )

    fleet_refs = _fleet_refs(mvp_mappings)
    for row in supabase_rows + railway_rows:
        platform = "supabase" if "status" in row else "railway"
        name = row.get("name") or ""
        ref_mvp = fleet_refs.get(str(row.get("id") or ""))
        fuzzy = None
        if ref_mvp:
            key, repo_entry = match_key(ref_mvp), None
        else:
            repo_entry, fuzzy = lookup_repo_entry(repo_index, name)
            key = match_key(name)
        if repo_entry is not None and not fuzzy:
            key = match_key(repo_entry["canonical"]) or key
        if not key:
            continue
        c = touch(key, ref_mvp or (repo_entry["canonical"] if repo_entry else name))
        if ref_mvp:
            c["evidence"].append(f"{platform}:{name} → mvp:{ref_mvp} (config ref)")
        c["platforms"].setdefault(platform, []).append(
            {k: row.get(k) for k in ("name", "id", "status", "service_count", "services") if k in row}
        )
        if repo_entry and not c.get("repo"):
            c["repo"] = repo_entry["repo"]
            c["canonical"] = repo_entry["canonical"]
            c["pushed_at"] = repo_entry.get("pushed_at")
            c["evidence"].append(
                f"{platform}:{name} → repo:{repo_entry['repo']}"
                + (" (fuzzy name)" if fuzzy else " (name match)")
            )

    for c in clusters.values():
        pushed = _parse_iso(c.get("pushed_at"))
        if c["key"] in fleet:
            c["classification"] = "fleet"
        elif c["key"] in shared:
            c["classification"] = "shared_infra"
        elif c["key"] in claims:
            c["classification"] = "claimed"
            c["owner"] = (claims[c["key"]] or {}).get("owner")
        elif pushed is not None and pushed >= cutoff:
            c["classification"] = "active"
        elif c.get("repo"):
            c["classification"] = "dormant"
        else:
            c["classification"] = "unjoined"

    return sorted(clusters.values(), key=lambda c: (c["classification"], c["key"]))


# ---------- roster reconciliation (org members vs team_roster) ----------

def _github_org_members(errors: list[str]) -> list[str]:
    rc, out, err = pricing._gh(
        ["api", f"orgs/{pricing.GH_ORG}/members?per_page=100", "--jq", "[.[].login]"],
        timeout=60,
    )
    if rc != 0:
        errors.append(f"roster-recon github: {err[:80]}")
        return []
    try:
        return [str(x) for x in json.loads(out or "[]")]
    except ValueError:
        errors.append("roster-recon github: parse error")
        return []


def _supabase_org_members(errors: list[str]) -> list[dict]:
    try:
        import urllib.request
        from iterate_cross_db import _read_token, _SUPABASE_USER_AGENT
        token = _read_token()
        def _get(path):
            req = urllib.request.Request(
                f"https://api.supabase.com{path}",
                headers={"Authorization": f"Bearer {token}",
                         "User-Agent": _SUPABASE_USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        orgs = _get("/v1/organizations")
        if not orgs:
            return []
        rows = _get(f"/v1/organizations/{orgs[0].get('id')}/members")
        return [
            {"email": str(m.get("email") or ""), "user_name": str(m.get("user_name") or "")}
            for m in rows or []
        ]
    except Exception as exc:  # noqa: BLE001
        errors.append(f"roster-recon supabase: {type(exc).__name__}: {exc}")
        return []


def reconcile_rosters(
    config: dict,
    errors: list[str],
    gh_members: list[str] | None = None,
    sb_members: list[dict] | None = None,
) -> dict:
    """Diff GitHub-org + Supabase-org members against team_roster.

    The channel that exposed 5 unrostered people on 2026-08-04 — a roster gap
    silently disables owner inference for that person's whole portfolio, so
    the census doubles as a roster-gap detector. Members may be injected for
    tests; default is a live fetch (fail-soft). Operator/org accounts are
    excluded via owner_infer's identity sets.
    """
    roster = config.get("team_roster") or {}
    known_logins: set[str] = {l.lower() for l in owner_infer.OPERATOR_LOGINS}
    known_emails: set[str] = {e.lower() for e in owner_infer.OPERATOR_EMAILS}
    for member, info in roster.items():
        if member == "_meta" or not isinstance(info, dict):
            continue
        if info.get("github"):
            known_logins.add(str(info["github"]).lower())
        for alias in info.get("github_aliases") or []:
            if alias:
                known_logins.add(str(alias).lower())
        if info.get("email"):
            known_emails.add(str(info["email"]).lower())
        for alias in info.get("email_aliases") or []:
            if alias:
                known_emails.add(str(alias).lower())
    if gh_members is None:
        gh_members = _github_org_members(errors)
    if sb_members is None:
        sb_members = _supabase_org_members(errors)
    gaps_gh = sorted(m for m in gh_members if m.lower() not in known_logins)
    gaps_sb = sorted(
        m["email"] for m in sb_members
        if m.get("email") and m["email"].lower() not in known_emails
    )
    return {"github": gaps_gh, "supabase": gaps_sb}


# ---------- db-fingerprint channel (first registrants = builder trace) ----------

def _redact_email(email: str) -> str:
    e = str(email or "")
    return e[:3] + "***" + e[e.find("@"):] if "@" in e else e


def _roster_email_map(roster: dict) -> dict[str, str]:
    out = {}
    for member, info in (roster or {}).items():
        if member == "_meta" or not isinstance(info, dict):
            continue
        for email in [info.get("email"), *(info.get("email_aliases") or [])]:
            if email:
                out[str(email).lower()] = member
    return out


def db_fingerprint(supabase_ref: str, config: dict) -> dict:
    """First in-window auth.users registrants for one project (fail-soft).

    The builder almost always test-signs-up within days of creating the
    project (mercator→lego, permitpilot→bhavin, 2026-08-04). Returns
    {owner, confidence, matched_email_redacted, first_signups} — owner is set
    ONLY on an exact roster-email match (sole in-window registrant → high,
    first-but-not-sole → medium). Non-roster registrants are returned as
    redacted evidence for the lead playbook, never auto-proposed.
    """
    from iterate_cross_db import _management_api_query, get_project_detail

    census_cfg = config.get("census") or {}
    window = int(census_cfg.get("fingerprint_window_days", 14))
    limit = int(census_cfg.get("fingerprint_max_users", 5))
    detail = get_project_detail(supabase_ref)
    created_dt = _parse_iso(detail.get("created_at"))
    if created_dt is None:
        return {"error": detail.get("error") or "invalid or missing created_at"}
    # Canonical re-serialization: created_at is API-sourced text — never
    # interpolate it into SQL raw (window/limit are int()-cast above).
    created = created_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = _management_api_query(supabase_ref, f"""
        select email, created_at from auth.users
        where created_at <= '{created}'::timestamptz + interval '{window} days'
        order by created_at limit {limit}""")
    if isinstance(rows, dict) and rows.get("error"):
        return {"error": str(rows.get("error"))[:120]}
    emails = _roster_email_map(config.get("team_roster") or {})
    first_signups = [
        {"email": _redact_email(r.get("email")), "created": str(r.get("created_at"))[:10]}
        for r in rows
    ]
    result: dict = {"first_signups": first_signups}
    matches = [
        (i, emails[str(r.get("email") or "").lower()])
        for i, r in enumerate(rows)
        if str(r.get("email") or "").lower() in emails
    ]
    if matches:
        idx, member = matches[0]
        member, original = owner_infer.apply_departed_remap(
            member, config.get("team_roster") or {}
        )
        result.update({
            "owner": member,
            "inferred_original": original,
            "confidence": "high" if len(rows) == 1 else "medium",
            "matched_email_redacted": first_signups[idx]["email"],
        })
    return result


# ---------- Railway GIT-metadata probe ----------

def _railway_service_variables(project_id: str, service_name: str) -> tuple[dict | None, str | None]:
    """Full variables dict for one Railway service (link + variables --json).

    Mirrors iterate_cross_railway_db.get_database_url's tempdir-isolated
    link pattern (railway link writes .railway/config.json under the CWD),
    but returns the WHOLE variables dict — the GIT probe needs
    RAILWAY_GIT_*, not DATABASE_URL.
    """
    import shutil
    import tempfile
    tmpdir = tempfile.mkdtemp(prefix="railway-census-")
    try:
        link = subprocess.run(
            ["railway", "link", "--project", project_id],
            capture_output=True, text=True, timeout=60, cwd=tmpdir,
        )
        if link.returncode != 0:
            return None, f"link failed: {link.stderr.strip()[:80]}"
        var = subprocess.run(
            ["railway", "variables", "--service", service_name, "--json"],
            capture_output=True, text=True, timeout=60, cwd=tmpdir,
        )
        if var.returncode != 0:
            return None, f"variables failed: {var.stderr.strip()[:80]}"
        return json.loads(var.stdout or "{}"), None
    except FileNotFoundError:
        return None, "railway CLI not installed"
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def railway_git_meta(project_id: str, service_names: list[str]) -> dict:
    """RAILWAY_GIT_* metadata across a project's services.

    GitHub-connected services carry RAILWAY_GIT_REPO_OWNER/REPO_NAME/AUTHOR;
    CLI-deployed (`railway up`) and image services carry none — measured
    2026-08-04: all 13 then-current services were CLI-deployed (contrast
    case: dryrunsec HAS an org repo yet showed no GIT vars). Absence is
    evidence, not failure.
    """
    for svc in service_names or []:
        vars_, err = _railway_service_variables(project_id, svc)
        if not vars_:
            continue
        git = {k: vars_[k] for k in vars_ if str(k).startswith("RAILWAY_GIT")}
        if git:
            return {
                "service": svc,
                "repo_owner": git.get("RAILWAY_GIT_REPO_OWNER"),
                "repo_name": git.get("RAILWAY_GIT_REPO_NAME"),
                "author": git.get("RAILWAY_GIT_AUTHOR"),
            }
    return {}


# ---------- Railway source-repo probe ----------

RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2"

_RAILWAY_SOURCE_QUERY = (
    "query($id: String!) { project(id: $id) { services { edges { node { "
    "name serviceInstances { edges { node { source { repo } } } } "
    "} } } } }"
)


def _railway_cli_token() -> str | None:
    """CLI session access token — ~/.railway/config.json `.user.accessToken`.

    Short-lived JWT the CLI refreshes on every invocation; collect_railway's
    `railway list` always runs earlier in the same census pass, so the token
    read here is at most minutes old. Trap: `.user.token` is a legacy null
    field — `.user.accessToken` is the real one.
    """
    try:
        with open(os.path.expanduser("~/.railway/config.json")) as fh:
            return (json.load(fh).get("user") or {}).get("accessToken") or None
    except (OSError, ValueError):
        return None


def _railway_graphql(query: str, variables: dict) -> dict | None:
    """Single mock surface for Railway public-API POSTs (urllib, no new deps).

    The User-Agent is load-bearing: Cloudflare bans urllib's default
    `Python-urllib/3.x` signature with 403 "error code: 1010" regardless of
    auth — the root cause of the 2026-08-04 "API rejects the CLI token"
    misdiagnosis. Any non-urllib UA passes.
    """
    token = _railway_cli_token()
    if not token:
        return None
    req = urllib.request.Request(
        RAILWAY_GRAPHQL_URL,
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json",
                 "User-Agent": "mvp-template-census/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, ValueError, OSError):
        return None


def railway_source_repos(project_id: str) -> list[dict]:
    """[{service, repo}] from each service's Settings→Source Repo.

    `serviceInstance.source.repo` is persistent service CONFIG, not deploy
    metadata: it survives GitHub repo deletion ("GitHub Repo not found" in
    the dashboard) and offline services — exactly the rows the RAILWAY_GIT_*
    probe is blind to (those vars exist only on an active GitHub-built
    deploy; measured 2026-08-06, all 4 then-unclaimed source-connected
    projects had a repo here and no GIT vars). `railway up`- and
    image-deployed services carry no source.repo.
    """
    if not project_id:
        return []
    data = _railway_graphql(_RAILWAY_SOURCE_QUERY, {"id": project_id}) or {}
    out: list[dict] = []
    for edge in ((((data.get("data") or {}).get("project") or {})
                  .get("services") or {}).get("edges") or []):
        node = (edge or {}).get("node") or {}
        for si_edge in (node.get("serviceInstances") or {}).get("edges") or []:
            source = ((si_edge or {}).get("node") or {}).get("source") or {}
            repo = source.get("repo")
            if repo and "/" in str(repo):
                out.append({"service": str(node.get("name") or "?"),
                            "repo": str(repo)})
                break  # one instance per service suffices
    return out


# ---------- owner proposals for off-fleet clusters ----------

OFF_FLEET_PROPOSABLE = {"active", "dormant", "unjoined"}


def _cluster_is_fuzzy_joined(cluster: dict) -> bool:
    return any("(fuzzy name)" in str(e) for e in cluster.get("evidence") or [])


def _cap_confidence(confidence: str, cluster: dict) -> str:
    """Fuzzy-joined repos never yield high-confidence proposals."""
    if confidence == "high" and _cluster_is_fuzzy_joined(cluster):
        return "medium"
    return confidence


def propose_cluster_owners(
    clusters: list[dict],
    config: dict,
    max_pages: int = 3,
    today: str | None = None,
) -> dict:
    """Commit-history (+ Vercel deploy-author fallback) owner proposals.

    Reuses the fleet channel's machinery verbatim so confidence semantics stay
    identical. Off-fleet clusters only; fleet/shared/claimed rows are skipped.
    """
    roster = config.get("team_roster") or {}
    idx = owner_infer.build_roster_index(roster)
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    proposals: list[dict] = []
    needs_claim: list[dict] = []

    vc_token = vercel.vercel_token()
    for c in clusters:
        if c.get("classification") not in OFF_FLEET_PROPOSABLE:
            continue
        repo = c.get("repo")
        owner = None
        if repo:
            commits, complete, err = owner_infer.fetch_commits(repo, max_pages=max_pages)
            if err is None and commits:
                analysis = owner_infer.analyze_commits(commits, idx, complete)
                owner, confidence, runner_up = owner_infer.classify_confidence(
                    analysis["first_author"], analysis["counts"], analysis["first_dates"]
                )
                if owner:
                    owner, original = owner_infer.apply_departed_remap(owner, roster)
                    confidence = _cap_confidence(confidence, c)
                    proposals.append({
                        "key": c["key"],
                        "display": c["display"],
                        "classification": c["classification"],
                        "owner": owner,
                        "confidence": confidence,
                        "inferred_original": original,
                        "repo": repo,
                        "runner_up": runner_up,
                        "owner_note": (
                            f"census: inferred from {repo} commit history "
                            f"({confidence} confidence, {today})"
                            + (f"; departed {original} → {owner}" if original else "")
                        ),
                        "platforms": sorted(c.get("platforms") or {}),
                    })
                    continue
        if vc_token and (c.get("platforms") or {}).get("vercel"):
            vp = c["platforms"]["vercel"][0]
            meta = vercel.production_deploy_meta(vc_token, vp.get("id"), None) or {}
            login = meta.get("commit_author_login") or meta.get("creator_username")
            member = owner_infer.map_author(login, None, idx) if login else None
            if member:
                member, original = owner_infer.apply_departed_remap(member, roster)
                proposals.append({
                    "key": c["key"],
                    "display": c["display"],
                    "classification": c["classification"],
                    "owner": member,
                    "confidence": "medium",
                    "inferred_original": original,
                    "repo": repo,
                    "runner_up": None,
                    "owner_note": (
                        f"census: inferred from Vercel deploy author @{login} "
                        f"(medium confidence, {today})"
                    ),
                    "platforms": sorted(c.get("platforms") or {}),
                })
                continue
        entry = {
            "key": c["key"],
            "display": c["display"],
            "classification": c["classification"],
            "platforms": sorted(c.get("platforms") or {}),
            "repo": repo,
        }

        def _shaped(owner, confidence, original, note, repo_=None):
            return {
                "key": c["key"], "display": c["display"],
                "classification": c["classification"], "owner": owner,
                "confidence": confidence, "inferred_original": original,
                "repo": repo_, "runner_up": None, "owner_note": note,
                "platforms": sorted(c.get("platforms") or {}),
            }

        census_cfg = config.get("census") or {}
        # Channel 3: db-fingerprint — first in-window registrant with a roster
        # email is the builder (mercator→lego class). Non-roster registrants
        # become redacted playbook evidence on the needs_claim entry.
        sb_rows = (c.get("platforms") or {}).get("supabase") or []
        if sb_rows and census_cfg.get("db_fingerprint_probe", True):
            fp = db_fingerprint(str(sb_rows[0].get("id") or ""), config)
            if fp.get("owner"):
                proposals.append(_shaped(
                    fp["owner"], fp["confidence"], fp.get("inferred_original"),
                    f"census: db-fingerprint — {fp['matched_email_redacted']} registered "
                    f"in the creation window ({fp['confidence']} confidence, {today})",
                ))
                continue
            if fp.get("first_signups"):
                entry["db_first_signups"] = fp["first_signups"]
            elif fp.get("error"):
                entry["db_fingerprint_error"] = fp["error"]
        rw_rows = (c.get("platforms") or {}).get("railway") or []
        # Channel 4: Railway source repo — Settings→Source Repo is persistent
        # service config (survives repo deletion + offline services, where the
        # GIT-vars probe below is blind); a personal repo's owner login names
        # the deployer. Org-owned sources carry no personal signal and stay
        # as needs_claim evidence. One API call per project — runs before the
        # per-service CLI link+variables probe.
        if rw_rows and census_cfg.get("railway_source_probe", True):
            sources = railway_source_repos(str(rw_rows[0].get("id") or ""))
            src_member = None
            for src in sources:
                login = src["repo"].split("/", 1)[0]
                src_member = owner_infer.map_author(login, None, idx)
                if src_member:
                    src_member, original = owner_infer.apply_departed_remap(
                        src_member, roster)
                    proposals.append(_shaped(
                        src_member, "medium", original,
                        f"census: Railway source repo {src['repo']} on service "
                        f"{src['service']} (medium confidence, {today})",
                        repo_=src["repo"],
                    ))
                    break
            if src_member:
                continue
            if sources:
                entry["railway_source"] = [s["repo"] for s in sources]
        # Channel 5: Railway GIT metadata — GitHub-connected services name
        # their repo and deploy author; CLI-deployed ones carry nothing
        # (absence recorded as evidence, measured 2026-08-04).
        if rw_rows and census_cfg.get("railway_git_probe", True):
            meta = railway_git_meta(
                str(rw_rows[0].get("id") or ""), rw_rows[0].get("services") or []
            )
            author = meta.get("author")
            member = owner_infer.map_author(author, None, idx) if author else None
            if member:
                member, original = owner_infer.apply_departed_remap(member, roster)
                proposals.append(_shaped(
                    member, "medium", original,
                    f"census: Railway deploy author @{author} on service "
                    f"{meta.get('service')} (medium confidence, {today})",
                    repo_=(f"{meta.get('repo_owner')}/{meta.get('repo_name')}"
                           if meta.get("repo_name") else None),
                ))
                continue
            entry["railway_git"] = (
                {k: v for k, v in meta.items() if v} if meta else "none"
            )
        needs_claim.append(entry)
    return {"proposals": proposals, "needs_claim": needs_claim}


# ---------- persistence (operator-confirmed only) ----------

def persist_claims(
    config_path: str,
    updates: list[dict],
    now_iso: str | None = None,
    shared_infra: list[str] | None = None,
) -> dict:
    """Write census.claims / census.shared_infra. Mirrors persist-owner rules:
    roster-validated owners, existing claims never overwritten."""
    config = load_yaml(config_path)
    census = config.setdefault("census", {})
    claims = census.setdefault("claims", {})
    roster = config.get("team_roster") or {}
    valid = {
        k for k, v in roster.items()
        if k != "_meta" and not (isinstance(v, dict) and v.get("status") == "departed")
    }
    now_iso = now_iso or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    written, skipped = [], []
    for u in updates or []:
        key, owner = u.get("key") or u.get("display"), u.get("owner")
        if not key or not owner:
            raise ValueError(f"claim update missing key or owner: {u!r}")
        if valid and owner not in valid:
            raise ValueError(f"invalid owner for {key}: {owner!r} (active roster: {sorted(valid)})")
        if key in claims and (claims[key] or {}).get("owner"):
            skipped.append(key)
            continue
        claims[key] = {
            "owner": owner,
            "owner_note": u.get("owner_note") or f"census claim confirmed {now_iso[:10]}",
            "confirmed_at": now_iso,
            "platforms": u.get("platforms") or [],
        }
        written.append(key)
    added_shared = []
    if shared_infra:
        existing = census.setdefault("shared_infra", [])
        for name in shared_infra:
            if name not in existing:
                existing.append(name)
                added_shared.append(name)
        existing.sort()
    import yaml
    with open(config_path, "w") as fh:
        yaml.safe_dump(config, fh, sort_keys=False, allow_unicode=True)
    return {"written": written, "skipped_existing": skipped, "shared_infra_added": added_shared}


# ---------- CLI ----------

def cmd_scan(args) -> int:
    config = load_yaml(args.config)
    errors: list[str] = []
    supabase_rows = collect_supabase(errors)
    railway_rows = collect_railway(errors)
    vercel_rows = collect_vercel(errors)
    records, name_index = collect_github(errors)
    repo_index = repo_canonicals(records, name_index)
    clusters = build_clusters(
        supabase_rows, railway_rows, vercel_rows, repo_index, config
    )
    counts: dict[str, int] = {}
    for c in clusters:
        counts[c["classification"]] = counts.get(c["classification"], 0) + 1
    census_cfg = config.get("census") or {}
    micro = float(census_cfg.get("supabase_micro_usd", DEFAULT_SUPABASE_MICRO_USD))
    off_fleet_supabase = sum(
        len((c.get("platforms") or {}).get("supabase") or [])
        for c in clusters
        if c["classification"] in OFF_FLEET_PROPOSABLE
    )
    roster_gaps = reconcile_rosters(config, errors)
    artifact = {
        "platforms": {
            "supabase": len(supabase_rows),
            "railway": len(railway_rows),
            "vercel": len(vercel_rows),
            "github_repos": len(records),
        },
        "counts": counts,
        "roster_gaps": roster_gaps,
        "off_fleet_supabase_projects": off_fleet_supabase,
        "off_fleet_supabase_monthly_usd_floor": round(off_fleet_supabase * micro, 2),
        "clusters": clusters,
        "errors": errors,
    }
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    json.dump(artifact, open(args.output, "w"), indent=1)
    gap_n = len(roster_gaps.get("github", [])) + len(roster_gaps.get("supabase", []))
    print(
        f"census: {len(clusters)} clusters "
        f"({', '.join(f'{k}={v}' for k, v in sorted(counts.items()))}); "
        f"off-fleet supabase {off_fleet_supabase} ≈ ${artifact['off_fleet_supabase_monthly_usd_floor']}/mo floor; "
        f"roster gaps={gap_n}; errors={len(errors)} → {args.output}"
    )
    if gap_n:
        print(f"  ⚠ unrostered identities — github: {roster_gaps['github']}; "
              f"supabase: {roster_gaps['supabase']}", file=sys.stderr)
    for e in errors:
        print(f"  WARN {e}", file=sys.stderr)
    return 0


def cmd_propose_owners(args) -> int:
    config = load_yaml(args.config)
    artifact = json.load(open(args.census))
    result = propose_cluster_owners(artifact.get("clusters") or [], config,
                                    max_pages=args.max_pages)
    json.dump(result, open(args.output, "w"), indent=1)
    print(
        f"census-owners: {len(result['proposals'])} proposal(s), "
        f"{len(result['needs_claim'])} need human claim → {args.output}"
    )
    return 0


def cmd_persist_claims(args) -> int:
    if not args.confirm:
        print("Refusing to persist without --confirm (operator gate).", file=sys.stderr)
        return 1
    updates = json.load(open(args.input))
    if isinstance(updates, dict):
        updates = updates.get("proposals") or updates.get("updates") or []
    result = persist_claims(
        args.config, updates, shared_infra=args.shared_infra or None
    )
    print(
        f"persist-claims: {len(result['written'])} written, "
        f"{len(result['skipped_existing'])} preserved, "
        f"shared_infra +{len(result['shared_infra_added'])}"
    )
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("scan", help="Enumerate platforms, join, classify → census artifact")
    p.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("propose-owners", help="Owner proposals for off-fleet clusters")
    p.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p.add_argument("--census", default=DEFAULT_OUTPUT)
    p.add_argument("--output", default=".runs/_iterate-cross-census-owners.json")
    p.add_argument("--max-pages", type=int, default=3)
    p.set_defaults(func=cmd_propose_owners)

    p = sub.add_parser("persist-claims", help="Write confirmed claims to config census: section")
    p.add_argument("--config", default="experiment/iterate-cross-config.yaml")
    p.add_argument("--input", required=True)
    p.add_argument("--shared-infra", nargs="*", default=None,
                   help="Cluster names to append to census.shared_infra allowlist")
    p.add_argument("--confirm", action="store_true")
    p.set_defaults(func=cmd_persist_claims)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

"""RMG v2 Layer 1 — Prior-Failure Dossier builder.

Produces a two-phase dossier consumed by `solve-reasoning` Phase 1a and
Phase 4b. Phase 1a withholds failure-mode prose to keep the designer's
first pass independent (anchoring resistance — Round-2 critic concern
R2-A2). Phase 4b adds the prose for the cross-check pass.

Public API:

    build_dossier(divergence_files, symptom_signature, project_dir, *,
                  ledger_path=None, candidates_path=None, now=None)
        -> {"phase_1a": [...], "phase_4b": [...]}

Each entry mirrors the others — phase_4b is a strict superset of phase_1a:

    {
      "prior_run_id": str,
      "files_touched": [str, ...],
      "regression_test_present": bool,
      "occurrence_count_60d": int,
      # phase_4b only:
      "failure_mode": str,
      "what_was_missed": str,
      "prior_commit_sha": str | None,
    }

Sources:
  * `.runs/fix-ledger.jsonl` — rows whose `file` ∈ `divergence_files`.
  * `.runs/recurrence-candidates.jsonl` — rows whose composite_identity_hash
    matches any composite derived from the divergence_files set.
  * git log on each divergence file (best-effort; missing/non-repo → []).

`regression_test_present` is True iff the prior run's `solve-trace.json` had
a `recurrence_guard.kind ∈ {test, hook, invariant}` with non-null artifact.
Solve-trace.json files are typically gitignored, so this signal is best-effort
and falls back to False.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent

# Re-use the symptom canonicalizer + compute_hash that ship with Phase B/A.
sys.path.insert(0, str(HERE))
from symptom_canonicalizer import canonicalize_symptom  # noqa: E402

REPO_ROOT_FALLBACK = HERE.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT_FALLBACK / "scripts" / "lib"))
from stack_knowledge_parser import compute_hash  # noqa: E402

# Recurrence guard parser is sibling — used to read prior solve-trace.json
sys.path.insert(0, str(HERE))
try:
    from recurrence_guard_parser import RecurrenceGuardParseError, parse as _parse_guard
except ImportError:  # parser ships in Phase A; tolerate missing
    _parse_guard = None
    RecurrenceGuardParseError = Exception  # type: ignore[misc,assignment]

DOSSIER_WINDOW_DAYS_DEFAULT = 60


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    text = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                rows.append(obj)
    return rows


def _stack_scope_for_file(file_path: str) -> str:
    if not file_path:
        return "unknown"
    parts = Path(file_path).parts
    if len(parts) <= 1:
        return parts[0] if parts else "unknown"
    return "/".join(parts[:2])


def _composite_hash_for_row(row: dict) -> str:
    composite = {
        "root_cause_class": row.get("severity") or "warn",
        "divergence_pattern": canonicalize_symptom(row.get("symptom") or ""),
        "stack_scope": _stack_scope_for_file(row.get("file") or ""),
    }
    return compute_hash(composite)


def _regression_test_present_for(run_id: str, project_dir: Path) -> bool:
    """Best-effort: open a prior run's solve-trace.json and inspect the guard.

    solve-trace.json is per-run and gitignored, so the file rarely persists
    across runs. Treat absence as False.
    """
    trace_path = project_dir / ".runs" / "solve-trace.json"
    if not trace_path.exists():
        return False
    try:
        data = json.loads(trace_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if data.get("run_id") != run_id:
        return False
    pa = data.get("prevention_analysis") or {}
    guard = pa.get("recurrence_guard")
    if guard is None or _parse_guard is None:
        return False
    try:
        canonical = _parse_guard(guard)
    except RecurrenceGuardParseError:
        return False
    kind = canonical.get("kind")
    artifact = canonical.get("artifact")
    return kind in ("test", "hook", "invariant") and bool(artifact)


def _git_log_for_files(files: list[str], project_dir: Path, *, since_days: int) -> dict[str, str]:
    """Return {commit_sha: subject} for commits touching any of `files` in window."""
    if not files:
        return {}
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%d")
    cmd = [
        "git",
        "-C",
        str(project_dir),
        "log",
        "--since",
        since,
        "--pretty=format:%H\t%s",
        "--",
        *files,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {}
    if result.returncode != 0:
        return {}
    out: dict[str, str] = {}
    for line in result.stdout.splitlines():
        sha, _, subject = line.partition("\t")
        if sha:
            out[sha] = subject
    return out


def _summarize_failure_mode(row: dict) -> str:
    symptom = row.get("symptom") or row.get("desc") or row.get("description") or ""
    fix = row.get("fix") or ""
    if symptom and fix:
        return f"{symptom.strip()[:120]} — prior fix: {fix.strip()[:80]}"
    return symptom.strip()[:200] or "(no symptom recorded)"


def _summarize_what_was_missed(rows: list[dict]) -> str:
    if not rows:
        return ""
    fixes = [r.get("fix") or r.get("action") for r in rows if r.get("fix") or r.get("action")]
    fixes = [f.strip() for f in fixes if isinstance(f, str)]
    if not fixes:
        return "prior fix attempts did not record a fix description"
    head = fixes[0][:120]
    if len(fixes) > 1:
        return f"prior attempts: {head} (+{len(fixes) - 1} more); recurrence indicates the guard did not hold"
    return f"prior attempt: {head}; recurrence indicates the guard did not hold"


def build_dossier(
    divergence_files: list[str],
    symptom_signature: str,
    project_dir: str | os.PathLike | None = None,
    *,
    ledger_path: str | os.PathLike | None = None,
    candidates_path: str | os.PathLike | None = None,
    since_days: int = DOSSIER_WINDOW_DAYS_DEFAULT,
    now: datetime | None = None,
) -> dict:
    """Return a two-phase dossier for the given divergence files + symptom."""
    project_dir = Path(project_dir or os.getcwd()).resolve()
    ledger = Path(ledger_path) if ledger_path else project_dir / ".runs" / "fix-ledger.jsonl"
    candidates = Path(candidates_path) if candidates_path else project_dir / ".runs" / "recurrence-candidates.jsonl"
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=since_days)
    file_set = set(divergence_files or [])

    rows = _read_jsonl(ledger)
    cand_rows = _read_jsonl(candidates)

    # Index candidates by composite_identity_hash for fast lookup.
    candidate_by_hash: dict[str, dict] = {}
    for cand in cand_rows:
        chash = cand.get("composite_identity_hash")
        if isinstance(chash, str):
            candidate_by_hash[chash] = cand

    matched_by_run: dict[str, dict] = {}
    for row in rows:
        if row.get("entry_type") == "template-edit":
            continue
        ts = _parse_timestamp(row.get("timestamp"))
        if ts is not None and ts < cutoff:
            continue
        row_file = row.get("file") or ""
        chash = _composite_hash_for_row(row)
        in_candidate = chash in candidate_by_hash
        in_files = row_file in file_set or any(row_file.startswith(f.rstrip("/") + "/") for f in file_set)
        if not (in_candidate or in_files):
            continue
        run_id = row.get("run_id") or "<unknown>"
        bucket = matched_by_run.setdefault(
            run_id,
            {"rows": [], "files": set(), "first": None, "last": None, "composite_hash": chash},
        )
        bucket["rows"].append(row)
        if row_file:
            bucket["files"].add(row_file)
        if ts is not None:
            if bucket["first"] is None or ts < bucket["first"]:
                bucket["first"] = ts
            if bucket["last"] is None or ts > bucket["last"]:
                bucket["last"] = ts

    # Per-composite count (for occurrence_count_60d)
    composite_run_count: dict[str, set[str]] = {}
    for run_id, bucket in matched_by_run.items():
        composite_run_count.setdefault(bucket["composite_hash"], set()).add(run_id)

    sha_by_subject = _git_log_for_files(sorted(file_set), project_dir, since_days=since_days)

    phase_1a: list[dict] = []
    phase_4b: list[dict] = []
    for run_id, bucket in sorted(matched_by_run.items()):
        files = sorted(bucket["files"])
        composite_hash = bucket["composite_hash"]
        occurrences = len(composite_run_count.get(composite_hash, {run_id}))
        regression_test = _regression_test_present_for(run_id, project_dir)
        prior_commit = next(iter(sha_by_subject.keys()), None)
        sample = bucket["rows"][0]

        slim = {
            "prior_run_id": run_id,
            "files_touched": files,
            "regression_test_present": regression_test,
            "occurrence_count_60d": occurrences,
        }
        full = dict(slim)
        full["failure_mode"] = _summarize_failure_mode(sample)
        full["what_was_missed"] = _summarize_what_was_missed(bucket["rows"])
        full["prior_commit_sha"] = prior_commit
        phase_1a.append(slim)
        phase_4b.append(full)

    return {"phase_1a": phase_1a, "phase_4b": phase_4b}


__all__ = ["build_dossier", "DOSSIER_WINDOW_DAYS_DEFAULT"]

#!/usr/bin/env python3
"""Tier-2 run-metrics telemetry + Tier-3 raw-evidence archive for /iterate --cross.

Shared by state-x4a (phase 1) and state-x5a (phase 2) — the two persist states.

Why this exists: the decision ledgers (Tier 1) are per-MVP `current`-overwrite
files, so run-over-run series (batch phase2 verdict accumulation, window-roll
regression proof, spend/CAC trends, retro datasets) are unrecoverable from
them, and `verdict_history`'s change-only dedup structurally drops same-verdict
runs. This module adds:

  Tier 2 — experiment/iterate-cross-run-metrics.jsonl
    Append-only, one line per run x MVP, explicit WHITELIST projection
    (PII-safe by construction). Includes `__orphan_*` rows — they carry the
    campaign→MVP join and are excluded from the ledgers by design.
    Merge policy: .gitattributes declares merge=union for this file; union
    merges can duplicate lines, so READERS MUST dedupe on
    (run_id, phase, mvp). Per the GRAIM .jsonl carve-out this file is NOT
    registered in gate-readable-artifacts-canonical.json.

    Per-line schema (schema_version 1):
      {schema_version, run_id, phase (1|2), mvp, mvp_canonical, orphan,
       reference_now, persisted_at, verdict, why, ga_clicks, ga_impressions,
       ga_cost, ga_cpc, ga_cpc_usd, ga_currency, ga_conv, ga_campaigns,
       ph_signups, db_signups_real, true_conv_rate,          # phase 1
       pay_intents, pay_intent_rate, revenue_intent_per_click,  # phase 2
       stalled_bucket, stalled_cause, stalled_streak}

  Tier 3 — experiment/runs-archive/<UTC-second-stamp>-<mode>/
    Python-only copies of the run's consumed raw inputs (GA CSV + scores
    json). NEVER a bash `cp` naming a gated .runs/*.json source — that trips
    gate-artifact-bash-write-guard.sh's operator matcher and poisons the
    deny-cutover soak signal. Directory stamp is WALL-CLOCK UTC (unlike the
    ledgers' data-clock run_date) because it must be unique per persist even
    when the data clock froze. Same-sha-set re-persists are skipped
    (supported x3-re-run-after-x4a workflow). index.jsonl (merge=union too)
    carries one line per archive dir with per-file sha256.

PII guard: every outbound byte stream is scanned with an email regex
(UTF-16 inputs are decoded first — the GA CSV export is UTF-16LE, where
interleaved NUL bytes would blind a raw-bytes scan). Projection helpers
reject field names matching *_audit / email* so an upstream schema change
cannot silently smuggle audit rows into git.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re

RUN_METRICS_PATH = "experiment/iterate-cross-run-metrics.jsonl"
ARCHIVE_ROOT = "experiment/runs-archive"
SCHEMA_VERSION = 1

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_FORBIDDEN_FIELD_RE = re.compile(r"(_audit$|^email)", re.IGNORECASE)

# Whitelisted projection: metric-dict keys, then score-row-level keys, then
# ctx-row-level keys (first non-None wins where duplicated).
_METRIC_KEYS = (
    "ga_clicks", "ga_impressions", "ga_cost", "ga_cpc", "ga_cpc_usd",
    "ga_currency", "ga_conv", "ph_signups", "db_signups_real",
    "true_conv_rate", "pay_intents", "pay_intent_rate",
    "revenue_intent_per_click", "stalled_bucket", "stalled_cause",
    "stalled_streak",
    # Sub-floor early-stop sentinel (#2152): batch/trend queries must be able
    # to tell a floor-guaranteed early GO from an at-floor GO.
    "early_pass",
)


class PiiViolation(ValueError):
    pass


def _decode(blob: bytes) -> str:
    """Decode for scanning: honor UTF-16 BOMs (GA CSV default), else UTF-8."""
    if blob.startswith(b"\xff\xfe") or blob.startswith(b"\xfe\xff"):
        return blob.decode("utf-16", errors="replace")
    return blob.decode("utf-8", errors="replace")


def assert_no_pii(text_or_bytes: str | bytes, label: str = "payload") -> None:
    """Hard-fail when an email-like token appears in an outbound stream.

    Sanctioned team addresses already live in the git-tracked config
    (team_roster / email_filter); the artifacts this module writes carry
    campaign stats and aggregate metrics only, so ANY address here means an
    upstream schema leaked audit rows — refuse rather than redact.
    """
    text = _decode(text_or_bytes) if isinstance(text_or_bytes, bytes) else text_or_bytes
    hit = _EMAIL_RE.search(text)
    if hit:
        token = hit.group(0)
        raise PiiViolation(
            f"PII guard: email-like token in {label}: {token[:3]}***@{token.split('@', 1)[1]}"
        )


def _clean_fieldnames(row: dict) -> None:
    bad = [k for k in row if _FORBIDDEN_FIELD_RE.search(str(k))]
    if bad:
        raise PiiViolation(f"PII guard: forbidden field name(s) in projection: {bad}")


def build_run_metrics_row(phase: int, run_id: str | None, reference_now: str | None,
                          persisted_at: str, score: dict, ctx_mvp: dict | None = None,
                          mvp_canonical: str | None = None) -> dict:
    """One whitelisted Tier-2 line for a score row (orphans included)."""
    m = score.get("metrics") or {}
    ctx_mvp = ctx_mvp or {}
    name = score.get("name")
    row: dict = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "phase": phase,
        "mvp": name,
        "mvp_canonical": mvp_canonical or name,
        "orphan": bool(str(name or "").startswith("__orphan_")),
        "reference_now": reference_now,
        "persisted_at": persisted_at,
        "verdict": score.get("headline_verdict"),
        "why": score.get("why") or "",
        "ga_campaigns": score.get("ga_campaigns") or ctx_mvp.get("ga_campaigns"),
    }
    for k in _METRIC_KEYS:
        v = m.get(k)
        if v is None:
            v = ctx_mvp.get(k)
        row[k] = v
    _clean_fieldnames(row)
    return row


def append_run_metrics(rows: list[dict], path: str = RUN_METRICS_PATH) -> int:
    """Atomic-append the run's rows (O_APPEND + flush + fsync, one JSON per
    line — mirrors append_deviation_log.py). Returns rows written."""
    if not rows:
        return 0
    payload_lines = []
    for r in rows:
        _clean_fieldnames(r)
        line = json.dumps(r, sort_keys=True)
        assert_no_pii(line, label=f"run-metrics row for {r.get('mvp')!r}")
        payload_lines.append(line + "\n")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        with os.fdopen(fd, "a") as f:
            f.writelines(payload_lines)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        raise
    return len(payload_lines)


def _sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _index_has_sha_set(index_path: str, sha_set: set[str]) -> bool:
    if not os.path.exists(index_path):
        return False
    try:
        with open(index_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                shas = {f.get("sha256") for f in entry.get("files", [])}
                if shas == sha_set:
                    return True
    except OSError:
        return False
    return False


def archive_run_files(mode: str, files: list[tuple[str, str]],
                      run_id: str | None,
                      expected_csv_sha: str | None = None,
                      archive_root: str = ARCHIVE_ROOT,
                      now: datetime.datetime | None = None) -> dict:
    """Tier-3 archive: python-copy the run's raw inputs into a stamped dir.

    files: [(src_path, dst_name)]. Returns {"dir": ..., "skipped": bool,
    "csv_changed_since_consume": bool}. Fail-loud on existing dir; skip
    entirely when the identical sha set was already archived (re-persist).
    `expected_csv_sha` is the consume-time fingerprint recorded by
    x0a / x5's CSV gate — a mismatch is WARN + archive the actual bytes +
    flag, never a block (the actual bytes are the evidence).
    """
    blobs: list[tuple[str, bytes]] = []
    for src, dst_name in files:
        if not os.path.exists(src):
            raise FileNotFoundError(f"archive source missing: {src}")
        with open(src, "rb") as fh:
            blob = fh.read()
        assert_no_pii(blob, label=src)
        blobs.append((dst_name, blob))

    sha_by_name = {name: _sha256(blob) for name, blob in blobs}
    index_path = os.path.join(archive_root, "index.jsonl")
    if _index_has_sha_set(index_path, set(sha_by_name.values())):
        print(f"runs-archive: identical sha set already archived — skipping ({mode})")
        return {"dir": None, "skipped": True, "csv_changed_since_consume": False}

    csv_changed = False
    if expected_csv_sha:
        actual = next((sha for name, sha in sha_by_name.items() if name.endswith(".csv")), None)
        if actual and actual != expected_csv_sha:
            csv_changed = True
            print(
                "WARN: runs-archive: GA CSV sha256 differs from the consume-time "
                "fingerprint — archiving the actual bytes with csv_changed_since_consume=true"
            )

    # Wall-clock UTC second stamp: unique per persist even when the data
    # clock (ledger run_date) froze; deliberately a different clock domain.
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    dst_dir = os.path.join(archive_root, f"{stamp}-{mode}")
    if os.path.exists(dst_dir):
        raise FileExistsError(f"archive dir already exists: {dst_dir}")
    os.makedirs(dst_dir)
    for name, blob in blobs:
        with open(os.path.join(dst_dir, name), "wb") as out:
            out.write(blob)

    entry = {
        "stamp": stamp,
        "dir": os.path.basename(dst_dir),
        "mode": mode,
        "run_id": run_id,
        "csv_changed_since_consume": csv_changed,
        "files": [{"file": name, "bytes": len(blob), "sha256": sha_by_name[name]}
                  for name, blob in blobs],
    }
    fd = os.open(index_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    with os.fdopen(fd, "a") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")
        f.flush()
        os.fsync(f.fileno())
    print(f"runs-archive: {len(blobs)} file(s) → {dst_dir}")
    return {"dir": dst_dir, "skipped": False, "csv_changed_since_consume": csv_changed}

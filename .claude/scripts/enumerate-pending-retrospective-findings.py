#!/usr/bin/env python3
"""Enumerate retrospective filing CANDIDATES from runtime evidence.

Issue context: #1276 — retrospective filing failed 5 times because lead
self-judgment under turn-budget pressure skipped real findings. This
script produces a SUPERSET of fileable candidates from existing runtime
artifacts (which the LLM cannot fabricate). Lead retains semantic judgment
over each candidate but cannot silently drop them — every candidate must
either be filed (via file-retrospective-finding.py) or explicitly suppressed
in retrospective-result.json with a closed-enum reason.

Inputs (all optional; missing → no candidates from that source):
  .runs/agent-spawn-log.jsonl           — agent spawn provenance
  .runs/hook-friction-summary.json      — aggregated hook denial counts
  .runs/fix-ledger.jsonl                — fix log entries (template-edit rows)
  .runs/template-coherence-cache.json   — cross-file coherence findings

Output: .runs/retrospective-pending-findings.json
  {
    "run_id": "<...>",
    "schema_version": 2,
    "generated_at": "<ISO>",
    "candidates": [
      {
        "candidate_id": "<sha256[:12] hash of (kind, key)>",
        "kind": "hook-friction" | "template-edit" | "coherence-finding" | "agent-recovery",
        "confidence": "high" | "medium" | "low",
        "key": "<canonical identifier — used for dedup>",
        "evidence": {<source-specific fields>},
        "source_files": ["<path>"]
      }
    ]
  }

Confidence rubric (programmatic 3-condition test approximation):
  HIGH:   hook-friction with count >= 3 AND distinct hook (proven recurring)
          OR template-edit row with kind=template-edit (lead patched template)
          OR coherence-finding category=cross_file_contradiction
  MEDIUM: agent-recovery (recovery_validated=true but recovery happened)
          OR hook-friction with count 1-2 (one-off but still informative)
  LOW:    any uncategorized signal (lead must triage)

Lead reconciles in retrospective-result.json:
  - file via file-retrospective-finding.py → candidate_id appears in
    .runs/retrospective-filed-findings.json
  - suppress via "suppressions": [{candidate_id, reason: <enum>, ...}]
    in retrospective-result.json

validate-retrospective-completeness.py asserts every candidate has one
disposition.

Fail-open: missing inputs OR parse errors → empty candidate list, exit 0.
This script is a candidate generator, not a gate.
"""

from __future__ import annotations

import datetime
import glob
import hashlib
import json
import os
import sys
from typing import Any


def _active_run_id() -> str:
    best = None
    best_ts = ""
    for f in glob.glob(".runs/*-context.json"):
        if "epilogue" in f:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("completed") is True:
            continue
        ts = d.get("timestamp") or ""
        if ts >= best_ts:
            best = d
            best_ts = ts
    return (best or {}).get("run_id", "")


def _hash_key(kind: str, key: str) -> str:
    return hashlib.sha256(f"{kind}:{key}".encode()).hexdigest()[:12]


def _candidates_from_hook_friction(rid: str) -> list[dict]:
    path = ".runs/hook-friction-summary.json"
    if not os.path.isfile(path):
        return []
    try:
        data = json.load(open(path))
    except Exception:
        return []

    if data.get("run_id") and rid and data.get("run_id") != rid:
        # Summary is for a different run — defensive, since aggregator
        # already scopes; treat as empty rather than incorrect.
        return []

    out: list[dict] = []
    hooks = data.get("hooks") or {}
    for hook_name, info in hooks.items():
        count = int(info.get("count") or 0)
        if count <= 0:
            continue
        confidence = "high" if count >= 3 else "medium"
        key = f"hook:{hook_name}"
        out.append({
            "candidate_id": _hash_key("hook-friction", key),
            "kind": "hook-friction",
            "confidence": confidence,
            "key": key,
            "evidence": {
                "hook": hook_name,
                "count": count,
                "sample_reasons": info.get("sample_reasons") or [],
            },
            "source_files": [path],
        })
    return out


def _candidates_from_template_edits(rid: str) -> list[dict]:
    path = ".runs/fix-ledger.jsonl"
    if not os.path.isfile(path):
        return []
    out: list[dict] = []
    seen_keys: set[str] = set()
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if rid and row.get("run_id") and row.get("run_id") != rid:
                    continue
                if row.get("entry_type") != "template-edit":
                    continue
                target = row.get("target_file") or row.get("file") or ""
                if not target:
                    continue
                key = f"template-edit:{target}"
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                out.append({
                    "candidate_id": _hash_key("template-edit", key),
                    "kind": "template-edit",
                    "confidence": "high",
                    "key": key,
                    "evidence": {
                        "target_file": target,
                        "summary": (row.get("summary") or "")[:200],
                    },
                    "source_files": [path],
                })
    except Exception:
        pass
    return out


def _candidates_from_coherence_findings(_rid: str) -> list[dict]:
    path = ".runs/template-coherence-cache.json"
    if not os.path.isfile(path):
        return []
    try:
        data = json.load(open(path))
    except Exception:
        return []

    out: list[dict] = []
    seen_keys: set[str] = set()
    findings = data.get("findings") or {}
    for category, items in findings.items():
        if not isinstance(items, list):
            continue
        for f in items:
            if not isinstance(f, dict):
                continue
            rule_id = f.get("rule_id") or f.get("id") or ""
            target = f.get("file") or f.get("target") or ""
            key = f"coherence:{category}:{rule_id}:{target}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            confidence = "high" if category == "cross_file_contradiction" else "medium"
            out.append({
                "candidate_id": _hash_key("coherence-finding", key),
                "kind": "coherence-finding",
                "confidence": confidence,
                "key": key,
                "evidence": {
                    "category": category,
                    "rule_id": rule_id,
                    "target": target,
                    "message": (f.get("message") or "")[:200],
                },
                "source_files": [path],
            })
    return out


def _candidates_from_agent_recoveries(rid: str) -> list[dict]:
    """Agent traces with recovery_validated=true are candidates (medium)."""
    out: list[dict] = []
    for tf in glob.glob(".runs/agent-traces/*.json"):
        try:
            data = json.load(open(tf))
        except Exception:
            continue
        if rid and data.get("run_id") and data.get("run_id") != rid:
            continue
        prov = data.get("provenance") or ""
        recovery = data.get("recovery_validated")
        if prov != "recovery" and not recovery:
            continue
        agent = data.get("agent") or os.path.basename(tf).replace(".json", "")
        key = f"recovery:{agent}"
        out.append({
            "candidate_id": _hash_key("agent-recovery", key),
            "kind": "agent-recovery",
            "confidence": "medium",
            "key": key,
            "evidence": {
                "agent": agent,
                "provenance": prov,
                "recovery_validated": recovery,
                "degraded_reason": data.get("degraded_reason"),
            },
            "source_files": [tf],
        })
    return out


def _candidates_from_trace_overwrites(rid: str) -> list[dict]:
    """5th candidate source (#1335): trace-overwrite candidates from
    detect-trace-overwrites.py.

    Runs the detector first (idempotent, fail-open), then merges its
    candidates here. The detector flags 2+ spawns of the same agent within
    a single run_id when the agent is NOT in
    .claude/patterns/sanctioned-respawn-flows.json — OR when sanctioned but
    its precondition (e.g., solve-critic round-2 requires the round-1
    sidecar to exist with round=1) is unmet.
    """
    import subprocess
    try:
        subprocess.run(
            ["python3", ".claude/scripts/detect-trace-overwrites.py"],
            check=False,
            capture_output=True,
        )
    except Exception:
        pass
    path = ".runs/trace-overwrite-candidates.json"
    if not os.path.isfile(path):
        return []
    try:
        data = json.load(open(path))
    except Exception:
        return []
    return data.get("candidates", [])


def _candidates_from_lead_deviations(rid: str) -> list[dict]:
    """6th candidate source (#1431): lead-deviation entries from append-only
    .runs/lead-deviation-log.jsonl.

    Closes prose-gate `lead-synthesized-numerical-bounds` enumerator blindness:
    the existing 5 channels only see trace-leaving artifacts; this channel
    surfaces manual-write bypasses logged by prose-gate validators (with
    gate_layer:prose-gates-v1 attribution for E2E falsification).

    Emits one candidate per (gate_id, deviation_type, expected_artifact) key
    from entries with auto_filed=false from the current run window.
    """
    path = ".runs/lead-deviation-log.jsonl"
    if not os.path.isfile(path):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if rid and row.get("run_id") and row.get("run_id") != rid:
                    continue
                if row.get("auto_filed") is True:
                    continue
                gate_id = row.get("gate_id") or ""
                dev_type = row.get("deviation_type") or ""
                ev = row.get("evidence") or {}
                key = (
                    f"deviation:{gate_id}:{dev_type}:"
                    f"{ev.get('expected_artifact', '')}"
                )
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "candidate_id": _hash_key("lead-deviation", key),
                    "kind": "lead-deviation",
                    "confidence": "high",
                    "key": key,
                    "evidence": {
                        "gate_id": gate_id,
                        "gate_layer": row.get("gate_layer") or "prose-gates-v1",
                        "deviation_type": dev_type,
                        "evidence": ev,
                    },
                    "source_files": [path],
                })
    except Exception:
        return []
    return out


def _candidates_from_log_write_failures(rid: str) -> list[dict]:
    """7th candidate source: silent appender failures from
    .runs/lead-deviation-log.write-failures.jsonl. HIGH-confidence by default
    — silent failures are always actionable (the deviation log is the single
    source of observability for prose-gate behavior; silent writes break
    everything downstream). Closes #1431 reliability gap."""
    path = ".runs/lead-deviation-log.write-failures.jsonl"
    if not os.path.isfile(path):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                exc = row.get("exception", "") or ""
                # Dedupe by exception class+message prefix; same root cause
                # across runs collapses to one finding.
                key = f"log-write-failure:{exc[:80]}"
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "candidate_id": _hash_key("log-write-failure", key),
                    "kind": "log-write-failure",
                    "confidence": "high",
                    "key": key,
                    "evidence": {
                        "exception": exc,
                        "ts": row.get("ts"),
                        "original_payload_gate_id": (
                            row.get("original_payload", {}).get("gate_id", "")
                            if isinstance(row.get("original_payload"), dict) else ""
                        ),
                    },
                    "source_files": [path],
                })
    except Exception:
        return []
    return out


def _candidates_from_agent_workarounds(rid: str) -> list[dict]:
    """GECR #1470 — enumerate workarounds[] + template_gap_observed[] from
    every agent trace as candidates.

    Schema in agent-output-contract.md §135-173 (AOC v1.3): all 32 trace-
    writing agents emit `workarounds[]` and `template_gap_observed[]` with
    empty-array default. Non-empty entries are friction signals — the agent
    couldn't proceed without papering over a deeper issue. These have been
    inert candidate sources since #1449 because enumerate-pending was never
    extended to consume them.

    Skip entries where `root_cause_unresolved == False` (Plan-Agent-B
    Concern 7: explicit self-resolved workaround should not surface).

    Dedup key collapses paraphrasing across agents touching the same
    (file, line, type) location (Plan-Agent-B Concern 6).
    """
    out: list[dict] = []
    seen_keys: set[str] = set()
    try:
        traces = glob.glob(".runs/agent-traces/*.json")
    except Exception:
        return []

    for trace_path in traces:
        try:
            with open(trace_path) as fh:
                trace = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue

        if rid and trace.get("run_id") and trace.get("run_id") != rid:
            continue

        agent_name = trace.get("agent") or os.path.basename(trace_path)

        # workarounds[]
        workarounds = trace.get("workarounds") or []
        if isinstance(workarounds, list):
            for entry in workarounds:
                if not isinstance(entry, dict):
                    continue
                if entry.get("root_cause_unresolved") is False:
                    # Explicit self-resolved — skip
                    continue
                file = entry.get("file") or ""
                line = entry.get("line", 0)
                type_ = entry.get("type") or ""
                description = (entry.get("description") or "")[:200]
                if not file and not description:
                    continue
                key = (
                    f"agent-workarounds:{file}:{line}:{type_}:"
                    f"{description[:80].lower().strip()}"
                )
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                # Confidence: high when explicitly flagged unresolved;
                # low when absent (defensive default — flag for triage)
                confidence = (
                    "high" if entry.get("root_cause_unresolved") is True else "low"
                )
                out.append({
                    "candidate_id": _hash_key("agent-workarounds", key),
                    "kind": "agent-workaround",
                    "confidence": confidence,
                    "key": key,
                    "evidence": {
                        "file": file,
                        "line": line,
                        "type": type_,
                        "description": description,
                        "agent": agent_name,
                        "root_cause_unresolved": entry.get("root_cause_unresolved"),
                    },
                    "source_files": [trace_path],
                })

        # template_gap_observed[]
        gaps = trace.get("template_gap_observed") or []
        if isinstance(gaps, list):
            for entry in gaps:
                if not isinstance(entry, dict):
                    continue
                template_path = entry.get("template_path") or ""
                section = entry.get("section") or ""
                observation = (entry.get("observation") or "")[:200]
                if not template_path and not observation:
                    continue
                key = (
                    f"agent-template-gap:{template_path}:{section}:"
                    f"{observation[:80].lower().strip()}"
                )
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                out.append({
                    "candidate_id": _hash_key("agent-template-gap", key),
                    "kind": "agent-workaround",  # share kind for downstream consumers
                    "confidence": "high",
                    "key": key,
                    "evidence": {
                        "template_path": template_path,
                        "section": section,
                        "observation": observation,
                        "suggested_remediation": (
                            entry.get("suggested_remediation") or ""
                        )[:200],
                        "agent": agent_name,
                    },
                    "source_files": [trace_path],
                })
    return out


def _candidates_from_verify_failures(rid: str) -> list[dict]:
    """GECR #1470 — enumerate verify-recheck failed states as candidates.

    Per-state granularity (Plan-Agent-B Concern 4). Dedup key uses state +
    hash(error) so a rerun-that-still-fails collapses to the same candidate
    but a transient flake (re-run passes) does not propagate.
    """
    path = ".runs/verify-recheck.json"
    if not os.path.isfile(path):
        return []
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    # Tolerate missing run_id; filter only when both present
    if rid and data.get("run_id") and data.get("run_id") != rid:
        return []

    verify_results = data.get("verify_results") or []
    if not isinstance(verify_results, list):
        return []

    out: list[dict] = []
    seen_keys: set[str] = set()
    for row in verify_results:
        if not isinstance(row, dict):
            continue
        if row.get("passed") is not False:
            continue
        state = str(row.get("state") or row.get("name") or "").strip()
        error = str(row.get("error") or "")
        if not state and not error:
            continue
        # Deterministic dedup: state + first 80 chars of canonicalized error
        error_norm = error[:80].strip()
        key = f"verify-failure:{state}:{error_norm}"
        if key in seen_keys:
            continue
        seen_keys.add(key)
        out.append({
            "candidate_id": _hash_key("verify-failure", key),
            "kind": "verify-failure",
            "confidence": "high",
            "key": key,
            "evidence": {
                "state": state,
                "error": error[:300],
            },
            "source_files": [path],
        })
    return out


def main() -> int:
    rid = _active_run_id()
    candidates: list[dict] = []
    candidates.extend(_candidates_from_hook_friction(rid))
    candidates.extend(_candidates_from_template_edits(rid))
    candidates.extend(_candidates_from_coherence_findings(rid))
    candidates.extend(_candidates_from_agent_recoveries(rid))
    candidates.extend(_candidates_from_agent_workarounds(rid))  # GECR #1470
    candidates.extend(_candidates_from_trace_overwrites(rid))
    candidates.extend(_candidates_from_verify_failures(rid))  # GECR #1470
    candidates.extend(_candidates_from_lead_deviations(rid))
    candidates.extend(_candidates_from_log_write_failures(rid))

    # Stable kind priority for sort (Plan-Agent-B Concern 24 — new kinds
    # interleave deterministically with existing kinds).
    KIND_PRIORITY = {
        "hook-friction": 1,
        "template-edit": 2,
        "coherence-finding": 3,
        "agent-recovery": 4,
        "agent-workaround": 5,
        "trace-overwrite": 6,
        "verify-failure": 7,
        "lead-deviation": 8,
        "log-write-failure": 9,
    }
    # Sort: kind_priority → high → medium → low → by candidate_id (stable)
    order = {"high": 0, "medium": 1, "low": 2}
    candidates.sort(key=lambda c: (
        KIND_PRIORITY.get(c.get("kind", ""), 99),
        order.get(c["confidence"], 9),
        c["candidate_id"],
    ))

    out = {
        "run_id": rid,
        "schema_version": 2,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "candidates": candidates,
    }
    os.makedirs(".runs", exist_ok=True)
    with open(".runs/retrospective-pending-findings.json", "w") as f:
        json.dump(out, f, indent=2)
    print(
        f"enumerate-pending-retrospective-findings: {len(candidates)} candidates "
        f"(high={sum(1 for c in candidates if c['confidence']=='high')}, "
        f"medium={sum(1 for c in candidates if c['confidence']=='medium')}, "
        f"low={sum(1 for c in candidates if c['confidence']=='low')})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

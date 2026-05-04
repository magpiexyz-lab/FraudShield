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


def main() -> int:
    rid = _active_run_id()
    candidates: list[dict] = []
    candidates.extend(_candidates_from_hook_friction(rid))
    candidates.extend(_candidates_from_template_edits(rid))
    candidates.extend(_candidates_from_coherence_findings(rid))
    candidates.extend(_candidates_from_agent_recoveries(rid))

    # Sort: high → medium → low, then by candidate_id for stability
    order = {"high": 0, "medium": 1, "low": 2}
    candidates.sort(key=lambda c: (order.get(c["confidence"], 9), c["candidate_id"]))

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

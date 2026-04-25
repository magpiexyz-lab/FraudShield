#!/usr/bin/env python3
"""merge-design-critic-traces.py — Official merge script for verify STATE 3b.

Merges per-page `.runs/agent-traces/design-critic-*.json` traces into the
aggregate `.runs/agent-traces/design-critic.json`. Previously inlined in
state-3b-quality-gate.md but extracted to this dedicated script so the
agent-trace-write-guard.sh allowlist can authorise exactly this write
(issue #1045). The script's invocation pattern is tied to the guard's
ALLOWED_REGEX_MERGE_DESIGN_CRITIC — do not rename or move.

Preserves every field the inline merge produced, including:
  - pages_reviewed, min_score, min_score_all, verdict
  - checks_performed, sections_below_8, fixes_applied, unresolved_sections
  - per_page_review_methods, per_page_review_evidence
  - review_method_gate_corrections (tight gate auto-corrections)
  - pre_existing_debt, fixes
  - shared_fixes_applied (Stage 1c shared-component verdict upgrade)
  - timestamp, run_id

Exit codes:
  0 — merge succeeded, aggregate trace written
  1 — no per-page traces found (nothing to merge)
  2 — per-page trace parse error

Usage:
  python3 .claude/scripts/merge-design-critic-traces.py
"""
import datetime
import glob
import json
import os
import sys


def main() -> int:
    traces_dir = ".runs/agent-traces"
    per_page_pattern = os.path.join(traces_dir, "design-critic-*.json")
    batches = sorted(glob.glob(per_page_pattern))

    if not batches:
        sys.stderr.write(
            f"merge-design-critic-traces: no per-page traces at {per_page_pattern}\n"
        )
        return 1

    run_id = ""
    try:
        with open(".runs/verify-context.json") as f:
            run_id = json.load(f).get("run_id", "")
    except Exception:
        pass

    merged = {
        "agent": "design-critic",
        "pages_reviewed": 0,
        "min_score": 10,
        "verdict": "pass",
        "checks_performed": [],
        "pages": len(batches),
        "consistency_fixes": 0,
        "sections_below_8": 0,
        "fixes_applied": 0,
        "unresolved_sections": 0,
        "min_score_all": 10,
        "pre_existing_debt": [],
        "fixes": [],
        "per_page_review_methods": {},
        "per_page_review_evidence": [],
        "run_id": run_id,
    }
    worst_verdicts = {"unresolved": 3, "fixed": 2, "pass": 1}
    shared_base = os.path.join(traces_dir, "design-critic-shared.json")
    aggregate_path = os.path.join(traces_dir, "design-critic.json")

    for b in batches:
        # Skip the shared trace and the aggregate output — both live in the same
        # directory and would be picked up by the glob otherwise.
        if b == shared_base or b == aggregate_path:
            continue
        try:
            with open(b) as f:
                d = json.load(f)
        except Exception as exc:
            sys.stderr.write(f"merge-design-critic-traces: cannot parse {b}: {exc}\n")
            return 2

        merged["pages_reviewed"] += d.get("pages_reviewed", 1)
        merged["min_score"] = min(merged["min_score"], d.get("min_score", 10))
        merged["min_score_all"] = min(merged["min_score_all"], d.get("min_score_all", 10))
        merged["checks_performed"].extend(d.get("checks_performed", []))
        merged["sections_below_8"] += d.get("sections_below_8", 0)
        merged["fixes_applied"] += d.get("fixes_applied", 0)
        merged["unresolved_sections"] += d.get("unresolved_sections", 0)

        # render-review-detection aggregation (render-review-detection.md)
        page_key = (
            d.get("page")
            or d.get("weakest_page")
            or os.path.basename(b).replace("design-critic-", "").replace(".json", "")
        )
        rm = d.get("review_method")
        prov_here = d.get("provenance", "self")
        degraded_reason = d.get("degraded_reason", "")
        if rm:
            merged["per_page_review_methods"][page_key] = rm
            merged["per_page_review_evidence"].append(
                {"page": page_key, **(d.get("review_evidence") or {})}
            )
            # Invariant enforcement (tight gate): source-only/unknown MUST be
            # unresolved. When an agent emits a non-unresolved verdict on a
            # degraded render, self-heal the in-memory trace AND log so the
            # agent bug surfaces.
            #
            # #1042 Session C carve-out: a self-degraded trace with
            # degraded_reason="demo-mode-fixture-short-circuit" is the
            # sanctioned DEMO_MODE fixture short-circuit path — it already
            # emits verdict=unresolved (from write-degraded-trace.py
            # --verdict unresolved), so the self-heal would be a no-op.
            # Skip the self-heal write entirely for this path so the
            # audit log is not polluted with phantom "corrections".
            original_verdict = d.get("verdict", "")
            if (
                rm in ("source-only", "unknown")
                and original_verdict.lower() != "unresolved"
                and not (
                    prov_here == "self-degraded"
                    and degraded_reason == "demo-mode-fixture-short-circuit"
                )
            ):
                print(
                    "WARN: [" + page_key + "] review_method=" + rm
                    + " but verdict=" + original_verdict
                    + "; forcing verdict=unresolved per Rendered-Review Contract"
                )
                d["verdict"] = "unresolved"
                merged.setdefault("review_method_gate_corrections", []).append(
                    {"page": page_key, "review_method": rm, "original_verdict": original_verdict}
                )
            if (
                prov_here == "self-degraded"
                and degraded_reason == "demo-mode-fixture-short-circuit"
            ):
                merged.setdefault("demo_mode_short_circuit_pages", []).append(page_key)
            if (
                prov_here == "self-degraded"
                and degraded_reason == "empty-boundary-fast-path"
            ):
                merged.setdefault("empty_boundary_fast_path_pages", []).append(page_key)

        debt = d.get("pre_existing_debt", [])
        if isinstance(debt, list):
            merged["pre_existing_debt"].extend(debt)
        page_fixes = d.get("fixes", [])
        if isinstance(page_fixes, list):
            merged["fixes"].extend(page_fixes)

        # Per-page provenance propagation for the aggregate_ok predicate
        # (lib-verdict.sh). The predicate re-reads per-page trace files
        # directly so this aggregate view is informational, but it helps
        # downstream consumers (q-score, PR body) reason about which pages
        # landed in which bucket without re-globbing. (#1042)
        merged.setdefault("per_page_provenance", {})[page_key] = prov_here
        merged.setdefault("per_page_recovery_validated", {})[page_key] = bool(
            d.get("recovery_validated", False)
        )
        srv = d.get("source_review_verdict")
        if srv is not None:
            merged.setdefault("per_page_source_review_verdict", {})[page_key] = srv
        if degraded_reason:
            merged.setdefault("per_page_degraded_reason", {})[page_key] = degraded_reason

        bv = d.get("verdict", "pass").lower()
        if worst_verdicts.get(bv, 0) > worst_verdicts.get(merged["verdict"], 0):
            merged["verdict"] = bv
            merged["weakest_page"] = d.get("weakest_page", d.get("page", ""))
        if d.get("retry_attempted"):
            merged["retry_attempted"] = True

    # Stage 1c shared-component verdict upgrade
    if os.path.exists(shared_base):
        try:
            with open(shared_base) as f:
                shared = json.load(f)
        except Exception as exc:
            sys.stderr.write(f"merge-design-critic-traces: cannot parse shared trace: {exc}\n")
            return 2
        shared_v = shared.get("verdict", "").lower()
        shared_fixes = shared.get("fixes_applied", 0)
        merged["shared_fixes_applied"] = shared_fixes
        # If only unresolved issues were shared-component, and shared agent fixed them:
        if merged["verdict"] == "unresolved" and shared_v in ("pass", "fixed"):
            if shared_fixes > 0 and merged["unresolved_sections"] <= shared_fixes:
                merged["verdict"] = "fixed"
                merged["unresolved_sections"] = 0

    merged["timestamp"] = datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    # AOC v1 lead-merge aggregate contract (#1042 Session C). The aggregate
    # `design-critic.json` is composed from per-page sibling traces, so it
    # carries provenance="lead-merge" + partial=true (required by
    # artifact-integrity-gate.sh:144-147 for any provenance != self). The
    # aggregate_ok hard-gate predicate keys on `contributing_spawn_indexes`
    # being a non-empty list (and verifies each sibling independently).
    merged["provenance"] = "lead-merge"
    merged["partial"] = True
    # contributing_spawn_indexes semantics (state-completion-gate.sh:261-283):
    # count must equal the number of `hook: skill-agent-gate` entries for
    # this base in the current run_id. Match that filter exactly — if we
    # count any entries written by other hooks (or by older log formats),
    # the gate will report "aggregate claims N spawns but spawn-log has M".
    spawn_log_path = ".runs/agent-spawn-log.jsonl"
    contributing: list[int] = []
    if run_id and os.path.exists(spawn_log_path):
        try:
            with open(spawn_log_path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    if (
                        rec.get("agent") == "design-critic"
                        and rec.get("run_id") == run_id
                        and rec.get("hook") == "skill-agent-gate"
                        and rec.get("spawn_index") is not None
                    ):
                        contributing.append(int(rec["spawn_index"]))
        except OSError:
            pass
    if not contributing:
        # Spawn log absent / run_id unresolvable / pre-AOC run — fall back
        # to the per-batch index so the aggregate still has a non-empty
        # list. Each contributing sibling trace is still verified by the
        # aggregate_ok predicate. In a well-formed AOC v1 run the spawn
        # log is always present, so this fallback only fires in
        # integration tests and legacy replays.
        contributing = list(range(len([
            b for b in batches
            if b not in (shared_base, aggregate_path)
        ])))
    merged["contributing_spawn_indexes"] = sorted(set(contributing))

    with open(aggregate_path, "w") as f:
        json.dump(merged, f)
    print(f"merge-design-critic-traces: wrote {aggregate_path} (pages={merged['pages']}, verdict={merged['verdict']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

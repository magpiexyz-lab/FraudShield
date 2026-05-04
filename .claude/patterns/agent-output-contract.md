# Agent Output Contract v1.1 (AOC v1.1)

> **Canonical source of truth for agent-trace verdict vocabulary and fix-ledger
> semantics across the 17 `verdict_agents`.** Closes #1044 (verdict-vocab
> mismatch) and #1048 (fix-log count drift). v1.1 closes #1067 (lead-* provenance
> gaps), #1064 (centralized writer + lead-fix path + post-completion recovery),
> #1055 (resolve-reviewer first-class), and #1056 (frontmatter coherence). This
> file is the single dependency point for downstream cross-group work
> (e.g., #1042 design-critic degraded fixtures via Session C orchestration).

## Why this contract exists

Two systemic drift defects share one root cause: **agent trace artifacts are
produced with one semantics but consumed by gates/pattern-classifier/q-score
with a different semantics.**

- **#1044** — `agent-trace-protocol.md` declared `{pass, fail, blocked,
  unresolved}`; fixer/reviewer agents emit richer agent-native verdicts
  (`fixed`, `all fixed`, `DEGRADED`, `2 FAILs`). Hard gates keyed on the
  protocol vocab only, so successful fixer runs were systematically BLOCKed.
  Lead manually rewrote `verdict → pass`, destroying the pass-clean vs
  pass-after-fixes distinction that observation-phase and q-score need.
- **#1048** — `.runs/fix-log.md` is a prose diary (one line per logical batch;
  19 fixes → 1 entry). Downstream (verify-report-gate fix-count check,
  pattern-classifier, q-score `R_system`/`R_human`, observation-phase) treats
  it as an authoritative per-fix ledger. Observed drift in a real run: 74
  trace fixes vs 9 fix-log entries vs 12 in verify-report.md frontmatter.

AOC v1 closes the gap by making the produced data match the consumed schema
and by guarding against future drift with blocking coherence rules.

## Versioning & stability

- **AOC v1** is the combined contract. Major-version bumps are reserved for
  breaking changes to either sub-schema. Additive fields (new agents, new
  allowed_results) are minor revisions recorded in
  `agent-registry.json._schema_version_notes`.
- **Backward compatibility**: every new field has a default; legacy traces
  self-heal via `migrate-legacy-traces.py` on first encounter. The
  `verify-report-gate.sh` self-heal path runs migration in-place rather than
  refusing mid-workflow.
- **Migration-period dual-check**: consumers accept either the structured
  ledger (`.runs/fix-ledger.jsonl`) or the prose diary (`.runs/fix-log.md`)
  for one transitional release.

## Sub-schemas

### AVS v1 — Agent Verdict Schema

**Two fields**, separating "what gates need" from "what qualifies the result":

| Field | Required when | Enum |
|-------|---------------|------|
| `verdict` | all completed traces | `pass` \| `fail` \| `blocked` \| `unresolved` (lowercase; see Casing below) |
| `result` | `agent ∈ verdict_agents` and `status == "completed"` | `clean` \| `fixed` \| `partial` \| `degraded` \| `skipped` \| `none` \| `count_summary` \| `null` |

- **`verdict`** is the core protocol vocabulary. Gate predicates in
  `.claude/scripts/evaluate-hard-gate-predicates.py` key on this field only. Gate semantics
  never depend on the qualifier.
- **`result`** is the qualifier that preserves information that `verdict`
  alone cannot carry. Observation-phase, q-score, and human readers key on
  this field.

#### Invariants (verdict × result)

| `(verdict, result)` | Semantic |
|---|---|
| `(pass, clean)` | Agent found nothing to do. No work performed. |
| `(pass, fixed)` | Agent found issues and resolved all of them. |
| `(pass, partial)` | Agent found issues, resolved some; remainder are non-critical. |
| `(fail, partial)` | Agent found issues, resolved some; **unresolved criticals remain** (`unresolved_critical > 0`). |
| `(fail, none)` | Agent failed without performing work (pre-flight failure, malformed input). |
| `(blocked, none)` | Agent cannot execute (environment, tool missing, permission). |
| `(unresolved, null)` | Agent reviewed but determined the question is unresolvable. |
| `(*, count_summary)` | Scanner / adversarial agent; see Count-summary agents below. |

> **NOT reserved here**: `(unresolved, degraded)` and `(blocked, degraded)` —
> these combinations were considered for #1042 fixture short-circuit but
> **deliberately NOT introduced**. Per cross-group coordination, #1042 uses
> `provenance=self-degraded + recovery_validated=true + degraded_reason=<str>`
> while leaving `verdict` at whatever the source-only review concluded. The
> `validated_fallback` predicate already accepts self-degraded traces when
> recovery is validated — no new verdict combination is required.

#### Casing

All `verdict` values are **lowercase**. Legacy uppercase emissions (`PASS`,
`FAIL`, `DEGRADED`, `SKIPPED`) are migrated to lowercase by
`.claude/scripts/migrate-legacy-traces.py`:`case_normalize_verdict()` and by
updates to each agent's Trace Output section.

#### template_recommendations[] (scaffold-* agents — #1252 contract)

All `scaffold-*` agents (scaffold-setup, scaffold-init, scaffold-libs,
scaffold-pages, scaffold-landing, scaffold-images, scaffold-wire,
scaffold-externals) MUST emit one of:

  - `template_recommendations: [{file, section, recommendation, fix_template}, ...]`
    AND `template_recommendations_explicit_none: false`

  - `template_recommendations: []` AND `template_recommendations_explicit_none: true`

This is **schema completeness enforcement** (round-2 critic Concern 7) —
the prior approach of grepping agent prose for "consider updating" patterns
was bypassable by phrasing variation. Either the agent fills the structured
field or it explicitly attests "no template gaps observed."

Each entry's `file` MUST be under `.claude/` or `scripts/` (template-rooted)
AND must exist on disk. Validator: `.claude/scripts/validate-scaffold-recommendations-schema.py`.

The observation-phase Step 2 evidence collector reads this field across
all scaffold-* traces; entries whose `file` matches a template path get
auto-filed as [observe] issues via `file-retrospective-finding.py`.

#### Count-summary agents

Scanner and adversarial agents do not report a single qualitative `result`;
they report structured counts. These agents set `result = "count_summary"`
and emit additional required fields that gate predicates key on via the
existing `additional_block_conditions` mechanism in
`agent-registry.json.hard_gates[]` (no new DSL is introduced).

| Agent | Required structured field(s) |
|-------|------------------------------|
| security-defender | `fails_count` (int), `findings_count` (int) |
| security-attacker | `findings_count` (int) |
| performance-reporter | `warnings_count` (int) |
| accessibility-scanner | `violations_count` (int) |
| design-consistency-checker | `inconsistent_count` (int) |
| resolve-challenger | `confirmed_count` (int), `disputed_count` (int) |
| review-challenger | `confirmed_count` (int), `disputed_count` (int) |
| solve-critic | `type_a_count` (int), `type_b_count` (int), `type_c_count` (int) |
| pattern-classifier | `saved` (int), `skipped` (int), `total` (int) |

The canonical per-agent table of `allowed_verdicts` and `allowed_results`
lives in `.claude/patterns/agent-registry.json.verdict_agents_schema`. The
R1 coherence rule enforces consistency between that registry, each agent
definition file, and the predicate vocabulary in `evaluate-hard-gate-predicates.py`.

### Provenance enum (canonical)

AOC v1.1 formally defines the `provenance` enum covering seven write paths
across four real-world authorship modes. This is the contract surface
consumed by Session C for #1042 and by the cross-skill recovery / lead-fix
flows added in v1.1.

| Value | Authorship | Semantic |
|-------|-----------|----------|
| `self` | Agent | Agent completed normally; it is the author of its own trace. |
| `self-degraded` | Agent | Agent completed, but **either** (a) execution was degraded (recovery-scenario semantics — image-limit, screenshot crash, turn-budget, tool unavailable) **or** (b) the subject-under-review was degraded (fixture short-circuit, DEMO_MODE dynamic-route 404, stale fixture — Session C / #1042 semantics). Both require `degraded_reason: <string>` and `recovery_validated: true`. |
| `recovery` | Lead | Agent crashed so hard it could not self-report; orchestrator wrote the trace via `write-recovery-trace.sh` with mandatory `--reason`. |
| `lead-merge` | Lead | Orchestrator composed this aggregate from sibling traces (e.g., `design-critic.json` merged from per-page `design-critic-<page>.json`). |
| `lead-on-behalf` *(v1.1)* | Lead | Agent succeeded and returned a full payload, but the agent's own trace write was blocked (hook deny, tool-budget exhaustion). Lead transcribed the agent's reported result. Requires `source: <attestation>` (e.g., `"agent-returned-text"`, `"agent-tool-output"`) plus `partial: true` and `recovery_validated: true` for downstream confidence. |
| `lead-synthesized` *(v1.1)* | Lead | Agent was never spawned (covered by another mechanism — e.g., a shared test file that satisfies coverage). Lead writes a consistency marker so downstream presence checks succeed. Requires `coverage_provider: <artifact-path>` plus `partial: true`; **must not** claim per-fix changes. |
| `lead-fix` *(v1.1)* | Lead | Lead applied a fix in-flight during a verify stage without spawning a subagent. Requires `lead_attestation: true` plus `partial: true`. Routed to `pattern-classifier`'s "Lead-authored fix" branch (see `.claude/agents/pattern-classifier.md`). |

**`degraded_reason` is the canonical field name** for the specific cause,
used by both self-degraded sub-cases. Session C's original `fallback_reason`
draft is aligned to this name.

#### Authorship vs. confidence

The four real-world authorship modes have distinct downstream confidence:

| Mode | Lead's knowledge of content | Provenance value | Predicate path |
|---|---|---|---|
| Agent crashed, no output | Pure reconstruction from side-effects | `recovery` | `validated_fallback` (requires recovery_validated) |
| Agent succeeded, returned data, write blocked | Transcription of agent's payload | `lead-on-behalf` | `validated_fallback` (requires recovery_validated) |
| Agent never spawned, coverage guaranteed elsewhere | Lead synthesized as marker | `lead-synthesized` | `pass_lead_synthesized` (requires coverage_provider) |
| Lead applied fix during verify | Direct knowledge | `lead-fix` | `pass_lead_fix` (requires lead_attestation) |

The predicates are defined in `.claude/scripts/evaluate-hard-gate-predicates.py`
(invoked by `.claude/hooks/lib-hard-gate.sh`) and gated per-agent via
`agent-registry.json.hard_gates[].allow_predicates`.

### FLS v1 — Fix Ledger Schema

**`.runs/fix-ledger.jsonl` is the authoritative per-fix ledger.** One JSON
object per line. Generated by `.claude/scripts/write-fix-ledger.py` from
agent trace `fixes[]` arrays; not authored by agents directly.
`.runs/fix-log.md` becomes a **rendered view** produced by
`.claude/scripts/render-fix-log.py` — never hand-authored after AOC v1.

#### Canonical record

| Field | Type | Required | Description |
|-------|------|:-:|---|
| `fix_id` | string | ✓ | `<source_trace_basename>:<fix_array_index>` for agent fixes; `lead-<skill>:<run_id>:<counter>` for lead-fix entries (v1.1) — stable identity |
| `agent` | string | ✓ | Source agent (matches `source_trace` basename); for lead-fix, this is `lead-<skill>` |
| `source_trace` | string | ✓ | Path to agent trace (e.g., `.runs/agent-traces/security-fixer.json`); for lead-fix, this is the literal string `"lead"` |
| `run_id` | string | ✓ | Run ID from source trace (or falls back to caller-supplied `--run-id`) |
| `file` | string | ✓ | Repo-relative path of the fixed file (must be non-empty; granularity gate v1.1 rejects null/empty) |
| `symptom` | string | ✓ | Short description of what was wrong |
| `fix` | string | ✓ | Short description of the change applied |
| `timestamp` | string | ✓ | ISO 8601 UTC (from source trace timestamp) |
| `batch_id` | string | ✓ | Groups fixes the agent committed in the same trace write session; equal to `source_trace` basename for agent fixes; per-invocation timestamp for lead-fix |
| `batch_size` | int | ✓ | Count of fixes in the same trace at consolidation time; `1` for lead-fix invocations |
| `provenance` *(v1.1)* | string | ✓ | `agent` (default — fix attributed to its source agent) \| `lead` (for lead-fix entries) \| `lead-on-behalf` (agent reported, lead transcribed). Distinguishes authorship at the row level for Q-score weighting and observation candidacy. |
| `severity` *(v1.1)* | string | optional | `fix` (default) \| `warn`. Used by STATE 5 e2e-config WARN migration (see PR5/S8). |
| `lead_transcribed` *(EARC slice 1)* | boolean | optional | `true` when the row originated from a `fixes[]` entry that the lead recorded via `write-recovery-trace.sh --fixes-json` (the agent crashed; the lead anchored fixes to external evidence). Distinguishes "agent's own claim" from "lead's recovery-evidence claim" for pattern-classifier and Q-score routing. The source trace also carries `lead_evidence_source`. Closes #1189. |

- **Authoritative count** = `wc -l .runs/fix-ledger.jsonl`.
- **Deterministic ordering** when rendered: by `(batch_id, fix_index)`.
- **Idempotent consolidation**: the consolidator skips `fix_id` values
  already present in the ledger. Running unconditionally on every state
  advance is safe and cheap (O(n_traces)).
- **Atomic write**: the consolidator writes to a tempfile (prefix
  `.fix-ledger-…`) and `os.rename()`s onto the final path (POSIX atomic).

#### Rendered `fix-log.md` format

The renderer preserves the existing prose format for backward compatibility
with the transitional dual-check period:

```
Fix (<agent>): `<file>` — Symptom: <symptom> — Fix: <fix>
```

Variant rendering for special row types:

```
⚠️ Template patch (<agent>): `<file>` (<before_hash> → <after_hash>)        # entry_type == "template-edit"
📝 Lead-transcribed (<agent>, recovery): `<file>` — Symptom: ... — Fix: ... # lead_transcribed == true (EARC slice 1)
```

## Canonical Writer Policy

Writes to canonical artifacts in `.runs/` MUST go through dedicated writer scripts so AOC v1.1 metadata is stamped consistently. Direct shell redirects, Python `open(..., 'w')`, and `Write`/`Edit` tool calls targeting these paths are blocked at the hook layer.

### Artifact → canonical writer mapping

| Artifact path | Canonical writer(s) | Hook enforcement |
|---|---|---|
| `.runs/<skill>-context.json` | `.claude/scripts/init-context.sh <skill> [extra_json]` | Bash: protected-fields drop with `WARN` log (PR3 E1). Static lint: `.claude/scripts/check-init-context-callers.sh` (PR3 E2) flags any caller passing `{branch, timestamp, run_id, skill}` in extra_json. |
| `.runs/agent-traces/*.json` | `.claude/scripts/write-agent-trace.sh` (AOC v1.1 self / self-degraded / lead-on-behalf / lead-synthesized); `write-recovery-trace.sh` (orchestrator recovery); `write-degraded-trace.py` (agent self-degradation); `validate-recovery.sh` (stamps `recovery_validated:true` only); `migrate-legacy-traces.py` (one-shot); `merge-design-critic-traces.py` / `merge-scaffold-pages-traces.py` (lead-merge aggregates); `augment-trace.py` (descriptive-field augmenter); `scripts/init-trace.py` (start-of-run stub) | Bash: `.claude/hooks/agent-trace-write-guard.sh` (chain-bound write target detection + Python `open()` literal + variable-indirection helper). Write/Edit: `.claude/hooks/agent-trace-write-gate.sh` (path-match denies; PR3 ships in WARN-mode, PR4 flips to deny after soak). |
| `.runs/fix-ledger.jsonl` / `.runs/fix-log.md` | `.claude/scripts/write-fix-ledger.py` (consolidator + `--lead-fix`); `.claude/scripts/render-fix-log.py` (renderer) | Bash: `.claude/hooks/fix-ledger-write-guard.sh` (bound-write check + Python `open()` literal). |
| `.runs/agent-spawn-log.jsonl` | `.claude/hooks/skill-agent-gate.sh` (the hook itself appends rows; no other writer is sanctioned). | Bash: `trace-write-guard.sh`. Write/Edit: `artifact-integrity-gate.sh:14-17`. |
| Gate-readable `.runs/*.json` (107 paths in `.claude/patterns/gate-readable-artifacts-canonical.json`) | `bash .claude/scripts/lib/write-gate-artifact.sh --path <p> --payload '<json>'` (GRAIM v2 C1: stamps `{skill, run_id, written_at}` from `resolve_active_identity`). | Write/Edit: `.claude/hooks/gate-artifact-write-gate.sh` (GRAIM v2 Slice 6 PR1 — WARN-mode initial; soak window precedes flip to DENY in a future PR, mirroring `agent-trace-write-gate.sh` #1174 → #1175 → #1176). The canonical writer uses Bash redirect (not Write/Edit), so it is intentionally never caught by this hook — the hook closes the direct-Write/Edit bypass that #1198 demonstrated. |

### Protected fields rule (init-context.sh)

`init-context.sh` treats `{branch, timestamp, run_id, skill}` as protected — callers cannot override them via extra_json (issue #941 fix; `skill` is the immutable physical running skill, `attributed_to` is the Q-score attribution field). When a caller does pass a protected field, the script drops it and emits a `WARN:` log line (PR3 E1, was `INFO:` pre-PR3). The static linter `check-init-context-callers.sh` (PR3 E2) scans `.claude/{skills,procedures,agents}/**/*.md` for any `init-context.sh` invocation passing protected fields and reports findings during `lifecycle-finalize.sh` Step 4.5.

### Worked example: parallel scaffold-pages

```bash
python3 - <<'PYEOF'
import json, subprocess
PAGE_SLUG = "pricing"
SPAWN_INDEX = 2     # from this agent's spawn metadata
trace = {
    "verdict": "pass",
    "result": "clean",
    "checks_performed": ["page_authored", "events_wired", "build_smoke"],
    "no_fixes_claimed": True,
    "files_created": ["src/app/pricing/page.tsx"],
    "page": PAGE_SLUG,
}
subprocess.run(
    ["bash", ".claude/scripts/write-agent-trace.sh", "scaffold-pages",
     "--json", json.dumps(trace),
     "--trace-filename", f"scaffold-pages-{PAGE_SLUG}.json",
     "--spawn-index", str(SPAWN_INDEX)],
    check=True,
)
PYEOF
```

The `--trace-filename` and `--spawn-index` flags together disambiguate sibling spawn-log rows so each parallel scaffold-pages instance gets its own `spawn_sha` correctly attributed.

## Consumer contract

AOC v1 has **eleven authoritative consumers**. Every consumer reads
`.runs/fix-ledger.jsonl` as canonical source. During the transitional period,
consumers may dual-check against `.runs/fix-log.md` when the ledger is absent,
but this fallback MUST be removed in the release after AOC v1 lands.

| Consumer | File | What it reads |
|---|---|---|
| 1 | `.claude/agents/pattern-classifier.md` | Ledger rows → classification decisions (each row is one candidate) |
| 2 | `.claude/scripts/write-q-score.py` | `wc -l` ledger → `R_system` / `R_human` inputs |
| 3 | `.claude/scripts/check-artifact-presence.py` | Ledger existence when any trace has `fixes[]` |
| 4 | `.claude/scripts/check-cross-artifact-consistency.py` | Per-agent ledger row counts vs trace `fixes[]` |
| 5 | `.claude/hooks/verify-report-gate.sh` | Hard gate + self-heal (refuses if `trace-migration-unresolved.json.unresolved_count > 0`) |
| 6 | `.claude/patterns/state-registry.json` VERIFY (verify:3c, verify:3d) | Per-agent ledger counts with `run_id` filter; `make sync-verify` propagates to state-file prose |
| 7 | `.claude/hooks/lib-verdict-consistency.sh` `check_fixlog_verdict_consistency` | Ledger count vs verdict (replaces fix-log regex count) |
| 8 | `.claude/hooks/lib-artifacts.sh` | Asserts ledger presence alongside fix-log.md |
| 9 | `.claude/scripts/compliance-audit.py` `check_fix_log_count` | `wc -l` ledger instead of fix-log regex |
| 10 | `.claude/hooks/patterns-saved-gate.sh` Invariant 4 | `wc -l` ledger vs `total` field |
| 11 | `.claude/hooks/skill-agent-gate.sh:177` | Ledger existence check |

## Prevention — coherence rules

Three rules added to `.claude/patterns/template-coherence-rules.json`,
consumed by `.claude/scripts/verify-linter.sh` (already wired into
`lifecycle-finalize.sh` Step 4.5 per CLAUDE.md Rule 12). Findings emit as
the `cross_file_contradiction` category with `severity: block`. When
`--strict-aoc` is passed, these findings are blocking regardless of
`--warn-only`.

| Rule | Type | Enforces |
|---|---|---|
| **R1 `aoc-verdict-vocab-consistency`** | `verdict_vocab_consistency` | Agent definitions emit only values declared in `agent-registry.json.verdict_agents_schema`; `evaluate-hard-gate-predicates.py` predicates reference only those values. |
| **R2 `aoc-fix-ledger-ownership`** | `ledger_ownership` | `.runs/fix-log.md` and `.runs/fix-ledger.jsonl` are written only by `write-fix-ledger.py` / `render-fix-log.py`. Complemented at runtime by `.claude/hooks/fix-ledger-write-guard.sh`. |
| **R3 `aoc-consumer-coverage`** | `consumer_coverage` | Every file in the Consumer contract table above references `.runs/fix-ledger.jsonl` (regex on `fix-log.md` alone is a stale-consumer finding). |

Rule schemas are defined in `.claude/patterns/coherence-rule-schema.json`.
The `verify-linter.sh` dispatcher extends the existing
`field_role_map` / `artifact_lifecycle` types with three new functions
(`check_verdict_vocab_consistency`, `check_ledger_ownership`,
`check_consumer_coverage`). Findings are emitted as structured objects
`{category, rule_type, message, severity}`.

## Migration guarantees

1. **Idempotent.** `migrate-legacy-traces.py` writes a receipt
   (`.runs/trace-migration.json`) and skips already-migrated traces. A trace
   is fully-migrated iff **both** `provenance` and `result` are set — old
   traces with `provenance` but no `result` are re-visited to backfill.
2. **Fail-closed on unknown.** For each of the 17 verdict_agents, the
   migration script carries `LEGACY_VERDICT_MAP`. Known agent + known
   verdict → apply mapping. Known agent + unknown verdict, or count_summary
   agent with missing structured field and unparseable verdict string →
   append to `.runs/trace-migration-unresolved.json`. `verify-report-gate.sh`
   self-heal MUST refuse to proceed when `unresolved_count > 0`. Silent
   default-to-zero is forbidden.
3. **Case normalization.** Uppercase verdicts (`PASS`, `FAIL`, `DEGRADED`,
   `SKIPPED`) migrate to lowercase. Unknown verdicts pass through the
   normalizer unchanged so fail-closed can catch them.
4. **#1042 stamping.** For `design-critic` traces exhibiting the
   DEMO_MODE dynamic-route 404 short-circuit shape (`verdict=fixed +
   review_method=source-only`), the migration stamps
   `provenance=self-degraded`, `degraded_reason="demo-mode-fixture-short-circuit"`,
   and invokes `validate-recovery.sh` once to stamp
   `recovery_validated=true`. Idempotent. This keeps #1042 on the
   `validated_fallback` predicate path without new verdict combinations.

## Versioning rules for future incompatible changes

- **Adding a new verdict_agent**: add entry to
  `verdict_agents_schema`; add case to `LEGACY_VERDICT_MAP` (even if empty);
  update `hard_gates[]` if the agent needs gating; R1 will catch drift.
- **Adding a new `allowed_result`**: increment minor version in
  `agent-registry.json._schema_version_notes`; update the Invariants table
  above; ensure predicates or `additional_block_conditions` cover the new
  value.
- **Adding a new `provenance` value** *(v1.1 policy)*: minor bump
  (additive). Requires synchronized updates to (a) `valid_prov` set in
  `artifact-integrity-gate.sh`; (b) any new `pass_lead_*`-style predicate
  in `evaluate-hard-gate-predicates.py` plus inclusion in `aggregate_ok` sibling acceptance;
  (c) `validate-recovery.sh` if the new value goes through evidence
  validation; (d) consumer hard_gates in `agent-registry.json` that should
  accept it; (e) new predicate registered in
  `agent-registry._hard_gates_predicate_docs`. Pattern: ship S0-style
  consumer sync atomically with the vocabulary doc change.
- **Adding a new `provenance` field** to `fix-ledger.jsonl`: minor bump
  (additive). Update `write-fix-ledger.py` to emit; update consumers in
  the Consumer contract table to read; ensure default value preserves
  pre-v1.1 reader compatibility.
- **Changing `verdict` enum** (core four values): requires a major bump and
  a new contract file (`agent-output-contract-v2.md`). Do not mutate v1.
- **Changing the meaning of an existing `provenance` value**: requires a
  major bump (different downstream confidence semantics). Do not mutate.
- **Deprecating an agent**: remove from `verdict_agents_schema`; keep
  `LEGACY_VERDICT_MAP` entry for at least one release to migrate in-flight
  traces.

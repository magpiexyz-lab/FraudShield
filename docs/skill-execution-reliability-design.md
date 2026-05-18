# Skill Execution Reliability — Design Proposal

> **Status**: Proposal (not implemented). Output of `/solve` 2026-05-18,
> refined via first-principles follow-up. Implementation owner: TBD.
> Implementation skill: `/change`.

## 1. The Problem

Skills are state machines. Each state is a markdown file under
`.claude/skills/<skill>/state-*.md` containing prose instructions
(ACTIONS) the LLM is supposed to execute in order.

State boundaries are well-guarded:
- `state-completion-gate.sh` (PreToolUse hook on Bash) runs the state's
  VERIFY command from `state-registry.json` before allowing
  `advance-state.sh` to mark a state complete.

But **inside each state, there is no enforcement**. The LLM reads a
multi-step prose protocol and is trusted to execute every step. When
states grow long (e.g., `verify/state-3a-design-agents.md` is 583 lines
with 4-8 agent spawns and inter-step synchronization;
`distribute/state-6-campaign.md` is 854 lines with 11 substeps), the
LLM occasionally **skips an internal step**. The omission is invisible
until the end-of-state VERIFY (sometimes catches it, often doesn't),
and by then recovery is expensive.

Concrete evidence: issue #1076 (design-critic Pareto Step 5.5 silently
skipped) and its regression #1129 (state-3b VERIFY didn't catch the
omission) are exactly this class. Each prior fix has tightened the
end-of-state VERIFY — patching the symptom of "the step that should
have run didn't" rather than the structural cause "internal steps are
unmonitored."

## 2. First-Principles Insight

Everything in skill execution that has a **postcondition + ordering +
gate** is the same kind of object. We call the coarse instances
"states" and the imagined fine instances "steps" — but they are not
two concepts. They are **one concept at different granularities**.

A "step" is just a state at a finer granularity.

Therefore: **do not introduce a `step` concept.** Extend the existing
state concept to support finer granularity via nesting.

This avoids the alternative path (which an earlier draft of this
proposal walked down) of duplicating the entire state machinery
— a separate manifest schema, a separate hook, a separate context
artifact, a separate advance script — only to model what is
operationally the same thing as a state at a different depth.

## 3. The Proposed Design

### 3.1 One concept: nested states

Today's state IDs are flat: `0`, `1`, `2`, `3a`, `3b`, `3c`. Rule 13
forbids deeper nesting (`3a1` is banned). We **relax this constraint**:

```
3a              ← logical phase (existing)
3a.1            ← sub-state of 3a (new)
3a.2
3a.3
```

Only **two levels** of nesting are permitted (`<id>.<n>`, single dot).
This is enough for every state we have today; it forbids the slippery
slope to arbitrary-depth trees.

### 3.2 state-registry.json supports nested keys

```json
"verify": {
  "3a": {
    "verify": "<...>",
    "has_children": true
  },
  "3a.1": {
    "kind": "script",
    "exec": ".claude/scripts/preflight-design-claims.sh",
    "verify": "test -f .runs/design-claims.json && jq -e '.claims | length > 0' .runs/design-claims.json",
    "on_fail": "halt"
  },
  "3a.2": {
    "kind": "agent",
    "prose": ".claude/skills/verify/state-3a/3a.2-spawn-critics.md",
    "verify": "python3 .claude/scripts/check-design-critic-traces.py",
    "on_fail": {"kind": "retry", "max": 2, "then": "halt"}
  }
}
```

New optional fields per state:
- **`has_children`** (parent only): when `true`, the parent state cannot
  be marked complete until every child is in `completed_states`.
- **`kind`** (child only): `script` | `llm` | `agent` | `human`.
  Determines who executes the body.
- **`exec`** (when `kind=script`): bash/python script path. Runner runs
  this directly, no LLM involvement.
- **`prose`** (when `kind=llm|agent|human`): path to the per-state
  prose file. Read on demand by the runner.
- **`on_fail`** (child): `"halt"` | `{"kind": "retry", "max": N, "then": "halt"}`.

States without these fields behave exactly as today. **Fully
backward-compatible.**

### 3.3 state-completion-gate.sh: one-line addition

The existing hook gains a single check:

> When `advance-state.sh <skill> <state>` is called for a state with
> `has_children: true`, additionally verify that every child state ID
> in the registry under that parent is in `completed_states`.
> **Fail-CLOSED** if not.

That's the entire enforcement mechanism. No new hook. No new
artifact path. No new schema.

### 3.4 state-runner.sh: optional convenience

A helper script. For a state with children, the runner:
1. Reads the children list from `state-registry.json`
2. For each child in order:
   - If `kind: script` → execute `exec`, run `verify`, advance via
     `advance-state.sh <skill> <child-id>`
   - If `kind: llm|agent|human` → write a side-channel JSON
     (`.runs/state-runner-status.json`) telling the LLM which prose
     file to read; exit; wait for LLM callback
3. When all children done → call `advance-state.sh <skill> <parent>`

The runner is **optional**. The LLM could also manually call
`advance-state.sh verify 3a.1`, `3a.2`, ... — but the runner reduces
toil and guarantees one-step-at-a-time prose delivery (LLM only reads
the current child's prose, not all of them).

### 3.5 Coherence rules (verify-linter.sh)

Two declarative rules added to `template-coherence-rules.json`:

1. **`nested-state-completeness`**: if `state-registry.json["<skill>"]
   ["<parent>"].has_children == true`, every `<parent>.<n>` child key
   must exist with `kind` + `verify` fields.
2. **`nested-state-prose-pairing`**: every child with `kind != script`
   must have its `prose` file present on disk.

Both block at `lifecycle-finalize.sh` Step 4.5.

### 3.6 LLM context discipline

When the LLM is executing `state-3a` (parent) via the runner, the
runner emits **only the current child's prose** to the side-channel.
The LLM never reads the 583 lines of the old monolithic state file —
because it doesn't exist anymore. The parent state file becomes a thin
stub (~20 lines):

```markdown
# STATE 3a: DESIGN_AGENTS (managed by runner — nested state)

This state has child states 3a.1 through 3a.N (see state-registry.json).

Execute: `bash .claude/scripts/state-runner.sh verify 3a`

Do NOT read individual child prose files directly — the runner writes
`.runs/state-runner-status.json` with the next child to execute.
```

The LLM **can't** read ahead even if it tries, because each child's
prose lives in a separate small file and the runner only writes
*one* into the status JSON at a time.

## 4. Why This Beats the Alternatives

| Alternative | Why rejected |
|---|---|
| **Keep prose as-is, write more incident-specific VERIFY checks** | Status quo. Treats symptoms forever; 7 prior incidents already followed this pattern. |
| **Pure script orchestration (LLM as a leaf tool)** | Violates Claude Code's LLM-as-driver runtime. Not buildable without runtime changes. |
| **Two concepts: `state` + new `step`** | What an earlier draft proposed. Adds permanent maintenance burden of two parallel mechanisms (registry vs manifest, gate vs gate, context vs step-state). Round-2 critic flagged this. |
| **Split long states into many flat sub-states (3a → 3a, 3b, ..., 3k)** | Burns the flat 26-letter alphabet quickly. Loses the "logical phase" abstraction. State-registry becomes unreadable. |
| **Proposed: one concept, nested states (3a → 3a.1, 3a.2, ...)** | Preserves the phase abstraction. Reuses every existing mechanism. Optional adoption per state. Two-level nesting cap prevents slippery slope. |

## 5. Migration Plan

**Important**: implementation cost is not yet measured. The first phase
is a **spike that may be thrown away** if cost is unexpectedly high.

### Phase 0 — Spike (throwaway, no merge)

Pick the worst offender: `verify/state-3a-design-agents.md` (583 lines).
On a throwaway branch:

1. Author the state-registry entries for `3a.1`, `3a.2`, ... (estimate
   8-12 sub-states)
2. Extract per-child prose into separate `.md` files
3. Extract inline bash blocks into reusable scripts
4. Don't yet implement the runner or hook changes — just see how the
   decomposition looks

**Measure**:
- Actual hours spent
- Number of resulting sub-states
- How natural the decomposition feels

**Decision gate**:
- If <8 hours and decomposition is clean → proceed to Phase 1
- If 8-16 hours → reconsider scope; maybe migrate only the worst 3 states
- If >16 hours or decomposition feels unnatural → **abandon proposal**,
  delete spike branch, write up the lesson

### Phase 1 — Infrastructure (only if spike succeeds)

One PR lands the supporting infrastructure (no state adopts yet):

- Relax Rule 13 to allow `<id>.<n>` (one line of CLAUDE.md)
- Extend `state-completion-gate.sh` to check `has_children`
  (~25 lines added)
- Add `state-runner.sh` (~200 lines, optional helper)
- Add the two coherence rules
- Add `.runs/state-runner-status.json` to the canonical-writer manifest
  (GRAIM v2 stamping)

Zero behavioral change — coherence rules fire only on states that opt
in, and none have yet.

**Auto-merge note**: this PR must skip auto-merge for human review.
Mechanism for this is itself a Phase 1 deliverable — the user reviews
the infra PR once. (Caveat 1 below: no such "skip auto-merge by label"
mechanism exists today; it must be designed and landed as part of
Phase 1.)

### Phase 2 — First adopter

A second PR converts `verify/state-3a` to the nested form (the polished
version of the Phase 0 spike). Observe for 2 weeks.

### Phase 3 — Expand by priority

If Phase 2 observation is positive, expand in order:
1. `verify/state-3b` (305 lines)
2. `audit/state-1-parallel-analysis.md` (350 lines)
3. `distribute/state-6-campaign.md` (854 lines — tests `kind:human`
   for Chrome MCP approval gates)

### Rollback

If Phase 2 shows no measurable reduction in step-omission incidents
over 8 weeks (or if a new failure class emerges that's worse than the
old one), **delete the infrastructure**. Hard commit: this is
preventative, not mandatory. The 4 changed files (Rule 13, hook,
registry schema, runner script) revert cleanly.

## 6. Falsifiable Claim

This proposal is preventative. To keep the team honest:

- **Prediction (H)**: In the 8 weeks after Phase 2 adoption of
  `verify/state-3a`, zero step-omission incidents in `3a`, AND ≥1
  step-omission incident in some long unadopted state (i.e., the
  base rate is still positive).
- **Opposite prediction (¬H)**: Adopted state shows same or higher
  incident rate than unadopted long states.
- **Observable signal**: GitHub issues tagged with the
  `step-omission` label + `.runs/fix-ledger.jsonl` entries citing
  missing-step root causes.
- **Strength**: Low. Base rate is ~2 step-omission incidents per year;
  8 weeks is a small sample. If signal is ambiguous, extend
  observation to 16 weeks before deciding.

If both the adopted and unadopted states show zero incidents during
the observation period, the proposal is **unvalidated** — not
falsified, but also not supported. Default action in that case:
freeze further adoption, keep Phase 2 state as-is, revisit if a new
incident occurs.

## 7. Known Caveats

These remain unresolved from the `/solve` critic and need to be
addressed during implementation:

1. **No "skip auto-merge" mechanism today.** Phase 1 infra PR needs
   human review, but `lifecycle-finalize.sh` has no label-aware skip.
   Must be designed (small new hook) as part of Phase 1.
2. **LLM Read is not blocked.** The "LLM cannot read ahead" property
   relies on (a) child prose lives in separate small files and
   (b) the runner only writes one child to the status JSON. An LLM
   that speculatively `Read`s `state-registry.json` to peek at future
   children is not prevented. The gate (3.3) is the actual enforcement;
   one-step-at-a-time prose delivery is a defense-in-depth convenience,
   not a hard guarantee.
3. **`kind:script` idempotency is by convention.** Crash recovery
   re-runs scripts; if a script appends instead of overwriting,
   re-running double-appends. Mitigation: each `kind:script` exec
   must declare `# IDEMPOTENT: <yes|guarded|no>` in its header, and
   if `no`, the registry entry must set `on_fail: halt`. Enforced by
   a third coherence rule (not yet drafted).
4. **`kind:human` postcondition format** (user approval flag file
   naming, expiry semantics) is unspecified. Needs design before
   Phase 3 adopts `distribute/state-6`.
5. **Per-step hook fast-path**: the extended `state-completion-gate.sh`
   must short-circuit on irrelevant Bash calls (e.g., `ls`, `git
   status`) to avoid per-call overhead. Pattern: match
   `advance-state.sh` at command-head position only, like #1223.
6. **Two-level nesting cap is a hard constraint** in this proposal.
   If a future state genuinely needs three levels, this proposal
   reopens for revision rather than silently allowing `3a.1.1`.

## 8. Scope: What This Does Not Fix

This proposal targets **one specific failure class**: LLM skipping an
internal step inside a long state. It does not address:

- Cross-state dataflow bugs (issue #1143 — fixed separately)
- Gate-bypass via shell write (#1182 — fixed by EARC)
- Agent-trace schema coherence (#1257 — fixed by AOC v1.3)
- Chain-vs-sequential VERIFY semantics (#1339 — fixed by
  `defer_verify_when_writer`)
- Silent hook fail-open (#1349 — fixed by friction-log + manifest)

Right-sizing matters. The first-principles win is **one concept that
covers state-omission**, not a grand-unified theory that covers
everything.

## 9. Decision Owner

User (template maintainer). Implementation skill: `/change`.

Next concrete step: run `/change` with input "execute Phase 0 spike of
docs/skill-execution-reliability-design.md".

---

*Generated from `/solve` analysis 2026-05-18; refined via single-concept
first-principles follow-up. See `.runs/solve-trace.json` and
`.runs/agent-traces/solve-critic.json` (round 2) in the worktree
`solve-20260518-skill-orchestration` for the underlying reasoning chain
and adversarial-critic findings.*

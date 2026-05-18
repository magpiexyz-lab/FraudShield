# Skill Execution Reliability — Design Proposal

> **Status**: Proposal (not implemented). Refined through multiple rounds of
> first-principles analysis between 2026-05-18 sessions. Implementation
> owner: TBD. Implementation skill: `/change`.

---

## 0. Core Principle (One Sentence)

> **Every "completion" claim must be backed by a disk-verifiable postcondition.
> No postcondition, no state.**

The entire architecture is this one rule. Every sub-section below is just
an application of it.

---

## 1. Mental Model

```
LLM wants to advance ─▶ gate intercepts ─▶ run postcondition (bash) ─▶ allow / deny
                                                  ↑
                                          a fact on disk,
                                          not LLM self-report
```

**State machine** is the canonical CS pattern for "ordered work with
verification between steps." We use it. We don't invent a new concept.

---

## 2. The Problem This Solves

The mvp-template's lifecycle skills are state machines. State boundaries
are well-guarded:
- `state-completion-gate.sh` (PreToolUse hook) runs the VERIFY command
  from `state-registry.json` before allowing `advance-state.sh`.

But INSIDE each state, ACTIONS is pure prose. When states grow long
(e.g., `verify/state-3a-design-agents.md` at 583 lines with 4–8 agent
spawns; `distribute/state-6-campaign.md` at 854 lines with 11 substeps),
the LLM occasionally skips an internal step. The omission is invisible
until the end-of-state VERIFY (sometimes catches it, often doesn't), and
by then recovery is expensive.

Concrete evidence: issue #1076 (design-critic Pareto Step 5.5 silently
skipped) and its regression #1129. Each prior fix has tightened the
end-of-state VERIFY — patching the symptom of "the step that should have
run didn't" rather than the structural cause.

---

## 3. First-Principles Insight

There is **one** kind of object in skill execution:

> **A discrete unit of work, ordered, with a postcondition.**

We already call this a **state**. State machines are how computer
science has expressed this concept for fifty years. There is no need
for new vocabulary like "step", "unit", "node", "checkpoint".

All these things are states:
- A top-level state machine state (today's `state-3a`)
- A finer-grained internal step (which we'll just call another state)
- A subagent's invocation (a state where `kind=agent`)
- A critic review (a state where `kind=critic`)
- A human-approval gate (a state where `kind=human`)

Five mechanisms in the current codebase (AOC schema enforcement,
review-verdict-gate, postcondition trace-content checks, adversarial
critics, the proposed step-runner) are **five instances of one pattern**:
postcondition over self-report. We unify them under one concept.

---

## 4. The Proposed Design

### 4.1 Flat states with `kind` field — no nesting

Today's state IDs are flat peers (`0`, `1`, `2`, `2a`, `2b`, `3a`, `3b`,
...) even when they share a "phase" prefix. Empirical check of
`state-registry.json` confirms: every skill is structurally flat. The
existing chain check (`state-completion-gate.sh` requires all prior
states complete before advancing) **already enforces what a "parent
state's VERIFY" would enforce**, piece by piece.

**Therefore: no nesting, no `has_children`, no parent-VERIFY semantics.**
Finer granularity is just more peer states with a naming convention
like `3a-1`, `3a-2`, `3a-3`.

### 4.2 Add `kind` to state-registry.json entries

```json
{
  "verify": {
    "3a-1": {
      "kind": "script",
      "exec": ".claude/scripts/preflight-design-claims.sh",
      "postcondition": "test -f .runs/design-claims.json && jq -e '.claims | length > 0' .runs/design-claims.json",
      "on_fail": "halt"
    },
    "3a-2": {
      "kind": "agent",
      "prose": ".claude/skills/verify/state-3a-2-spawn-critics.md",
      "spawn": "design-critic",
      "postcondition": "test -f .runs/agent-traces/design-critic.json && jq -e '.candidates_tried > 0' .runs/agent-traces/design-critic.json",
      "on_fail": {"kind": "retry", "max": 2, "then": "halt"}
    },
    "3a-3": {
      "kind": "script",
      "exec": ".claude/scripts/merge-design-critic-traces.sh",
      "postcondition": "test -f .runs/agent-traces/design-critic-merged.json"
    }
  }
}
```

Fields (all optional except `postcondition`):
- **`postcondition`** (required): bash one-liner, exit 0 = pass, non-zero = deny
- **`kind`**: `script` | `llm` | `agent` | `critic` | `human` (default `llm` for backward-compat with existing states)
- **`exec`** (for `kind=script`): script path
- **`prose`** (for `kind=llm` / `agent` / `critic` / `human`): prose file path
- **`spawn`** (for `kind=agent` / `critic`): agent name
- **`on_fail`**: `"halt"` (default) | `{"kind": "retry", "max": N, "then": "halt"}`

States without `kind` (i.e., all existing states) behave exactly as today.
**Fully backward-compatible.**

### 4.3 state-completion-gate.sh: zero changes required

The existing chain check + per-state VERIFY already does the work. Flat
peer states with finer granularity automatically benefit.

### 4.4 The 5 kinds — how each applies the one principle

| `kind` | Who executes | Postcondition typically checks |
|--------|------------|---------------------------|
| `script` | Runner runs `exec` directly, zero LLM | File output exists / command succeeded |
| `llm` | Lead reads `prose`, does work, calls advance-state | File the LLM should have produced exists with required content |
| `agent` | Lead spawns subagent via Agent tool | Subagent trace file exists with required fields/values |
| `critic` | Lead spawns critic agent, passes input artifact | Critic verdict JSON shows no blocking issues |
| `human` | Lead presents prose to user; user writes flag | Approval flag file exists |

**All five share the same gate, same registry, same advance script.**
Different `kind` values are just hints to the (optional) runner; the
gate itself only cares about postconditions.

### 4.5 LLM context discipline

When a state has `prose` (kind=llm/agent/critic/human), the LLM reads
only that state's prose at execution time. Long-state-file context
bloat is solved structurally: each state's prose lives in its own file,
typically ≤100 lines. The LLM never reads "all 11 sub-step prose at
once."

### 4.6 state-runner.sh — optional convenience

A helper script that reads the registry and:
- For each state in order:
  - `kind=script`: runs `exec`, runs `postcondition`, calls `advance-state.sh`
  - `kind=llm/agent/human`: writes `.runs/state-runner-status.json`
    pointing to the next state's prose, exits, waits for LLM callback
  - `kind=critic`: similar, but with `input` artifact reference

**Optional**: states can also be advanced manually one by one. The
runner just reduces toil. Not required for the architecture to work.

---

## 5. Why This Replaces Five Existing Mechanisms

| Current mechanism | What it does | Becomes |
|---|---|---|
| AOC v1.3 schema enforcement | Required fields on agent traces | `kind=agent` state's postcondition checks the fields |
| review-verdict-gate.sh | Per-step verdicts in reviewer traces | Each per-step verdict is its own state with `kind=critic` |
| Postcondition trace-content checks | State VERIFY checks trace field values | Same — already the model |
| Adversarial critic agents | Spawn a 2nd agent to challenge | `kind=critic` states |
| (Proposed step-runner) | Finer granularity within a state | Just more peer states |

Conceptually, all five are the same. Practically, the existing
infrastructure can be unified into one mechanism over time — see §7.

---

## 6. Migration Plan

### Phase 0 — Spike (throwaway)

Pick the worst offender: `verify/state-3a-design-agents.md` (583 lines).
On a throwaway branch:

1. Split into peer states `3a-1`, `3a-2`, `3a-3`, ... (estimate 8–12)
2. Add `kind` + `exec`/`prose`/`spawn` + `postcondition` for each
3. Extract per-state prose into separate `.md` files
4. Extract inline bash blocks into reusable scripts under `.claude/scripts/`

**Measure**:
- Actual hours spent
- Number of resulting peer states
- How natural the decomposition feels

**Decision gate**:
- If <8 hours and decomposition is clean → proceed to Phase 1
- If 8–16 hours → migrate only the worst 3 states, reassess
- If >16 hours or decomposition feels unnatural → **abandon proposal**

### Phase 1 — First adopter (only if spike succeeds)

One PR converts `verify/state-3a` to the flat-peer form. Auto-merge must
be skipped for this PR — manual review required for the first
adoption. (Mechanism: PR label `requires-human-review` recognized by a
new check in `lifecycle-finalize.sh`. **This hook is itself a Phase 1
deliverable** — it does not exist today.)

### Phase 2 — Observe (2 weeks)

Watch for step-omission incidents. Compare to base rate (~2/year). If
clearly improved or zero incidents in the adopted state, proceed.

### Phase 3 — Expand by priority

1. `verify/state-3b` (305 lines)
2. `audit/state-1-parallel-analysis.md` (350 lines)
3. `distribute/state-6-campaign.md` (854 lines — tests `kind=human`
   for Chrome MCP approval gates)
4. Other states with line count >150

### Rollback

If Phase 2 shows no measurable reduction in step-omission incidents
over 8 weeks, delete the new `kind`/`exec`/`spawn` fields from
state-registry.json entries (existing states without these fields are
unaffected). No code reverts needed.

---

## 7. Long-Term: Code-Level Convergence (Optional)

The five existing mechanisms can be unified into one over time. This
is not blocking the proposal above — it's a follow-up cleanup.

Today's surface area:
- `state-registry.json` + `state-completion-gate.sh` + `advance-state.sh`
- `agent-output-contract.md` + `agent-trace-write-gate.sh`
- `run-review-verdict-gate.py` + per-step-review schema
- Multiple critic agent definitions
- (Proposed) state-runner mechanics

Unified surface area (target):
- `state-registry.json` (extended with `kind` field)
- `state-completion-gate.sh` (no changes needed)
- `advance-state.sh` (no changes needed)
- `state-runner.sh` (new, optional helper)

The other mechanisms gradually re-express their checks as state
postconditions in the unified registry. Net: ~600 lines of mechanism
code → ~200 lines.

This is opportunistic, not urgent. Each individual `/change` that
touches a mechanism can migrate that mechanism's checks into the
registry.

---

## 8. Falsifiable Claim

This proposal is preventative. To keep the team honest:

- **Prediction (H)**: In the 8 weeks after Phase 2 adoption of
  `verify/state-3a`, zero step-omission incidents in `3a-*`, AND ≥1
  step-omission incident in some long unadopted state (i.e., base rate
  remains positive).
- **Opposite prediction (¬H)**: Adopted state shows same or higher
  incident rate than unadopted long states.
- **Observable signal**: GitHub issues tagged with `step-omission` +
  `.runs/fix-ledger.jsonl` entries citing missing-step root causes.
- **Strength**: Low. Base rate ~2 step-omission incidents per year;
  8 weeks is small. If signal is ambiguous, extend observation to 16
  weeks before deciding.

If both adopted and unadopted states show zero incidents during the
period, treat as **unvalidated** (not falsified, not supported).
Default: freeze further adoption, revisit on next incident.

---

## 9. Known Caveats

1. **"Skip auto-merge" mechanism does not exist today.** Phase 1 needs
   human review on the first adopter PR. Designing a label-aware skip
   in `lifecycle-finalize.sh` is itself a Phase 1 deliverable.
2. **LLM Read is not blocked.** "LLM cannot read ahead" relies on
   per-state prose files being separate and the runner only pointing
   at one at a time. An LLM that speculatively reads the registry to
   peek at future postconditions is not prevented. The gate is the
   actual enforcement; one-at-a-time prose delivery is convenience.
3. **`kind=script` idempotency is by convention.** Crash recovery
   re-runs scripts. Each `exec` should declare in its header
   `# IDEMPOTENT: yes|guarded|no`; `no` requires `on_fail: halt` in
   the state entry. Enforced by an optional coherence rule.
4. **`kind=human` postcondition format** (approval flag file naming,
   expiry) is unspecified. Define before Phase 3 adopts
   `distribute/state-6`.
5. **No depth nesting allowed.** This proposal explicitly rejects
   parent/child states. If a future need actually requires it, this
   proposal is revisited rather than silently extended.

---

## 10. Scope: What This Does Not Fix

Targets one failure class only: LLM skipping an internal step inside
a long state.

Not in scope:
- Cross-state dataflow bugs (#1143 — fixed separately)
- Gate-bypass via shell write (#1182 — fixed by EARC)
- Agent-trace schema coherence (#1257 — fixed by AOC v1.3)
- Chain-vs-sequential VERIFY semantics (#1339 — fixed by `defer_verify_when_writer`)
- Silent hook fail-open (#1349 — fixed by friction-log + manifest)

Right-sizing matters. One concept that covers step-omission, not a
grand-unified theory.

---

## 11. Portability — Copying This Architecture to Other Repos

The architecture is project-agnostic. Required for any Claude Code
project:

### Minimal files (<200 lines total)

1. **`.claude/state-registry.json`** — all states with postconditions
2. **`.claude/hooks/state-completion-gate.sh`** — ~50 lines, PreToolUse
   on Bash; intercepts `advance-state.sh`, runs postcondition, denies
   on fail
3. **`.claude/scripts/advance-state.sh`** — ~15 lines, idempotent
   append to `completed_states`
4. **`.claude/settings.json`** — register the hook on PreToolUse.Bash
5. **`.runs/<skill>-context.json`** — created by an init script;
   tracks `completed_states`

### One mental model

> Every completion claim must be backed by a disk-verifiable
> postcondition. If bash can verify it, write bash. If bash cannot
> (subjective quality, design judgment), spawn a critic — but the
> critic's output JSON is then verified by bash.

### Anti-patterns (don't do)

- Let LLM directly write `completed_states` — bypasses the gate
- Write postconditions that say "LLM self-reports done" — no enforcement
- Add a PostToolUse hook — unnecessary, advance-state.sh is the single entry
- Nest states with `has_children` — flat + naming convention suffices
- Put 11 sub-steps of prose in one state — split into 11 peer states
- Add more than ~5 fields per state entry — over-engineering
- Put complex logic in the hook — hook only runs postcondition; orchestration goes in `state-runner.sh` or `advance-state.sh`

---

## 12. Decision Owner

User (template maintainer). Implementation skill: `/change`.

Next concrete step: run `/change` with input
"execute Phase 0 spike of docs/skill-execution-reliability-design.md".

---

*Output of `/solve` 2026-05-18 + first-principles refinement. The
key insight (one concept, not five) emerged through adversarial
questioning that collapsed an earlier two-concept design and a later
nested-state design into this single-concept flat-state proposal.*

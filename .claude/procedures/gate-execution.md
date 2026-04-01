# Gate Execution Procedure

> Verdict file lifecycle for quality gates enforced by hooks.

## Lifecycle

1. **Spawn gate-keeper.** The lead spawns a `gate-keeper` agent with the gate ID
   and a checklist of items to verify.

2. **Gate-keeper writes verdict.** The agent evaluates each check item and writes
   a verdict file to `.runs/gate-verdicts/<gate-id>.json`.

3. **Hooks read and enforce.** Pre-tool-use hooks (`bootstrap-commit-gate.sh`,
   `agent-state-gate.sh`, `verify-pr-gate.sh`) read verdict files and block
   actions when verdicts are missing or not PASS.

## Verdict File Schema

```json
{
  "verdict": "PASS",
  "timestamp": "2026-03-24T12:00:00Z",
  "branch": "feat/bootstrap",
  "details": "All 5 checks passed."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `verdict` | `"PASS"` or `"BLOCK"` | Gate outcome |
| `timestamp` | ISO 8601 UTC | When the verdict was issued |
| `branch` | string | Git branch the verdict applies to |
| `details` | string | Human-readable summary |

## Freshness Checks

Hooks enforce two freshness constraints:

1. **Timestamp freshness:** Verdict `timestamp` must be >= branch creation time.
   Stale verdicts from prior branches are rejected.

2. **Branch match:** Verdict `branch` must equal the current branch.
   Prevents reusing verdicts across branches.

## Gate IDs

| Gate | Skill | Purpose |
|------|-------|---------|
| `bg1` | bootstrap | Validation gate (experiment.yaml + stack resolution) |
| `bg2` | bootstrap | Orchestration gate (Phase A completeness) |
| `bg2.5` | bootstrap | Externals gate (external dependencies classified) |
| `bg4` | bootstrap | PR gate (full bootstrap checklist) |
| `g3` | change | Specs gate (spec updates validated) |
| `g4` | change | Implementation gate (all tasks complete) |
| `g5` | change | Verification gate (verify report exists) |
| `g6` | change | PR gate (final checks) |
| `phase-a-sentinel` | bootstrap | Phase A completion marker |

## Directory

All verdict files live in `.runs/gate-verdicts/`. This directory is cleaned
at the start of each skill run (e.g., bootstrap STATE 0 runs
`rm -rf .runs/gate-verdicts`).

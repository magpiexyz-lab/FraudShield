# Context Initialization

Shared procedure for creating a skill's `.runs/<skill>-context.json` file at STATE 0.

## Base Schema (required fields)

| Field | Type | Value |
|-------|------|-------|
| `skill` | string | Skill name (e.g., `"solve"`, `"change"`) |
| `branch` | string | `$(git branch --show-current)` |
| `timestamp` | string | ISO 8601 UTC: `$(date -u +%Y-%m-%dT%H:%M:%SZ)` |
| `run_id` | string | `<skill>-<timestamp>` (e.g., `"solve-2026-04-08T03:30:56Z"`) |
| `completed_states` | array | `[0]` |

All five fields are consumed by infrastructure (`advance-state.sh`, `lib-state.sh`, `state-completion-gate.sh`, `verify-pr-gate.sh`, `agent-gate-check.py`).

## Script Interface

```bash
bash .claude/scripts/init-context.sh <skill> [extra_json]
```

- `$1` — skill name (required). Exit 1 if missing.
- `$2` — extra JSON fields (optional). Merged into base via `dict.update`.
- Output: `.runs/$1-context.json`
- When `$2` is empty: pure bash heredoc (no python3 dependency).
- When `$2` has content: python3 merges base + extra.
- **State-reset guard**: refuses to overwrite if existing context has `completed_states` beyond `[0]`.

## Extra Fields by Skill

| Skill | Extra fields |
|-------|-------------|
| change | `preliminary_type`, `affected_areas`, `solve_depth` (all null) |
| deploy | `deploy_mode` ("initial"), `added_services`, `removed_services`, `unchanged_services` (all []) |
| distribute | `phase` (integer: 1 or 2) |
| resolve | `issue_list` ([]) |
| upgrade | `dry_run` (false) |

## Excluded Skills

| Skill | Reason |
|-------|--------|
| verify | 5 unique extra fields, `run_id` format omits skill prefix, values computed from multi-step logic within STATE 0 |
| iterate-check (c0) | Quoted heredoc (`<< 'CTXEOF'`) prevents shell expansion; 8 ads-specific placeholder fields |
| iterate-cross (x0) | Python3 inline creation with dynamic `mvps` list; `completed_states` uses string `["x0"]` not integer `[0]` |

These skills retain inline context creation in their STATE 0 files.

## Relationship to advance-state.sh

`init-context.sh` **creates** the context file at STATE 0. `advance-state.sh` **appends** to `completed_states` after each state's postconditions pass. Together they form the lifecycle: init → advance → advance → ... → completed.

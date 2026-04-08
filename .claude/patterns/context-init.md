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
- When `$2` starts with `@`: read extra JSON from the referenced file path (e.g., `@.runs/_extra.json`). Avoids shell quoting issues for values with special characters.
- **State-reset guard**: refuses to overwrite if existing context has multiple `completed_states` (length > 1, i.e., skill already in progress).

## Extra Fields by Skill

| Skill | Extra fields |
|-------|-------------|
| change | `preliminary_type`, `affected_areas`, `solve_depth` (all null) |
| deploy | `deploy_mode` ("initial"), `added_services`, `removed_services`, `unchanged_services` (all []) |
| distribute | `phase` (integer: 1 or 2) |
| resolve | `issue_list` ([]) |
| upgrade | `dry_run` (false) |
| verify | `skill` (overrides base — set to calling skill e.g. "bootstrap"), `scope`, `archetype`, `quality` ("production"), `mode`, `baseline_available` |
| iterate-check | `mode` ("check"), `channel`, `campaign_name`, `campaign_id`, `campaign_age_days`, `budget_total_cents`, `budget_daily_cents`, `max_cpc_cents`, `completed_states` (["c0"]) |
| iterate-cross | `mode` ("cross"), `mvp_count`, `mvps` (array), `completed_states` (["x0"]) — uses @file mechanism |

## Relationship to advance-state.sh

`init-context.sh` **creates** the context file at STATE 0. `advance-state.sh` **appends** to `completed_states` after each state's postconditions pass. Together they form the lifecycle: init → advance → advance → ... → completed.

<!-- DIRECTIVES:batch_search,pr_changed_first,context_digest,pre_existing -->

## Efficiency Directives
1. **Batch searches**: Use Grep with glob patterns (e.g., `glob: "src/**/*.tsx"`) instead of reading files one by one.
2. **PR-changed files first**: Check files from `git diff --name-only $(git merge-base HEAD main)...HEAD` before scanning the full source tree.
3. **Context digest**: [Provided above — pages, behavior IDs, event names, golden_path steps from experiment.yaml]
4. **Pre-existing changes**: Edit-capable agents should ignore pre-existing uncommitted changes outside the PR file boundary.

## Trace Requirements
1. **First action**: Your absolute first tool call must initialize your trace: `python3 scripts/init-trace.py <agent-name>`. This registers your presence so the orchestrator can detect incomplete work if you exhaust turns.
2. **Verdict vocabulary**: Write your `verdict` field using the exact casing from `.claude/patterns/agent-trace-protocol.md` (Verdict Values table). Casing is normative.
3. **Completion trace**: After all work, write your final trace to `.runs/agent-traces/<agent-name>.json` with at minimum: `agent`, `timestamp`, `verdict`, `checks_performed`, `run_id`.

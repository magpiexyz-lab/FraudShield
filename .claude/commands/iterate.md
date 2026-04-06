---
description: "Use when you have analytics data and want to decide what to do next. Analysis only — no code changes."
type: analysis-only
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - experiment/ads.yaml
stack_categories: [analytics]
requires_approval: false
references: []
branch_prefix: chore
modifies_specs: false
---
Review the experiment's progress and recommend what to do next.

## Argument Dispatch

Parse `$ARGUMENTS` for mode flags:

| Flag | Mode | Description |
|------|------|-------------|
| _(empty)_ | default | Funnel analysis (states 0-5) |
| `--check` | check | Ads campaign health check via Chrome MCP (states c0-c3) |
| `--cross` | cross | Cross-MVP Traction Score ranking via Chrome MCP + PostHog (states x0-x5) |

**If `$ARGUMENTS` contains `--cross`**, use the Cross Mode dispatch table below.

### Cross Mode JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| x0 | DISCOVER_MVPS | Plan | [state-x0-discover-mvps.md](../patterns/iterate/state-x0-discover-mvps.md) |
| x1 | GATHER_ALL_DATA | Plan | [state-x1-gather-all-data.md](../patterns/iterate/state-x1-gather-all-data.md) |
| x2 | MIGRATE_EVENTS | Plan | [state-x2-migrate-events.md](../patterns/iterate/state-x2-migrate-events.md) |
| x3 | COMPUTE_SCORES | Plan | [state-x3-compute-scores.md](../patterns/iterate/state-x3-compute-scores.md) |
| x4 | RANK_AND_RECOMMEND | Implement | [state-x4-rank-recommend.md](../patterns/iterate/state-x4-rank-recommend.md) |
| x5 | SKILL_EPILOGUE | Implement | [state-x5-skill-epilogue.md](../patterns/iterate/state-x5-skill-epilogue.md) |

Begin at STATE x0. Read [state-x0-discover-mvps.md](../patterns/iterate/state-x0-discover-mvps.md) now.

**STOP here -- do not continue to the check mode or default dispatch tables below.**

---

**If `$ARGUMENTS` contains `--check`**, use the Check Mode dispatch table below.

### Check Mode JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| c0 | READ_ADS_CONTEXT | Plan | [state-c0-read-ads-context.md](../patterns/iterate/state-c0-read-ads-context.md) |
| c1 | CHECK_HEALTH | Plan | [state-c1-check-health.md](../patterns/iterate/state-c1-check-health.md) |
| c2 | AUTO_FIX | Implement | [state-c2-auto-fix.md](../patterns/iterate/state-c2-auto-fix.md) |
| c3 | REPORT | Implement | [state-c3-report.md](../patterns/iterate/state-c3-report.md) |

Begin at STATE c0. Read [state-c0-read-ads-context.md](../patterns/iterate/state-c0-read-ads-context.md) now.

**STOP here -- do not continue to the default dispatch table below.**

---

**If `$ARGUMENTS` does NOT contain `--check` or `--cross`**, proceed with the default funnel analysis below.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | READ_CONTEXT | Plan | [state-0-read-context.md](../patterns/iterate/state-0-read-context.md) |
| 1 | GATHER_DATA | Plan | [state-1-gather-data.md](../patterns/iterate/state-1-gather-data.md) |
| 2 | COMPUTE_VERDICTS | Plan | [state-2-compute-verdicts.md](../patterns/iterate/state-2-compute-verdicts.md) |
| 3 | DECISION | Plan | [state-3-decision.md](../patterns/iterate/state-3-decision.md) |
| 4 | OUTPUT | Implement | [state-4-output.md](../patterns/iterate/state-4-output.md) |
| 5 | SKILL_EPILOGUE | Implement | [state-5-skill-epilogue.md](../patterns/iterate/state-5-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-read-context.md](../patterns/iterate/state-0-read-context.md) now.

## Do NOT
- Write code or modify source files — this skill is analysis only
- Recommend more than 3 actions — focus is more valuable than breadth
- Recommend actions outside the defined commands (bootstrap, change, iterate, retro, distribute, verify)
- Be vague — every recommendation must be specific enough to act on
- Ignore the data — don't recommend features if the funnel shows a landing page problem
- Recommend adding features when the real problem is distribution or positioning

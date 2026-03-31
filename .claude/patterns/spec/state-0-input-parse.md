# STATE 0: INPUT_PARSE

**PRECONDITIONS:**
- Git repository exists in working directory

**ACTIONS:**

Parse `$ARGUMENTS` for:
- **Idea text**: the main argument (everything except flags)
- **Level flag**: `--level 1`, `--level 2`, or `--level 3` (default: `1`)

Level definitions:
- **Level 1 — Landing test**: static page, analytics, no database or auth. Tests demand signals.
- **Level 2 — Interactive MVP**: Level 1 + database + core feature. Tests activation and retention.
- **Level 3 — Full MVP**: Level 2 + auth + payments (if applicable). Tests monetization.

### Fallback
If `$ARGUMENTS` is empty or contains only a level flag:
- Check if `experiment/experiment.yaml` exists and has non-TODO `thesis` and `description` fields.
  If so, extract the idea text from those fields and confirm with the user:
  > Found existing thesis/description in experiment.yaml. Using this as the idea input:
  > "[extracted text]"
  > Proceed? (yes/no)
- If experiment.yaml doesn't exist or fields are still TODO: stop with:
  > **Usage:** `/spec <idea description> [--level 1|2|3]`
  >
  > Example: `/spec Freelancers waste hours on invoicing. A tool that generates invoices from time logs. --level 2`
  >
  > Provide at least a sentence describing the problem and proposed solution.

### Guards
- If the idea text (excluding flags) is fewer than 20 characters: stop with:
  > That's too brief. Describe the problem and solution in at least a sentence so I can generate meaningful hypotheses.
- If the level is not 1, 2, or 3: stop with:
  > Invalid level. Use `--level 1` (landing test), `--level 2` (interactive MVP), or `--level 3` (full MVP).

### Input Sufficiency Check

After confirming the idea text and level, assess 3 information dimensions in the parsed input:

| Dimension | What to look for | Example (sufficient) |
|-----------|-----------------|---------------------|
| **Target user** | A describable person, not just "people" or "users" | "freelancers billing <5 clients/month" |
| **Problem** | A stated pain with some specificity | "wastes 2-3 hours/week on manual invoicing" |
| **Solution shape** | A proposed mechanism, not just a category | "single-page tool that generates invoices from time logs" |

For each dimension, classify as:
- **present** — explicitly stated in the input
- **inferable** — can be reasonably derived (mark as assumption)
- **missing** — cannot be determined

#### Decision logic

- **All 3 present/inferable** -> show assumptions inline with the Confirm (zero added latency), proceed to Step 2
- **1 missing** -> ONE follow-up message asking exactly what's missing, with `proceed` escape hatch
- **2-3 missing** -> input too vague, ask user to elaborate (no escape hatch)

#### Rules
- Maximum ONE round of follow-up — never enter a Q&A loop
- Inference-first — if you can reasonably infer, don't ask
- Show inferences — let user confirm or correct
- Merge follow-up answers with original input, then continue to Step 2 (no re-check)
- `proceed` escape hatch — user can skip and let AI infer everything

### Confirm
Display the parsed input and confirm before proceeding:
> **Idea:** [parsed idea text]
> **Level:** [1/2/3] — [level name]
>
> Understanding:
> [present/inferable/missing status for each dimension]
>
> Proceed with this? (yes / change level / rephrase)

Wait for user confirmation.

Clean stale epilogue artifacts and create context file to initialize state tracking:
```bash
rm -f .claude/runs/observe-result.json
cat > .claude/runs/spec-context.json << CTXEOF
{"skill":"spec","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"spec-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0]}
CTXEOF
```

**POSTCONDITIONS:**
- Idea text parsed (>= 20 characters)
- Level parsed (1, 2, or 3)
- Input sufficiency assessed (all 3 dimensions present/inferable, or follow-up completed)
- User confirmed input
- `.claude/runs/spec-context.json` exists

**VERIFY:**
```bash
test -f .claude/runs/spec-context.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh spec 0
```

**NEXT:** Read [state-1-research.md](state-1-research.md) to continue.

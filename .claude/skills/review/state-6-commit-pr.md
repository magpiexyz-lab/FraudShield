# STATE 6: COMMIT_PR

**PRECONDITIONS:**
- Skill epilogue complete (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

### Q-score

Compute review execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/review-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
REVIEW_DIMS=$(python3 -c "
import json
try:
    r = json.load(open('.runs/review-complete.json'))
    fixed = r.get('findings_fixed', 0)
    disputed = r.get('findings_disputed', 0)
    q_yield = round(fixed / max(fixed + disputed, 1), 3)
    print(json.dumps({'yield': q_yield, 'completion': 1.0}))
except:
    print(json.dumps({'completion': 1.0}))
" 2>/dev/null || echo '{"completion": 1.0}')
python3 .claude/scripts/write-q-score.py \
  --skill review --scope review --archetype N/A \
  --gate 1.0 --dims "$REVIEW_DIMS" \
  --run-id "$RUN_ID" || true
```

If no branch exists (no findings across all iterations):
  Report "Review clean — no findings" and stop.

If branch exists with changes:

- Commit all accumulated changes with a descriptive message
- Push and open PR using `.github/PULL_REQUEST_TEMPLATE.md`:
  - **Summary**: "Automated review-fix: N findings fixed across M iterations"
  - **How to Test**: "Run `make validate` + all 3 validator scripts"
  - **What Changed**: list every file and what changed
  - **Why**: "Template quality — fixes found by 3-dimension LLM review"
- Include in PR body: review summary, fixed findings, skipped/reverted
  findings, new checks added, remaining unfixable findings
- **Disputed findings section**: Under a `### Disputed Findings` heading,
  list all disputed findings across all iterations with adversarial rationale.
  Format as a table: Finding | Dimension | Rationale. Omit section if none.
- **Finding Fate Log section**: Under a `### Finding Fate Log` heading, include
  a table of ALL findings across all iterations:

  | Finding | Dimension | Adversarial Label | Fate | Notes |
  |---------|-----------|------------------|------|-------|

  Fate values: `fixed`, `reverted`, `disputed`, `skipped`.

- **Precision Summary section**: Under a `### Precision Summary` heading, include:
  - Per-dimension precision: (fixed) / (confirmed + needs-evidence) for A, B, C
  - Per-label accuracy: fraction of "confirmed" that were fixed and kept
  - Overall yield: total fixed / total reported across all iterations
- **Close resolved observations**: For each observation issue whose root cause
  was fixed in this review PR, close it with a comment:
  ```bash
  gh issue close <number> --comment "Fixed in review PR #<pr-number>"
  ```

### Auto-merge

If no branch exists (no findings across all iterations): skip auto-merge —
there is no PR.

If branch and PR exist: follow `.claude/patterns/auto-merge.md`. The PR number
is from the `gh pr create` output above.

If any safety gate fails, report the failure and leave the PR open.

If auto-merge succeeded: "Review PR auto-merged to main. N findings fixed, M observation issues closed."
If auto-merge skipped: "Review PR created but not auto-merged (<reason>). Merge manually."

**POSTCONDITIONS:**
- All changes committed
- PR created with full review summary (or no PR if no findings)
- Resolved observation issues closed
- Auto-merge completed (or intentionally skipped / no PR case)

**VERIFY:**
```bash
python3 -c "import json; rc=json.load(open('.runs/review-complete.json')); assert rc.get('timestamp'), 'review-complete timestamp empty'; assert isinstance(rc.get('findings_fixed'), int) and rc['findings_fixed']>=0, 'findings_fixed invalid'; ob=json.load(open('.runs/observe-result.json')); assert ob.get('skill')=='review', 'observe skill != review'; assert ob.get('verdict') in ('clean','filed','no-template-issues','incomplete'), 'observe verdict invalid'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh review 6
```

**NEXT:** TERMINAL — review complete, PR auto-merged (or left open with reason / no changes).

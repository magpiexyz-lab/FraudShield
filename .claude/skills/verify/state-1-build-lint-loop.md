# STATE 1: BUILD_LINT_LOOP

**PRECONDITIONS:** STATE 0 complete (verify-context.json, fix-log.md, agent-traces/ exist).

> **Budget rationale:** 3 attempts allows iterative refinement with error feedback.
> Attempt 1 catches the obvious error. Attempt 2 catches cascading effects.
> Attempt 3 is the safety net. All skills use this budget for consistency.

**ACTIONS:**

You have a budget of **3 attempts** to get a clean build and lint. Track each failed
attempt so you can reference previous errors and avoid repeating them.

For each attempt:

1. Run `npm run build`
2. If build fails: note the errors (mentally log: "Attempt N — build: [error summary]").
   Fix the errors. Append each fix to `.runs/fix-log.md`:
   ```
   **Fix N:** `<file>` — Symptom: `<what broke>` — Cause: `<why>` — Fix: `<what you changed>`
   ```
   Then start the next attempt.
3. If build passes: run `npm run lint` (skip if no lint script exists).
   Warnings are OK; errors are not.
4. If lint fails: note the errors (mentally log: "Attempt N — lint: [error summary]").
   Fix the errors. Append each fix to `.runs/fix-log.md`. Then start the next attempt.
5. If both pass: build and lint verification passed. Continue to STATE 2 — do NOT skip the remaining verification steps.
6. **Prove it.** Quote the last 3–5 lines of the build output **verbatim in a code block**. State facts: "Build completed with 0 errors. Lint passed with 0 warnings." Never say "should work", "probably passes", or "seems fine." The verify-report-gate hook checks for this.
7. **Record the result.** Write `.runs/build-result.json` to persist the build outcome for hook validation:
   ```bash
   RUN_ID=$(python3 -c "import json;print(json.load(open('.runs/verify-context.json')).get('run_id',''))" 2>/dev/null || echo "")
   echo '{"exit_code":0,"timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","run_id":"'"$RUN_ID"'"}' > .runs/build-result.json
   ```

**If all 3 attempts fail**, stop and report to the user:

> **Build verification failed after 3 attempts.** Here's what I tried:
>
> - Attempt 1: [what failed and what I changed]
> - Attempt 2: [what failed and what I changed]
> - Attempt 3: [what still fails]
>
> **Diagnosis:**
> - **Category:** [template bug | stack incompatibility | env/config issue | code logic error]
>   - *template bug:* error references generated files from /bootstrap or template patterns
>   - *stack incompatibility:* error involves version conflicts, missing peer dependencies, or framework API changes
>   - *env/config issue:* error references missing env vars, wrong paths, or config files
>   - *code logic error:* error is in user-written code from /change implementation
> - **Evidence:** [which specific errors point to this category]
> - **Suggested next:** [/change "fix: ..." | /resolve #issue | check env vars | update stack version | ...]
>
> The remaining errors are: [paste current errors]
>
> **Your options:**
> 1. **Tell me what to try** — describe the fix and I'll implement it on this branch
> 2. **Save and investigate later** — run `git add -A && git commit -m "WIP: build not passing yet"`, then `git checkout main`. Your WIP is safe on the feature branch. Resume later with `git checkout <branch>` and tell me the remaining errors.
> 3. **Start fresh** — run `git add -A && git commit -m "WIP: discarding"`, then `git checkout main`, then `make clean`, then `/bootstrap`. **Warning:** `make clean` deletes all generated code — only committed code is preserved in git history.
> 4. **Debug on this branch later** — switch to this branch (`git checkout <branch>`) and describe the remaining build errors directly. Do not re-run `/bootstrap` or `/change` — those create new branches. Just tell Claude what errors remain and it will fix them here.

**Persist diagnostic context** for downstream skill handoff:
```bash
python3 -c "
import json, os
ctx_path = '.runs/verify-context.json'
if os.path.exists(ctx_path):
    ctx = json.load(open(ctx_path))
    ctx['diagnostic'] = {
        'category': '<template|stack|env|code>',
        'last_errors': '<summary of remaining errors>',
        'attempts': [
            {'error': '<attempt 1 error>', 'fix_tried': '<attempt 1 fix>'},
            {'error': '<attempt 2 error>', 'fix_tried': '<attempt 2 fix>'},
            {'error': '<attempt 3 error>', 'fix_tried': '<attempt 3 fix>'}
        ],
        'suggested_skill': '<change|resolve|manual>'
    }
    json.dump(ctx, open(ctx_path, 'w'))
"
```
This enables `/change "fix: ..."` to read diagnostic context from a prior failed verification run.

Do NOT commit code that fails build or lint. Do NOT skip this procedure.

**POSTCONDITIONS:** Build passes. Lint passes (or no lint script). `build-result.json` written with `exit_code: 0`.

**VERIFY:**
```bash
test -f .runs/build-result.json && python3 -c "import json; assert json.load(open('.runs/build-result.json'))['exit_code'] == 0"
```

> **Hook-enforced:** `skill-agent-gate.sh` validates `build-result.json` before allowing Phase 1 agents to spawn.

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 1
```

**NEXT:** Read [state-2-phase1-parallel.md](state-2-phase1-parallel.md) to continue.

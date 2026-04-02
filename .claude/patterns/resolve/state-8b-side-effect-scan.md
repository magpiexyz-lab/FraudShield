# STATE 8b: SIDE_EFFECT_SCAN

**PRECONDITIONS:**
- Final validation passed (STATE 8 POSTCONDITIONS met)

**ACTIONS:**

For issues closed as "cannot reproduce" in Step 3 or non-actionable
in Step 2: if any file modified in Steps 7-8 is cited in the issue,
comment: "This may have been addressed by the fix in PR #<number>
(for #<primary>). Verify and reopen if the issue persists."

For other open issues not in the current batch:
```bash
gh issue list --state open --limit 10 --json number,title,body
```
If any reference files modified in this PR: note under a
"### Potentially Resolved" section in the PR body (do NOT close —
the fix was not designed for them).

- **Write side-effects artifact** (`.runs/resolve-side-effects.json`):
  ```bash
  python3 -c "
  import json
  side_effects = {
      'comments_posted': [],
      'potentially_resolved': []
  }
  json.dump(side_effects, open('.runs/resolve-side-effects.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Side-effect comments posted on relevant closed issues
- Open issues referencing modified files identified for PR body
- `.runs/resolve-side-effects.json` exists

**VERIFY:**
```bash
test -f .runs/resolve-side-effects.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 8b
```

**NEXT:** Read [state-9-save-patterns.md](state-9-save-patterns.md) to continue.

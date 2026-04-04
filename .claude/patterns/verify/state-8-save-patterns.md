# STATE 8: SAVE_PATTERNS

**PRECONDITIONS:** STATE 7 complete.

If `.runs/fix-log.md` has only the header line and no entries, this state is a no-op — write `.runs/patterns-saved.json` with `{"saved":0,"skipped":0,"total":0,"saved_to_files":[],"saved_to_memory":0}` and return.

**ACTIONS:**

Read `.runs/fix-log.md` from disk. If it has only the header line and no entries, write
`{"saved":0,"skipped":0,"total":0,"saved_to_files":[],"saved_to_memory":0}` to
`.runs/patterns-saved.json` and skip to Done.

If the Fix Log has entries:

1. Spawn the `pattern-classifier` agent (`subagent_type: pattern-classifier`).
   Pass: fix-log.md content, list of stack files (`find .claude/stacks -type f`), project memory directory path.
   The pattern-classifier files universal patterns as GitHub issues to the template repo (when `.claude/template-meta.json` or a `template` git remote exists) instead of modifying local stack files. This ensures all projects benefit from universal patterns. When no template repo is available, it falls back to local stack file modification.

   **Anti-overfit constraint for pattern saving:**
   - Do NOT save patterns that are reactions to a single Q-score dip (correlation != causation)
   - Do NOT encode project-specific workarounds as universal rules
   - Do NOT save patterns that contradict existing stack file guidance
   - Only save patterns that would apply to multiple projects using the same stack combination
   - When in doubt, save to project auto-memory (not stack files)
2. Wait for completion.
3. Verify `.runs/patterns-saved.json` exists (the hook validates invariants automatically).

**POSTCONDITIONS:** `patterns-saved.json` exists. Pattern count matches fix log entry count.

**VERIFY:**
```bash
test -f .runs/patterns-saved.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 8
```

**NEXT:**
- If mode is **change-verify**: Done — return to /change for PR creation.
- If mode is **distribute-verify**: Done — return to /distribute for final PR creation.
- If mode is **standalone**: Done.
- If mode is **bootstrap-verify**: Create the bootstrap PR:
  1. Read `.runs/verify-report.md` frontmatter `overall_verdict`
  2. If `fail`: tell the user "Verification failed — fix issues and re-run `/verify`." Done.
  3. If `pass`: Create the PR using `gh pr create`. Fill in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`):
     - **Summary**: "Bootstrap MVP scaffold from experiment.yaml, verified by /verify."
     - **How to Test**: Read experiment.yaml `type` and surface configuration to generate archetype-appropriate guidance:
       - web-app: "After merging, run `/deploy` to deploy."
       - service with surface (co-located or detached): "After merging, run `/deploy` to deploy."
       - service with no surface (`surface: none`): "After merging, deploy your API to your hosting provider. Run `/iterate` when ready to analyze metrics."
       - cli with surface (detached): "After merging, run `/deploy` for the marketing surface, then `npm publish` to release the CLI package."
       - cli with no surface: "After merging, run `npm publish` to release the CLI package."
     - **What Changed**: List files from `git diff main --name-only`.
     - **Why**: "Initial MVP scaffold for experiment."
     - Include verify-report.md agent verdicts in the Verification checklist.
  4. Tell the user the PR URL.
  5. **Auto-merge**: Follow `.claude/patterns/auto-merge.md`. The PR number
     is from the `gh pr create` output in step 3. If any safety gate fails,
     report the failure and leave the PR open — tell the user to merge
     manually. If auto-merge succeeds, tell the user:
     "Bootstrap PR auto-merged to main." followed by the archetype-specific
     guidance from the How to Test section above. Done.

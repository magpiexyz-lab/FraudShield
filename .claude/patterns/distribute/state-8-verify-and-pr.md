# STATE 8: VERIFY_AND_PR

**PRECONDITIONS:**
- Implementation complete (STATE 7 POSTCONDITIONS met)

**ACTIONS:**

Before running verify.md, validate that distribute artifacts were created:

1. **ads.yaml**: verify `experiment/ads.yaml` exists (Glob). If missing, stop — "ads.yaml was not generated. Re-run Step 5."
2. **UTM capture**: Grep for `utm_source` in the landing page file. If no match, warn — "UTM capture may not be wired on the landing page (Step 7a)."
3. **Feedback widget**: if archetype is `web-app`, verify feedback widget component exists (Glob `src/components/*feedback*`). If archetype is `service`, verify feedback form exists in the surface file (Grep for `feedback` in the surface file — `site/index.html` for detached, root route handler for co-located). If archetype is `cli` (surface is always detached), verify feedback form in `site/index.html`. If missing, warn — "Feedback widget not found (Step 7c)."

If any check returns "stop", halt before verify.md. Warnings are non-blocking — proceed and include in PR body.

Before running verify.md, set skill attribution for Q-score tracking: when executing STATE 0 of verify.md, use `"distribute"` as the skill value (instead of the default `"verify"`). Since distribute does not use `current-plan.md`, pass the skill directly when creating verify-context.json.

Run the verification procedure per `.claude/patterns/verify.md`.

> **Gate check:** Read `.runs/verify-report.md`. If it does not exist,
> STOP — go back and run verify.md above. Do NOT commit without a verification report.

- You are already on a `chore/distribute-*` branch. Do not create another branch.
- Commit message: imperative mood describing the distribution setup (e.g., "Add Google Ads campaign config with UTM capture")
- Push and open PR using `.github/PULL_REQUEST_TEMPLATE.md` format:
  - **Summary**: what was generated and why (include the selected channel)
  - **Distribution Setup**: step-by-step channel + analytics setup instructions (from stack file)
  - **What Changed**: files modified (landing page UTM capture, experiment/EVENTS.yaml, ads.yaml, FeedbackWidget)
  - The full `ads.yaml` content in the PR body for easy review
- Fill in **every** section of the PR template. Empty sections are not acceptable. If a section does not apply, write "N/A" with a one-line reason.
- If `git push` or `gh pr create` fails: show the error and tell the user to check their GitHub authentication (`gh auth status`) and remote configuration (`git remote -v`), then retry.

**POSTCONDITIONS:**
- `experiment/ads.yaml` exists
- UTM capture verified (or warning noted)
- Feedback widget verified (or warning noted)
- verify.md completed and `.runs/verify-report.md` exists
- All changes committed and pushed
- PR opened with summary, distribution setup instructions, and full ads.yaml content

**VERIFY:**
```bash
test -f .runs/verify-report.md && echo "Verify report OK" || echo "FAIL: no verify report"
git log -1 --oneline && echo "Commit OK"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 8
```

**NEXT:** Read [state-9-campaign-creation.md](state-9-campaign-creation.md) to continue.

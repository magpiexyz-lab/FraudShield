# STATE 5: APPROVE_AND_SHIP

**PRECONDITIONS:**
- Campaign config generated (STATE 4 POSTCONDITIONS met)

**ACTIONS:**

### 5a: Present ads.yaml

Present the full `experiment/ads.yaml` content to the user.

### 5b: STOP for approval

**STOP.** End your response here. Say:
> Review the ads config above. Reply **approve** to proceed, or tell me what to change.
> After approval, I'll open a PR and then create the campaign in Google Ads.

**Do not proceed until the user approves.**

If the user requests changes instead of approving, revise the config to address their feedback and present it again (return to STATE 4 step 4d). Repeat until approved.

### 5c: Record approval

```bash
python3 -c "
import json
ctx = json.load(open('.runs/distribute-context.json'))
ctx['approved'] = True
json.dump(ctx, open('.runs/distribute-context.json', 'w'), indent=2)
"
```

### 5d: Create PR

- You are already on a `chore/distribute-*` branch. Do not create another branch.
- Push and open PR using `.github/PULL_REQUEST_TEMPLATE.md` format:
  - **Summary**: what was generated and why (include the selected channel)
  - **Distribution Setup**: step-by-step channel + analytics setup instructions (from State 3 working memory — the conversion sync and dashboard setup content)
  - **What Changed**: files modified (landing page UTM capture, experiment/EVENTS.yaml, ads.yaml, FeedbackWidget)
  - The full `ads.yaml` content in the PR body for easy review
- Fill in **every** section of the PR template. Empty sections are not acceptable. If a section does not apply, write "N/A" with a one-line reason.
- If `git push` or `gh pr create` fails: show the error and tell the user to check their GitHub authentication (`gh auth status`) and remote configuration (`git remote -v`), then retry.

### 5e: Push to remote

```bash
git push -u origin HEAD
```

**POSTCONDITIONS:**
- User has explicitly approved the ads config
- `approved` field set to `true` in `distribute-context.json`
- All changes pushed to remote
- PR opened with summary, distribution setup instructions, and full ads.yaml content

**VERIFY:**
```bash
python3 -c "import json; assert json.load(open('.runs/distribute-context.json')).get('approved') == True, 'approved not set'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 5
```

**NEXT:** Read [state-6-campaign.md](state-6-campaign.md) to continue.

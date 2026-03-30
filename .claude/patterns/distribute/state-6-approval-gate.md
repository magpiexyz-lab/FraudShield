# STATE 6: APPROVAL_GATE

**PRECONDITIONS:**
- ads.yaml generated and presented (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

**STOP.** End your response here. Say:
> Review the ads config above. Reply **approve** to proceed, or tell me what to change.
> After approval, I'll set up conversion tracking and open a PR.

**Do not proceed until the user approves.**

If the user requests changes instead of approving, revise the config to address their feedback and present it again (return to STATE 5). Repeat until approved.

- **Record approval** in `distribute-context.json`:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.claude/distribute-context.json'))
  ctx['approved'] = True
  json.dump(ctx, open('.claude/distribute-context.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- User has explicitly approved the ads config
- `approved` field set to `true` in `distribute-context.json`

**VERIFY:**
```bash
python3 -c "import json; assert json.load(open('.claude/distribute-context.json')).get('approved') == True, 'approved not set'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 6
```

**NEXT:** Read [state-7-implement.md](state-7-implement.md) to continue.

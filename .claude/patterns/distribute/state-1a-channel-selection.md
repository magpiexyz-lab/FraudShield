# STATE 1a: CHANNEL_SELECTION

**PRECONDITIONS:**
- File and deployment checks passed (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

> **Branch cleanup on failure:** Any "stop" in this step leaves you on a feature branch (created in Step 0). Include in the stop message: "To abort: `git checkout main && git branch -D chore/distribute`. To fix and retry: address the prerequisite, then re-run `/distribute`."

1. List available channels by scanning `.claude/stacks/distribution/*.md` (strip the `.md` extension to get channel names)
2. Ask: "Which distribution channel? Available: [channels]. Enter channel name:"
3. Read the selected channel's stack file at `.claude/stacks/distribution/<channel>.md`

**POSTCONDITIONS:**
- Channel selected and stack file read
- `.runs/distribute-preconditions.json` updated with `channel` field

Update the preconditions artifact:
```bash
python3 -c "
import json
p = json.load(open('.runs/distribute-preconditions.json'))
p['channel'] = '<selected channel>'
json.dump(p, open('.runs/distribute-preconditions.json', 'w'), indent=2)
"
```

**VERIFY:**
```bash
python3 -c "
import json; p=json.load(open('.runs/distribute-preconditions.json'))
assert p.get('channel'), 'no channel'
"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 1a
```

**NEXT:** Read [state-1b-policy-check.md](state-1b-policy-check.md) to continue.

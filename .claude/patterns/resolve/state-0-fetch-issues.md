# STATE 0: FETCH_ISSUES

**PRECONDITIONS:**
- Git repository exists in working directory
- GitHub CLI (`gh`) is authenticated

**ACTIONS:**

Determine which issues to resolve:

- If the user specified issue number(s): `gh issue view <N> --json number,title,body,labels,state,comments`
- If the user said "resolve open issues": `gh issue list --state open --limit 20 --json number,title,body,labels`
- If the user said "resolve observations": `gh issue list --label observation --state open --limit 20 --json number,title,body,labels`

Store the fetched issues as `issue_list`.

Clean stale epilogue artifacts and create context file to initialize state tracking:
```bash
rm -f .claude/observe-result.json
cat > .claude/resolve-context.json << CTXEOF
{"skill":"resolve","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"resolve-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0],"issue_list":[]}
CTXEOF
```

**POSTCONDITIONS:**
- `issue_list` is populated with at least one issue
- `.claude/resolve-context.json` exists

**VERIFY:**
```bash
test -f .claude/resolve-context.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 0
```

**NEXT:** Read [state-1-read-context.md](state-1-read-context.md) to continue.

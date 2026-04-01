# STATE 1: READ_CONTEXT

**PRECONDITIONS:**
- `issue_list` is populated (STATE 0 POSTCONDITIONS met)

**ACTIONS:**

- Read `CLAUDE.md`
- Read `scripts/check-inventory.md`
- For each issue in `issue_list`: read every template file mentioned in the issue body

- **Record files read** in `resolve-context.json`:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.runs/resolve-context.json'))
  ctx['files_read'] = ['CLAUDE.md', 'scripts/check-inventory.md']  # add all template files read
  json.dump(ctx, open('.runs/resolve-context.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- `CLAUDE.md` and `scripts/check-inventory.md` have been read
- All template files cited in issue bodies have been read
- Their contents are in context for subsequent states
- `files_read` field persisted to `resolve-context.json`

**VERIFY:**
```bash
python3 -c "import json; ctx=json.load(open('.runs/resolve-context.json')); assert isinstance(ctx.get('files_read'), list) and len(ctx['files_read']) > 0, 'files_read missing or empty'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 1
```

**NEXT:** Read [state-2-triage.md](state-2-triage.md) to continue.

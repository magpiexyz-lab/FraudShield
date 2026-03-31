# STATE 1_5: LOAD_HYPOTHESIS

**PRECONDITIONS:**
- Preconditions validated (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

If `.claude/runs/spec-manifest.json` exists, read it and extract:
- All hypotheses where `category` is `"demand"` or `"reach"` (the categories relevant to distribution)
- For each: `statement`, `metric.formula`, `metric.threshold`

Store as hypothesis context for Step 3. If the file does not exist, skip — all subsequent steps work without it.

- **Record hypothesis loading** in `distribute-context.json`:
  ```bash
  python3 -c "
  import json, os
  ctx = json.load(open('.claude/runs/distribute-context.json'))
  ctx['hypothesis_loaded'] = os.path.exists('.claude/runs/spec-manifest.json')
  json.dump(ctx, open('.claude/runs/distribute-context.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- If `.claude/runs/spec-manifest.json` exists: demand/reach hypotheses extracted and stored in context
- If `.claude/runs/spec-manifest.json` does not exist: skipped, no hypothesis context
- `hypothesis_loaded` field persisted to `distribute-context.json`

**VERIFY:**
```bash
python3 -c "import json; ctx=json.load(open('.claude/runs/distribute-context.json')); assert 'hypothesis_loaded' in ctx, 'hypothesis_loaded missing'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 1_5
```

**NEXT:** Read [state-2-research-targeting.md](state-2-research-targeting.md) to continue.

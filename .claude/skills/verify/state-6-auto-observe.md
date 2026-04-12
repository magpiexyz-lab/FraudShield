# STATE 6: AUTO_OBSERVE

**PRECONDITIONS:** STATE 5 complete (e2e-result.json exists).

**ACTIONS:**

Read `.runs/fix-log.md` from disk. If it has only the header line (`# Error Fix Log`) and no entries:

**Fallback: check agent traces for unreported fixes.**

```bash
python3 -c "
import json, os
traces = ['.runs/agent-traces/design-critic.json',
          '.runs/agent-traces/ux-journeyer.json',
          '.runs/agent-traces/security-fixer.json']
entries = []
for t in traces:
    if not os.path.exists(t): continue
    d = json.load(open(t))
    name = os.path.basename(t).replace('.json', '')
    for fix in d.get('fixes', []):
        f = fix.get('file', 'unknown')
        symptom = fix.get('symptom', fix.get('desc', 'no description'))
        action = fix.get('fix', fix.get('action', 'fixed'))
        entries.append(f'Fix ({name}): \x60{f}\x60 — Symptom: {symptom} — Fix: {action}')
if entries:
    with open('.runs/fix-log.md', 'a') as log:
        log.write('\n'.join(entries) + '\n')
    print(f'WARNING: fix-log was empty but traces had {len(entries)} fixes. Synthesized entries.')
else:
    print('NO_FIXES')
"
```

- If output is `NO_FIXES`: both fix-log and traces confirm no fixes occurred. Skip to STATE 7.
- If output contains `WARNING`: fixes were recovered from trace data. Proceed with the standard observer spawn flow below.

If the Fix Log has any entries:

1. Collect targeted diffs automatically:

```bash
python3 -c "
import re, subprocess, os, json
fixes = open('.runs/fix-log.md').read()
files = sorted(set(re.findall(r'\x60([^\x60]+\.(?:ts|tsx|js|jsx|json|css))\x60', fixes)))
diffs = []
for f in files:
    r = subprocess.run(['git', 'diff', 'HEAD', '--', f], capture_output=True, text=True)
    if r.stdout.strip():
        diffs.append(f'=== {f} ===\n{r.stdout}')
    elif os.path.exists(f):
        r2 = subprocess.run(['git', 'diff', '--no-index', '/dev/null', f], capture_output=True, text=True)
        if r2.stdout.strip():
            diffs.append(f'=== {f} (new file) ===\n{r2.stdout}')
with open('.runs/observer-diffs.txt', 'w') as out:
    out.write('\n'.join(diffs) if diffs else '(no diffs captured)')
print(f'Collected diffs for {len(diffs)} files -> .runs/observer-diffs.txt')
"
```

2. Spawn the `observer` agent (`subagent_type: observer`).
   Pass ONLY: content of `.runs/observer-diffs.txt` + Fix Log summaries + template file list.
   Do NOT include experiment.yaml content, project name, or feature descriptions.
   Get template file list (from build-info-collector, or generate now:
   run `cat .claude/template-owned-dirs.txt | grep -v '^#' | grep -v '^$' | xargs -I{} find {} -type f 2>/dev/null`).
3. Report the observer's result.
4. Verify `.runs/agent-traces/observer.json` exists; if agent returned output but trace is missing, write a recovery trace with `"recovery":true`.

**POSTCONDITIONS:** Observer ran (if fixes exist) or was correctly skipped.

**VERIFY:** If fix-log.md has entries beyond header, `observer.json` trace exists.
<!-- VERIFY=true: Observer spawns conditionally (only if fix-log has entries).
     Both paths (skip and spawn) are valid. State 7a is the actual quality gate. -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 6
```

**NEXT:** Read [state-7a-write-report.md](state-7a-write-report.md) to continue.

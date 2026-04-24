# STATE 99: EPILOGUE

Shared terminal state used by every lifecycle skill. Lives in
`.claude/patterns/` (not `.claude/skills/<skill>/`) and is dispatched
via the patterns-dir fallback in `lifecycle-next.sh` → `find_state_file`.

**PRECONDITIONS:**
- All manifest states (non-epilogue) completed — chain-check enforced by
  `state-completion-gate.sh` before `advance-state.sh <skill> 99` is allowed.
- `.runs/<skill>-context.json` exists.
- This skill is NOT an embed (embeds auto-skip `"99"` via
  `embed_skip_epilogue` context flag — see `lifecycle-init.sh --embed`).

**ACTIONS:**

### Step 1 — Delivery & recheck

Run finalize: delivers for code-writing skills (commit → push → PR →
auto-merge), no-ops for analysis-only skills. Writes `.runs/verify-recheck.json`.

```bash
bash .claude/scripts/lifecycle-finalize.sh $SKILL
```

Self-reference note: `lifecycle-finalize.sh` Step 2 reruns every state's
VERIFY as a warn-only audit. It explicitly skips `state_id == "99"`
because state 99 is currently in flight — its VERIFY checks artifacts
this step writes.

### Step 2 — Derive scope and run observation

Read `.claude/patterns/skill-epilogue.md` and follow its procedure,
**skipping Step 0** (finalize already verified state completion).

`skill-epilogue.md` derives observation scope from `skill.yaml`
(full | process | code | audit-only) and calls
`.claude/patterns/observation-phase.md`. That writes:
- `.runs/observe-result.json` (always for non-optimize-prompt skills)
- `.runs/compliance-audit-result.json` (full/process/code/audit-only)
- `.runs/retrospective-result.json` (full/process with agent traces)

### Step 2a — Deterministic artifact enforcement

```bash
bash .claude/scripts/check-observation-artifacts.sh
```

This script is intentionally non-blocking (always exits 0). It writes
`.runs/observation-enforcement.json` — trap-guaranteed on any exit path
— with fields `{pass, missing, scope, skill, fast_path, timestamp}` or
`{pass: False, error: "..."}` when the script itself crashes.

### Step 3 — Remediation (conditional)

If `.runs/verify-recheck.json` contains `failed > 0` OR non-empty
`missing_states`:

```bash
# Read .claude/patterns/remediation-phase.md and execute its procedure.
```

Remediation may retry observation; do NOT advance state 99 until the
retry resolves.

### Step 3a — Legitimate skip path (service outage)

If observation fails twice and external-service unavailability is
confirmed (Anthropic API down, GitHub API down), write an explicit
skip artifact before advancing — VERIFY accepts `skipped=True`:

```bash
python3 -c "
import json, datetime
json.dump({
    'pass': False, 'skipped': True, 'scope': 'unknown',
    'skill': '$SKILL', 'fast_path': False,
    'skip_reason': 'external_service_unavailable',
    'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
}, open('.runs/observation-enforcement.json', 'w'), indent=2)
"
```

This is the ONLY legitimate manual skip. Any other observation failure
must trigger remediation-phase; VERIFY rejects bare `error` fields so
no silent skip is possible.

### Step 4 — Mark complete

Derive the correct registry key (handles mode-qualified skills: `iterate-check`,
`iterate-cross`) by reading the in-progress context's `skill` field. Then call
`advance-state.sh` with that key so `state-completion-gate.sh` resolves VERIFY
against the right registry entry.

```bash
SKILL_KEY=$(python3 -c "
import json, glob, os, sys
best = None
best_ts = ''
for f in glob.glob('.runs/*-context.json'):
    if f.endswith('/epilogue-context.json'):
        continue
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if d.get('completed') is True:
        continue
    ts = d.get('timestamp', '') or ''
    if ts >= best_ts:
        best = d
        best_ts = ts
sys.stdout.write((best or {}).get('skill', ''))
")
[ -n "$SKILL_KEY" ] || { echo 'ERROR: state-99 could not derive SKILL_KEY from .runs/*-context.json' >&2; exit 1; }
bash .claude/scripts/advance-state.sh "$SKILL_KEY" 99
```

The `state-completion-gate.sh` hook enforces the VERIFY below before
this command is allowed to execute.

**POSTCONDITIONS:**
- `.runs/verify-recheck.json` exists (written by Step 1).
- `.runs/observation-enforcement.json` exists (written by Step 2a).
- That JSON's `pass` field is `True` OR its `skipped` field is `True`.
  An `error` field does NOT satisfy — that path requires remediation
  (Step 3) or explicit `skipped=True` write (Step 3a).

**VERIFY:**
```bash
test -f .runs/verify-recheck.json && test -f .runs/observation-enforcement.json && python3 -c "import json; d=json.load(open('.runs/observation-enforcement.json')); assert d.get('pass') is True or d.get('skipped') is True, 'observation enforcement failed: pass=%s skipped=%s missing=%s scope=%s error=%s' % (d.get('pass'), d.get('skipped'), d.get('missing'), d.get('scope'), d.get('error'))"
```

**STATE TRACKING:** After postconditions pass, mark this state complete
(see Step 4 above for `$SKILL_KEY` derivation):
```bash
bash .claude/scripts/advance-state.sh "$SKILL_KEY" 99
```

**NEXT:** `lifecycle-next.sh` returns `FINALIZE`. Skill terminates.

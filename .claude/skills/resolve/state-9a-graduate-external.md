# STATE 9a: GRADUATE_EXTERNAL_STACK

**PRECONDITIONS:**
- Patterns saved (STATE 9 POSTCONDITIONS met)

**ACTIONS:**

Evaluate whether any resolved issue targets an external service that qualifies
for graduation to a permanent template-level stack file. Multiple services
may be identified — evaluate each independently.

### 1. Identify external services

Check resolved issue titles/bodies for references to `external/<service>.md`
or `[pattern] external/<service-slug>`. Extract all unique `<service-slug>` values.

If no external service is referenced in any resolved issue:
→ Write graduation-result.json with `services: []`,
  `skipped_reason: "no external service in resolved issues"` → skip to NEXT.

### For each identified service, run steps 2-6:

### 2. Check if permanent file already exists

If `.claude/stacks/external/<service-slug>.md` already exists:
→ Record `{ "service": "<slug>", "graduated": false, "skipped_reason": "permanent stack file already exists" }` → continue to next service.

### 3. Count observations (dual search)

```bash
TEMPLATE_REPO="magpiexyz-lab/mvp-template"

# Search 1: pattern-classifier issues
gh issue list --repo $TEMPLATE_REPO --label observation \
  --search "[pattern] external/<service-slug>" --state all --limit 50 \
  --json number,title

# Search 2: observer issues (keyword)
gh issue list --repo $TEMPLATE_REPO --label observation \
  --search "<service-name>" --state all --limit 50 \
  --json number,title
```

Deduplicate by issue number. Post-filter: only count issues whose title or
body references the service name or `external/<service-slug>.md`.

### 4. Apply threshold

- **≥2 total observations** → graduate.
- **≥1 observation with HIGH security severity** → graduate immediately.
  Security keywords in title: "signature", "SSRF", "injection", "XSS",
  "HMAC", "validation bypass", "PII", "authentication bypass".

If threshold not met:
→ Record `{ "service": "<slug>", "graduated": false, "skipped_reason": "threshold not met (<count>/<threshold>)" }` → continue to next service.

### 5. Synthesize permanent stack file

Create `.claude/stacks/external/<service-slug>.md` using:

**Content sources:**
- Resolved observations' "Suggested template change" sections
- `scaffold-externals.md` Known Service Quirks entries for this service
- Existing permanent files (`retell-ai.md`, `twilio.md`) as structural reference
- Claude's knowledge of the service API

**Required sections:**
- YAML frontmatter (per `.claude/stacks/TEMPLATE.md` schema)
- `## Packages` — npm install commands
- `## Files to Create` — client library + webhook route handler code templates
- `## Environment Variables` — documented secrets
- `## Patterns` — security/architectural best practices
- `## Security` — threat vectors and mitigations
- `## CLI Provisioning` — CLI availability or "No CLI available..."
- `## PR Instructions` — manual provisioning steps

**Constraints:**
- `ci_placeholders: {}` — external service env vars are runtime-only
- Server vars in `env.server`, client vars in `env.client`
- Next.js client vars must use `NEXT_PUBLIC_` prefix

### 6. Validate frontmatter

```bash
python3 scripts/validate-frontmatter.py .claude/stacks/external/<service-slug>.md
```

Max 2 retries on failure. Record graduated service result.

### 7. Write graduation artifact

After evaluating all services, write the combined result:

- **Write graduation-result artifact** (`.runs/graduation-result.json`):
  ```bash
  python3 -c "
  import json
  result = {
      'evaluated': True,
      'services': [
          # one entry per identified service:
          {
              'service': '<service-slug>',
              'observation_count': N,
              'threshold': 2,
              'graduated': True,  # or False
              'file_path': '.claude/stacks/external/<service-slug>.md',
              'frontmatter_valid': True,
              'skipped_reason': None  # or reason string
          }
      ],
      'skipped_reason': None  # set only when no external services found
  }
  json.dump(result, open('.runs/graduation-result.json', 'w'), indent=2)
  "
  ```

### Q-score

Write dimension data for lifecycle-finalize:

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/resolve-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
python3 -c "
import json, datetime
with open('.runs/q-dimensions.json', 'w') as f:
    json.dump({
        'skill': 'resolve',
        'scope': 'resolve',
        'dims': {'completion': 1.0},
        'run_id': '$RUN_ID',
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
    }, f, indent=2)
print('Wrote .runs/q-dimensions.json')
" || true
```

**POSTCONDITIONS:**
- `.runs/graduation-result.json` exists with required fields
- For each service with `graduated: true`: permanent stack file exists and frontmatter is valid

<!-- VERIFY=registry: graduation-result.json artifact validation -->
**VERIFY:**
```bash
python3 -c "import json,os; d=json.load(open('.runs/graduation-result.json')); assert d.get('evaluated')==True, 'not evaluated'; svcs=d.get('services',[]); assert isinstance(svcs, list), 'services not a list'; [None for s in svcs if s.get('graduated') and not (s.get('file_path') and os.path.exists(s['file_path']) and s.get('frontmatter_valid')==True) and (_ for _ in ()).throw(AssertionError('graduated %s but file missing or invalid' % s.get('service')))]"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 9a
```

**NEXT:** Read [state-11-commit-pr.md](state-11-commit-pr.md) to continue.

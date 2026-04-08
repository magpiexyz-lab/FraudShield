# STATE 3: BEHAVIORS

**PRECONDITIONS:**
- Hypotheses generated and approved (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

## Step 4: Derive Behaviors

Convert each **pending** (experiment-type) hypothesis into testable behaviors using given/when/then format.

For each hypothesis, derive 1-3 behaviors that, if observed, would validate or invalidate it.

### Behavior fields
```yaml
- id: b-01                      # Sequential zero-padded: b-01, b-02, ...
  hypothesis_id: h-01           # Which hypothesis this validates
  given: "A visitor lands on the landing page"
  when: "They read the headline and see the CTA"
  then: "They click the CTA button"
  tests:                         # 1-5 verifiable assertions
    - "Landing page renders CTA button"
    - "Clicking CTA navigates to signup"
  level: 1                       # Matches the hypothesis level
```

For system or scheduled behaviors, add `actor` and `trigger`:
```yaml
- id: b-05
  actor: system                  # system | cron (default: user, omit for user behaviors)
  trigger: "stripe webhook checkout.session.completed"
  hypothesis_id: h-03
  given: "..."
  when: "..."
  then: "..."
  tests:
    - "..."
  level: 3
```

### Rules
- Every pending hypothesis must have at least one behavior
- Behaviors must be observable and measurable (map to analytics events or database state)
- Use concrete user actions, not abstract concepts ("clicks the CTA" not "shows interest")
- Behaviors replace the traditional `features` list — each behavior IS a feature requirement
- Each behavior must have 1-3 `tests` entries — verifiable assertions about the behavior
- System/cron behaviors should be derived from monetize or operational hypotheses

**POSTCONDITIONS:**
- Each pending hypothesis has at least one behavior
- Each behavior has id, hypothesis_id, given, when, then, tests, level
- System/cron behaviors have actor and trigger fields
- All behaviors are observable and measurable

**VERIFY:**
```bash
python3 -c "import yaml; d=yaml.safe_load(open('experiment/experiment.yaml')); bs=d.get('behaviors',[]); assert isinstance(bs, list) and len(bs)>0, 'no behaviors'; assert all(b.get('id') and b.get('hypothesis_id') for b in bs), 'behavior missing required fields'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh spec 3
```

**NEXT:** Read [state-4-golden-path.md](state-4-golden-path.md) to continue.

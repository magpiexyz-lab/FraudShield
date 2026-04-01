# STATE 5d: ADVERSARIAL_CHALLENGE

**PRECONDITIONS:**
- Fix design complete (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

The adversarial challenge adapts based on `solve_depth`:

#### Light mode adversarial challenge

Launch a single Explore subagent to challenge each fix design:

Prompt includes: all fix plans from Step 5 (root cause, fix plan,
blast radius, anti-pattern review).

**Fix Challenge Protocol** — for each fix, attempt to construct a
scenario where the fix is wrong or insufficient. Default label is
"sound"; challenger must produce evidence to dispute.

Three challenge vectors:

1. **Configuration counterexample**: Find an experiment.yaml
   configuration (archetype + stack) where the fix would break.
   Read fixtures in `tests/fixtures/*.yaml` for concrete configs.

2. **Blast radius gap**: Are there files NOT in the blast radius
   that share the pattern? Grep more broadly than Step 4.

3. **Regression vector**: Would this fix break existing validator
   checks? Read `scripts/check-inventory.md` and identify checks
   touching the same files.

Output per fix:
```
### Fix for Issue #N
- **Label**: sound | challenged | needs-revision
- **Challenge**: <what was tried>
- **Evidence**: <file:line quotes or fixture names>
- **Revision**: <if not sound: specific change to fix plan>
```

After the agent returns:
- **sound**: proceed as designed
- **needs-revision**: incorporate revision, note in diagnosis report
- **challenged**: present to user at STOP gate; let user decide

#### Full mode adversarial challenge

Step 5d is replaced by solve-reasoning Phase 5 Critic Loop (already
executed in Step 5b-full). The 3 domain-specific challenge vectors
above (configuration counterexample, blast radius gap, regression
vector) are injected into the Critic prompt as additional instructions.

Critic output mapping:
- **TYPE A round 1** -> revision to `fix_plan` (already applied)
- **TYPE A round 2** (unresolved) -> caveats in diagnosis report
- **TYPE B** -> system constraints in diagnosis report
- **TYPE C** -> merged into STOP gate questions (see below)

Present a diagnosis report for all actionable issues:

```
## Issue #N: <title>

**Root cause:** <1-2 sentences>
**Divergence point:** <file:line>
**Reproduction:** validator-confirmed (<error>) | simulation-only
**Blast radius:** N files affected (M confirmed, K potential)
**Fix plan:**
- <file>: <what changes>
**Proposed validator check:** <name> in <script> | none
**Anti-pattern review:** None apply / <which one was close and why it doesn't apply>
**Adversarial check:** sound | revised (<what changed>) | challenged (<summary>)
```

**Full mode STOP augmentation**: If `solve_depth = "full"` for any issue, append
to the diagnosis report before presenting:

```
### Open Questions
[Phase 5 TYPE C concerns — assumptions only the user can validate]

### System Constraints
[Phase 5 TYPE B items — immutable constraints the fix must work around, or "None"]
```

**STOP. Present the diagnosis report to the user and wait for approval before
proceeding to Phase 3.** The user may adjust fix plans or scope.

- **Write challenge artifact** (`.runs/resolve-challenge.json`):
  ```bash
  python3 -c "
  import json
  challenge = {
      'challenges': [
          {'issue': 0, 'label': '<sound|challenged|needs-revision>', 'challenge': '<what was tried>', 'evidence': '<file:line or fixture>', 'revision': '<if not sound>'}
      ]
  }
  json.dump(challenge, open('.runs/resolve-challenge.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Diagnosis report presented to user for all actionable issues
- Adversarial challenge completed for each fix
- User has approved the diagnosis before proceeding
- `.runs/resolve-challenge.json` exists

**VERIFY:**
```bash
test -f .runs/resolve-challenge.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 5d
```

**NEXT:** Read [state-6-branch-setup.md](state-6-branch-setup.md) to continue.

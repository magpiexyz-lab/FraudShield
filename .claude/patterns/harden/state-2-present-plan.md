# STATE 2: PRESENT_PLAN

**PRECONDITIONS:**
- STATE 1 POSTCONDITIONS met (modules scanned and classified)

**ACTIONS:**

Present the hardening plan:

```
## Hardening Plan: [project-name]

### Current State
- Modules: N total, M tested, K untested-critical

### Dependency Order
- Independent: [modules with no cross-dependencies] -- can proceed in any order
- Sequential: [module B] depends on [module A] -- harden A first
- (Or: "All modules are independent -- no ordering constraints")

### Will Harden (Critical, no tests):

#### 1. [module name]
- **Files:** [source file paths]
- **Why critical:** [classification reason from Step 1]
- **Behaviors:** [b-NN: description], [b-NN: description] (from experiment.yaml)
- **Specifications to test:**
  - [concrete assertion derived from behaviors + code reading]
  - [e.g., "POST /api/invoices creates invoice record with authenticated user's org_id"]
  - [e.g., "Returns 401 when session is missing"]
  - [e.g., "Validates required fields (amount, due_date) with zod schema"]
- **Test count:** N specification tests

#### 2. [module name]
- (same structure as above)

### On-Touch (Important, defer):
- [module] -- [reason]

### Skip:
- [module] -- [reason: UI-only / already covered]

### Changes:
- experiment.yaml: add quality: production
- experiment.yaml: add stack.testing if absent
```

If K (untested-critical modules) is 0: replace the plan prompt with:

> No critical untested modules found -- all critical modules already have tests.
> Options:
> 1. **proceed** -- set `quality: production` in experiment.yaml (enables TDD for future /change runs)
> 2. **harden on-touch** -- also add specification tests to the On-Touch modules listed above
> 3. Or run `/change` to continue building features -- they'll use TDD once production quality is set

Wait for user choice. If "proceed": skip STATE 5 module loop (no modules to harden), execute STATEs 4 (branch, config, testing setup) then jump directly to STATEs 7-9 (ON-TOUCH, verify, PR). When saving the plan frontmatter, set `checkpoint: step3-reconcile` (not `step3-module-1`, since there are no modules -- reconciliation is a no-op for K=0, then execution proceeds to ON-TOUCH, verify, PR). If "harden on-touch": promote On-Touch modules to the Will Harden section, re-present the plan with those modules, and wait for approval. After approval, proceed to STATE 4 with the expanded module list (K now equals the promoted count).

**POSTCONDITIONS:**
- Hardening plan presented to user with all required sections
- K (untested-critical count) determined
- `.claude/runs/current-plan.md` exists

**VERIFY:**
```bash
test -f .claude/runs/current-plan.md
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 2
```

**NEXT:** Read [state-3-user-approval.md](state-3-user-approval.md) to continue.

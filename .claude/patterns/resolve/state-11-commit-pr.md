# STATE 11: COMMIT_PR

**PRECONDITIONS:**
- Skill epilogue complete (STATE 10 POSTCONDITIONS met)

**ACTIONS:**

Commit all changes with message: `Fix #N: <imperative description>`
(or `Fix #N, #M: <description>` for multiple issues).

Push and open PR using `.github/PULL_REQUEST_TEMPLATE.md`:

- **Summary**: For each issue resolved:
  - Issue number and title
  - Root cause (1 sentence)
  - What changed
- **How to Test**: "Run `make validate` + all 3 validator scripts"
- **What Changed**: List every file and what changed
- **Why**: "Resolves template issues reported in #N" with `Closes #N` for each issue

Include additional sections in PR body:

### Root Cause Analysis
For each issue: root cause, divergence point, and why the fix addresses it.

### Blast Radius
Files checked, confirmed matches fixed, potential matches evaluated.

### Validator Additions
New checks added (if any), with name, target script, and pass/fail criteria.
If none: "No new checks — pattern is unlikely to recur."

### Validator Evidence
| Issue | Pre-Fix Errors | Post-Fix Errors | Delta |
|-------|---------------|-----------------|-------|
| #N    | <cited errors or "none"> | <errors or "none"> | -K |

### Adversarial Review
| Issue | Label | Challenge Summary |
|-------|-------|-------------------|
| #N    | sound | Tested 3 fixture configs, no breakage |

### Cross-Issue Correlation
- Cluster 1: #A, #B — shared root cause: <pattern>. Single fix.
- Uncorrelated: #C
(Or: "Single issue — no correlation analysis")

### Potentially Resolved
(From Step 8b, or "None — no side-effect matches detected")

**POSTCONDITIONS:**
- All changes committed
- PR opened with full template sections
- `Closes #N` in PR body for each resolved issue

**VERIFY:**
```bash
gh pr view --json number 2>/dev/null
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 11
```

**NEXT:** This is the TERMINAL state. The /resolve skill is complete.

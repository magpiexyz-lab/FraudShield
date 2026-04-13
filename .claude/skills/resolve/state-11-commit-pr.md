# STATE 11: COMMIT_PR

**PRECONDITIONS:**
- External stack graduation complete (STATE 9a POSTCONDITIONS met)

**ACTIONS:**

Read `resolve-context.json` and check the `mode` field.

### Write delivery artifacts

**If `mode == "refine"`:**
- `commit-message.txt`: `Refine: <improvement description>\n\nFixes #N, #M`
- `pr-title.txt`: `Refine: <skill> state improvements`
- All other PR body sections (Root Cause Analysis, Blast Radius, etc.) remain the same

**If `mode` is not `"refine"`:** use the normal format below.

Write `.runs/commit-message.txt`: `Fix #N: <imperative description>`
(or `Fix #N, #M: <description>` for multiple issues).

Write `.runs/pr-title.txt`: short title (<=70 chars).

Write `.runs/pr-body.md` using `.github/PULL_REQUEST_TEMPLATE.md`:

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

End with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

**POSTCONDITIONS:**
- Delivery artifacts written: `.runs/commit-message.txt`, `.runs/pr-title.txt`, `.runs/pr-body.md`
- `Closes #N` in `pr-body.md` for each resolved issue

**VERIFY:**
```bash
test -f .runs/commit-message.txt && test -f .runs/pr-title.txt && test -f .runs/pr-body.md
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 11
```

**NEXT:** TERMINAL — `lifecycle-finalize.sh` handles commit, push, PR creation, and auto-merge.

After finalize, read the `DELIVERY=` output and tell the user:
- If `DELIVERY=merged`: "Resolve PR auto-merged to main. Issues closed."
- If `DELIVERY=pr-created:<reason>`: "Resolve PR created but not auto-merged (<reason>). Merge manually."

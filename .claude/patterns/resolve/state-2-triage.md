# STATE 2: TRIAGE

**PRECONDITIONS:**
- Context files read (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

Read `resolve-context.json` and check the `mode` field.

**If `mode == "refine"`:**
- Issues with label `refine` (trace-derived): type is fixed as "Gap", severity was already determined in STATE 0, action is "fix"
- Issues with label `observation`: classify using the standard 10-type system below
- Present the unified triage table and STOP for user approval (same as normal mode)

**If `mode` is not `"refine"`:** proceed with normal classification below.

Classify each issue into one of 10 types:

**Actionable (proceed to Phase 2):**

| Type | Description |
|------|-------------|
| Bug | Template file produces incorrect output or broken code |
| Gap | Missing handling for a valid configuration |
| Inconsistency | Two template files contradict each other |
| Regression | Previously working behavior now broken |
| Observation | Filed by observe.md — template-rooted issue from a project |

**Architectural (defer to /solve, skip Phase 2):**

| Type | Criteria |
|------|----------|
| Architectural | Issue describes changes to CLAUDE.md structure, state-registry.json, state machine flow, skill contracts, or cross-skill systemic concerns. Requires design-level analysis beyond auto-fix scope. |

**Architectural Smell Test** — evaluate for EVERY issue before assigning a type:

1. Does the root cause involve a pattern or mechanism used by more than one skill?
2. Does the suggested fix have 2+ fundamentally different design options?
3. Would fixing this in one file leave the same problem latent in other skills?
4. Does the issue touch state-registry.json, CLAUDE.md structure, or skill contracts?

If ANY answer is YES → classify as Architectural (defer to /solve).
Principle: err on the side of deferring — false Architectural classifications
are cheap (one /solve run), false Bug classifications risk incomplete fixes.

For architectural issues, post a comment and leave the issue open (do NOT close):
```bash
gh issue comment <N> --body "**Deferred: Architectural Issue**

This observation describes a template-architecture concern that requires first-principles design analysis.

**Recommended next step:**
\`/solve \"Issue #<N>: <title>\"\`"
```

**Non-actionable (handle now, skip Phase 2):**

| Type | Action |
|------|--------|
| Environment | Comment: "This is an environment issue, not a template bug. [specific guidance]." Close. |
| User error | Comment: "This appears to be project-specific. [explain why]. Reopen if you believe this is a template issue." Close. |
| Duplicate | Comment: "Duplicate of #N." Close. |
| Stale | The described problem no longer exists in current code. Verify with a lightweight check: (1) `git log --oneline --since="<issue_created_date>" -- <cited_file>` — if the file was modified since the issue was filed, (2) read the cited file and confirm the specific pattern/text described in the issue is gone or fixed. Only classify as Stale when evidence is clear; ambiguous cases should proceed to Phase 2. Comment: "Verified against current main — this was fixed in [commit/PR]. [brief explanation]." Close. |
| Won't fix | Comment with rationale. Label `wontfix`. Close. |

For non-actionable issues, execute the close/comment actions now:
```bash
gh issue close <N> --comment "<comment>"
```

Present a triage table:

```
| # | Title | Type | File(s) | Severity | Action |
|---|-------|------|---------|----------|--------|
```

Severity levels: HIGH (breaks execution), MEDIUM (wrong output), LOW (cosmetic).

If all issues are non-actionable or architectural (all closed or deferred in Step 2): report "All issues
resolved as non-actionable or deferred — no Phase 2 diagnosis needed." Stop here.

**STOP. Present the triage table to the user and wait for approval before
proceeding to Phase 2.** The user may reclassify issues or remove them from scope.

- **Write triage artifact** (`.runs/resolve-triage.json`):
  ```bash
  python3 -c "
  import json
  triage = {
      'issues': [
          {'number': 0, 'type': '<bug|gap|inconsistency|regression|observation|architectural>', 'severity': '<high|medium|low>', 'action': '<fix|close|defer>'}
      ],
      'actionable_count': 0,
      'closed_count': 0,
      'deferred_count': 0
  }
  json.dump(triage, open('.runs/resolve-triage.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- All issues classified with type, severity, and action
- Non-actionable issues closed with comments
- Triage table presented to user
- User has approved the triage before proceeding
- `.runs/resolve-triage.json` exists with `issues` array

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/resolve-triage.json')); assert isinstance(d.get('issues'), list) and len(d['issues'])>0, 'issues missing or empty'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 2
```

**NEXT:** If all issues were non-actionable or deferred (all closed/deferred above), skill is complete — TERMINAL. Otherwise, read [state-3-reproduce.md](state-3-reproduce.md) to continue.

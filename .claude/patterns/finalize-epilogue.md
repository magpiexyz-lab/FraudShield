# Finalize Epilogue — LLM-side post-finalize procedure

After `lifecycle-finalize.sh` returns, execute this procedure to run the
skill epilogue (template observation). This is the single entry point for
all skill epilogues — all skills use the same observation path via
`observation-phase.md`.

## Step 1: Parse finalize output

Read the output of `lifecycle-finalize.sh` for:
- `EPILOGUE_STRATEGY=A` — skill produced committed diffs vs main (code observation)
- `EPILOGUE_STRATEGY=B` — no diffs (execution audit)

> Note: The A/B distinction is informational only. `observation-phase.md`
> derives its own scope from skill.yaml, so the strategy value is not passed
> through. It is retained in finalize output for backward compatibility with
> logging and diagnostics.

## Step 1.5: Skip check

Skip epilogue entirely for:
- **optimize-prompt** — stateless utility, no state machine, no observation

If the current skill is `optimize-prompt`, stop.

## Step 2: Execute epilogue

Read `.claude/patterns/skill-epilogue.md` and follow the procedure. **Skip
Step 0** (state completion check) — `lifecycle-finalize.sh` already verified
state completion.

## Step 2a: Validate observation artifacts

Run the deterministic artifact enforcement check:
```bash
bash .claude/scripts/check-observation-artifacts.sh
```

This validates that observation-phase.md Steps 5a/5b/5c produced their
expected artifacts based on the skill's observation scope. Warnings are
emitted to stderr for any missing artifacts. This check is non-blocking
(the epilogue continues regardless) but writes
`.runs/observation-enforcement.json` for audit trail.

**Expected artifacts by scope:**
| Scope | compliance-audit-result.json | retrospective-result.json | observe-result.json |
|-------|:---:|:---:|:---:|
| full | required | required (if agent traces exist) | required |
| process | required | required (if agent traces exist) | required |
| code | required | not expected | required |
| audit-only | required | not expected | required |

When the fast-path fired (Step 3 of observation-phase.md: no diffs, no
fix-log entries, no agent trace fixes), no intermediate artifacts are
expected — the check passes automatically.

## Step 2b: Remediation suggestions

If `.runs/verify-recheck.json` exists, read `.claude/patterns/remediation-phase.md`
and follow the procedure with the current skill name.

Skip when: skill is `optimize-prompt` (already exited at Step 1.5).

Remediation execution is mandatory. If any part fails, retry once. If it still
fails, log the failure reason and continue to Step 3 — do not silently skip.

## Step 3: Done

Epilogue execution is **mandatory**. Every skill must complete the observation
epilogue before the skill is considered done. If a step fails, retry once.
If it still fails, write `observe-result.json` with `"verdict": "error"` and
`"error_reason"` — do NOT silently write `"clean"`. Report the failure to
the user. External service failures (GitHub API, template repo access) degrade
to local logging but do not skip the evaluation.

If remediation suggestions were generated, they have been printed to the
terminal and saved to `.runs/remediation.json`.

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

## Step 2.5: Remediation suggestions

If `.runs/verify-recheck.json` exists, read `.claude/patterns/remediation-phase.md`
and follow the procedure with the current skill name.

Skip when: skill is `optimize-prompt` (already exited at Step 1.5).

This step is best-effort. If any part fails, continue to Step 3.

## Step 3: Done

Epilogue is best-effort. If any step fails, write `observe-result.json` with
`"verdict": "clean"` and continue — never block the skill.

If remediation suggestions were generated, they have been printed to the
terminal and saved to `.runs/remediation.json`.

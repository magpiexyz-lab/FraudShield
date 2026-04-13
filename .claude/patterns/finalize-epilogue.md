# Finalize Epilogue — LLM-side post-finalize procedure

After `lifecycle-finalize.sh` returns, execute this procedure to run the
skill epilogue (template observation). This is the single entry point for
all skill epilogues — individual skills no longer run epilogue inline.

## Step 1: Parse finalize output

Read the output of `lifecycle-finalize.sh` for:
- `EPILOGUE_STRATEGY=A` — skill produced committed diffs vs main (code observation)
- `EPILOGUE_STRATEGY=B` — no diffs (execution audit)

## Step 1.5: Idempotency guard

If `.runs/observe-result.json` already exists, **skip the entire epilogue and stop**.
Another mechanism already wrote it (e.g., verify.md STATE 6 for change/distribute,
or a skill's own epilogue state for iterate-check). Overwriting it would lose
real observation data.

## Step 2: Check skip list

Skip epilogue entirely for these skills (they handle observation elsewhere):
- **change** — verify.md STATE 6 Auto-Observe handles observation
- **distribute** — verify.md STATE 6 Auto-Observe handles observation
- **verify** — has its own STATE 6 + 7 for observation
- **optimize-prompt** — stateless utility, no observation

If the current skill is in this list, stop. Do not write observe-result.json
(for change/distribute it already exists from verify.md; for verify/optimize-prompt
it's either already written or not needed).

## Step 3: Execute epilogue

Read `.claude/patterns/skill-epilogue.md` and follow the procedure using the
determined strategy (A or B). **Skip Step 0** (state completion check) —
`lifecycle-finalize.sh` already verified state completion.

## Step 4: Done

Epilogue is best-effort. If any step fails, write `observe-result.json` with
`"verdict": "clean"` and continue — never block the skill.

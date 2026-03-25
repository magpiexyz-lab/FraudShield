# STATE 0: VALIDATE_PRECONDITIONS

**PRECONDITIONS:**
- Git repository exists in working directory

**ACTIONS:**

Follow checkpoint-resumption protocol per `patterns/checkpoint-resumption.md`.

- `package.json` exists (app is bootstrapped). If not -> stop: "No app found. Run `/bootstrap` first."
- `npm run build` passes. If not -> stop: "App has build errors. Run `/change fix build errors` first."
- If `quality: production` already set in experiment.yaml AND no `$ARGUMENTS`:
  * If `stack.testing` is absent from experiment.yaml: proceed (harden will add the missing testing stack). Log: "Production mode is set but testing stack is missing — proceeding to add it."
  * Otherwise: stop -- "Already in production mode. Use `/harden <module>` to harden a specific module, or `/change` for new features."
- If `.claude/current-plan.md` exists AND the current branch starts with `chore/harden`:
  1. Read frontmatter. If parsing fails: stop -- "Plan file has corrupted frontmatter. Delete `.claude/current-plan.md` and re-run `/harden` to start fresh."
  2. Use values directly -- do NOT re-scan or re-classify. Read context_files to restore context.
  3. Resume per /harden checkpoint mapping:

     | Checkpoint | Resumes at |
     |-----------|------------|
     | `step2-approval` | STATE 2 (plan approval) |
     | `step3-setup` | STATE 4 (branch + config) |
     | `step3-module-N` | STATE 5 at module N (skip completed) |
     | `step3-reconcile` | STATE 6 (reconciliation) |
     | `step3-verify` | STATE 8 (run /verify) |
     | `step3-pr` | STATE 9 (commit/PR) |

  4. Report progress: "Resuming /harden from [checkpoint]. Done: [completed]. Remaining: [remaining]. Do NOT re-run completed modules."
  5. If no frontmatter (old format): scan for CRITICAL modules without tests, proceed from STATE 5.
- If on a `chore/harden-*` branch with existing specification tests but NO `.claude/current-plan.md`: a previous `/harden` may have partially completed. Tell the user: "Found existing hardening work on this branch. Scanning for modules that still need tests..." Then scan for CRITICAL modules without test files and proceed from STATE 5 (module implementation loop), skipping STATE 4 if branch and config are already set up.

Create `.claude/harden-context.json` to initialize state tracking:
```bash
cat > .claude/harden-context.json << CTXEOF
{"skill":"harden","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"harden-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0]}
CTXEOF
```

**POSTCONDITIONS:**
- `package.json` exists
- `npm run build` passes
- `.claude/harden-context.json` exists
- Resume path determined (fresh start or checkpoint resume)

**VERIFY:**
```bash
test -f package.json && test -f .claude/harden-context.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 0
```

**NEXT:** If resuming from a checkpoint, read the target state file indicated by the checkpoint. Otherwise, read [state-1-scan-and-classify.md](state-1-scan-and-classify.md) to continue.

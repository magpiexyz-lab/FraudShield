# STATE 1: SCAN_AND_CLASSIFY

**PRECONDITIONS:**
- STATE 0 POSTCONDITIONS met (fresh start path, not resuming from checkpoint)

**ACTIONS:**

- Read `experiment/experiment.yaml` (behaviors, golden_path, stack, type)
- Read the archetype file at `.claude/archetypes/<type>.md` (type from experiment.yaml, default `web-app`)
- Read the framework stack file at `.claude/stacks/framework/<runtime>.md` to identify the project's file structure conventions
- Scan for modules based on archetype (use paths from the framework stack file's File Structure section):
  - **web-app**: page and API route directories (e.g., `src/app/` for Next.js), `src/components/`, `src/lib/`
  - **service**: route handler directory (e.g., `src/app/api/` for Next.js, `src/routes/` for Hono), `src/lib/`
  - **cli**: `src/commands/`, `src/lib/`
- Glob for existing tests (`**/*.test.*`, `**/*.spec.*`, `e2e/**`)
- Classify each module into 4 categories:

  **CRITICAL** (harden now): Auth/session logic, payment/billing, data mutations (POST/PUT/DELETE API routes with DB writes), golden_path activation steps (web-app: pages, service: endpoints, cli: commands), behaviors with `actor: system/cron`, non-trivial business logic

  **ON-TOUCH** (harden when next modified): Read-only API routes (GET), form validation, data fetching/transformation, golden_path non-value-moment steps

  **SKIP** (no hardening needed): Page/view components (rendering + layout only -- web-app only), UI components, static content, configuration

  **ALREADY COVERED**: Modules with existing test files (list them)

- **Write scan artifact** (`.claude/runs/harden-scan.json`):
  ```bash
  python3 -c "
  import json
  scan = {
      'critical': [],      # list of {module, files, reason}
      'on_touch': [],      # list of {module, reason}
      'skip': [],          # list of {module, reason}
      'already_covered': []  # list of {module, test_file}
  }
  json.dump(scan, open('.claude/runs/harden-scan.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- All modules scanned and classified into CRITICAL, ON-TOUCH, SKIP, or ALREADY COVERED
- Classification results available for plan presentation
- `.claude/runs/harden-scan.json` exists

**VERIFY:**
```bash
test -f .claude/runs/harden-scan.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 1
```

**NEXT:** Read [state-2-present-plan.md](state-2-present-plan.md) to continue.

# STATE 8: PREFLIGHT

**PRECONDITIONS:**
- Plan saved with Process Checklist (STATE 7 POSTCONDITIONS met)

**ACTIONS:**

**Do NOT assemble file contents into the prompt.** Subagents are independent
Claude Code sessions with full file access — they read files themselves. The
prompt tells them WHICH files to read and WHAT to do.

> **WHY:** Embedded content becomes stale if files change between prompt
> construction and subagent execution. The subagent cannot verify embedded
> content matches disk, violating "observe, not trust." Embedded content
> also inflates prompt size, reducing the subagent's effective working
> memory (each 200 lines ~ 2 lost reasoning turns). Let subagents read.

1. **Production quality check**: Pass this flag to each scaffold-* agent prompt: "quality: production is active. Generate tests alongside each file you create." Agent test ownership:
   - scaffold-setup: create testing config (playwright.config.ts or vitest.config.ts)
   - scaffold-libs: generate unit tests for utility functions alongside library code
   - scaffold-pages: generate page-load smoke tests (thorough)
   - scaffold-wire: run test discovery checkpoint (`npx playwright test --list` or vitest equivalent)

   **Vitest co-installation**: If `stack.testing` is NOT `vitest` (e.g., `testing: playwright`):
   - Also install `vitest` and `@vitest/coverage-v8` as dev dependencies
   - Create `vitest.config.ts` using the template from `.claude/stacks/testing/vitest.md`
   - This ensures unit tests (TDD per `patterns/tdd.md`) can run alongside E2E tests
   - scaffold-setup handles this: check if vitest.config.ts exists before creating
   - Two test runners coexist: `npx playwright test` for E2E, `npx vitest run` for unit tests

2. **TSP-LSP check**: Run `which typescript-language-server`. If found, record
   `tsp_status: "available"`. If not found, tell the user:
   > `typescript-language-server` is not installed globally. It gives subagents
   > real-time type checking during code generation. Install with:
   > `npm install -g typescript-language-server typescript`
   > Say "skip" to proceed without it.
   Wait for the user to confirm installation or say "skip". If confirmed,
   re-check with `which typescript-language-server`. Record `tsp_status`
   as `"available"` or `"skipped"`.

This value is passed to subagents in their prompts (subagents cannot
interact with users).

Check off in `.runs/current-plan.md`: `- [x] TSP-LSP check completed`

3. **FAL_KEY check** (AI image generation): Check if `FAL_KEY` is available
   via persistent file (`~/.fal/key`) or environment variable:
   ```bash
   python3 -c "
   import os
   v = ''
   try:
       with open(os.path.expanduser('~/.fal/key')) as f:
           v = f.read().strip()
   except FileNotFoundError:
       pass
   if not v:
       v = os.environ.get('FAL_KEY', '')
   print('available' if v and not v.startswith('placeholder') else 'missing')
   "
   ```
   If `FAL_KEY` is available, record `image_gen_status: "available"`.
   If `FAL_KEY` is not set, tell the user:
   > `FAL_KEY` is not set. AI image generation (FLUX.2 Pro via fal.ai) creates
   > custom hero images, feature illustrations, and empty state graphics during
   > bootstrap. Without it, themed SVG placeholders will be used instead.
   >
   > Get your key from https://fal.ai > Dashboard > Keys, then:
   > `export FAL_KEY=your-fal-ai-key`
   >
   > Say "skip" to proceed with SVG placeholders.
   Wait for the user to set the key or say "skip". If they provide it,
   persist for future sessions: `mkdir -p ~/.fal && echo "$FAL_KEY" > ~/.fal/key`
   Then re-check. Record `image_gen_status` as `"available"` or `"skipped"`.

   This value is passed to subagents in their prompts (subagents cannot
   interact with users).

Check off in `.runs/current-plan.md`: `- [x] FAL_KEY check completed`

- **Record preflight results** in `bootstrap-context.json`:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.runs/bootstrap-context.json'))
  ctx['preflight_passed'] = True
  ctx['image_gen_status'] = '<available_or_skipped>'
  json.dump(ctx, open('.runs/bootstrap-context.json', 'w'), indent=2)
  "
  ```
  Replace `<available_or_skipped>` with the actual value determined above.

**POSTCONDITIONS:**
- `tsp_status` is set to `"available"` or `"skipped"`
- `image_gen_status` is set to `"available"` or `"skipped"`
- Quality flag recorded (production)
- `preflight_passed` field set to `true` in `bootstrap-context.json`

**VERIFY:**
```bash
python3 -c "import json; assert json.load(open('.runs/bootstrap-context.json')).get('preflight_passed') == True, 'preflight_passed not set'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 8
```

**NEXT:** Read [state-9-setup-phase.md](state-9-setup-phase.md) to continue.

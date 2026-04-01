# UX Journeyer Procedure

> Executed by the ux-journeyer agent. See `.claude/agents/ux-journeyer.md` for identity and output contract.

### 1. Prerequisite Check

Run `npx playwright --version`. If it fails, return:
> Skipping UX journey review — Playwright not installed.

### 2. Read Context

- Read `experiment/experiment.yaml` — golden_path, behaviors, thesis, target_user
- Read `experiment/EVENTS.yaml` — events map (these define the expected journey steps)
- Read `.runs/current-plan.md` if it exists — check for an explicit Golden Path field

### 3. Read or Derive Golden Path

If experiment.yaml has a `golden_path` field: use it directly. Record the steps as the expected journey.

If experiment.yaml has no `golden_path` field: derive from behaviors + experiment/EVENTS.yaml `events` map:
Landing -> [signup if auth] -> [core page] -> [activation].

If `.runs/current-plan.md` exists and has a Golden Path section that differs from experiment.yaml,
prefer experiment.yaml (it's the persistent source of truth).

Record the expected path as an ordered list of steps with expected routes.

### 4. Rebuild & Start Server

Follow the rebuild procedure from `.claude/patterns/visual-review.md`
(Section 1b). Start the server on port **3098** (different from design-critic's
3099):

```bash
DEMO_MODE=true NEXT_PUBLIC_DEMO_MODE=true npm run start -- -p 3098 &
```

Poll `http://localhost:3098` until it responds (max 15 seconds, then abort).

### 5. Navigate the Golden Path

Write an inline Playwright script that:

1. Launches Chromium (headless)
2. Starts at `/` (landing)
3. At each step: finds the primary CTA, clicks it, records where it goes
4. Compares actual navigation against golden_path steps — report deviations (e.g., "golden_path says landing -> signup, but CTA goes to /pricing")
5. Tracks for each step:
   - Step number
   - Action taken (e.g., "Click 'Get Started'")
   - Source route
   - Destination route
   - Status: `pass` / `dead-end` / `error`
5. Stops when reaching the value moment OR after 10 steps (whichever first)

Save the trace as a structured array for the report.

### 6. Check Flow Quality

For each page visited during the golden path navigation, check:

- **Single clear forward CTA** — no ambiguous dual-CTA competing for attention
- **Empty states have guidance + CTA** — not bare "No data found" messages
- **Error states have recovery path** — not dead-end error pages
- **Post-auth redirect lands correctly** — user continues the journey, not dumped on a generic page
- **Navigation shows current location** — active state on nav items

Record each check result per page.

### 7. Count & Judge

- Count total clicks from landing to value moment
- Target: **3 clicks or fewer** (unless the golden path specifies a different target)
- List all dead ends, missing transitions, and unclear CTAs found

### 8. Fix Issues

For issues found in steps 5-7:

- Fix redirect paths that send users to the wrong page
- Add empty-state CTAs where missing
- Fix navigation active states
- Clarify ambiguous dual-CTA sections (make one primary, one secondary)
- Run `npm run build` after fixes (must pass)

> **Syntax safety**: After each edit, visually verify JSX tag matching before running build. Common failure: inserting a new element without updating closing tags. If build fails with JSX syntax errors, revert your last edit and try a simpler fix.
>
> **Fix budget**: Fix at most 2 dead ends. If more remain, record them as `unresolved_dead_ends` in the trace and set verdict to `"partial"`.

### 8b. Re-navigate After Fixes

After fixing issues, re-navigate the golden path once to confirm fixes work:

1. Re-use the running server (still on port 3098)
2. Write a Playwright script that re-traces the golden path from `/` to value moment
3. For each previously-failed step, verify it now passes
4. For each dead end that was fixed, verify forward navigation is possible
5. Update the golden path trace with post-fix results

If remaining turns < 8, skip re-navigation and write the trace immediately with current metrics.

### 9. Cleanup

```bash
kill %1 2>/dev/null || true
```

Remove any temp files created during navigation.

### 10. Compute Trace Metrics

Before writing the trace file, compute these metrics from your journey:

- **`clicks_to_value`**: total clicks from the landing page to the value moment (the step where the user first experiences core product value). If the value moment was never reached, use the total clicks navigated.
- **`dead_ends`**: number of pages where no forward navigation was possible (no CTA, broken link, or error page). Intentional fake-door pages count as dead ends in the trace — the lead distinguishes fake-doors from real failures.
- **`golden_path_steps`**: total number of golden path steps navigated (including failed steps). This is the denominator for coverage.
- **`coverage_pct`**: percentage of golden_path steps from experiment.yaml that were successfully completed, as an integer 0-100. Formula: `(successful_steps / total_golden_path_steps) * 100`, rounded down.
- **`fixes_applied`**: total number of fixes applied (redirect fixes, empty-state CTAs added, navigation fixes, etc.). Use `0` if no fixes were needed.
- **`unresolved_dead_ends`**: count of real (non-fake-door) dead ends that remained after fixes. Intentional fake-door pages are excluded — only real navigation failures count. Use `0` if all dead ends were fixed or all are intentional.

These metrics are written into the trace JSON (see agent definition for the trace command).

# STATE 11: PARALLEL_SCAFFOLD

**PRECONDITIONS:**
- Design done (STATE 10 POSTCONDITIONS met)
- `.claude/runs/current-visual-brief.md` exists
- Theme tokens available

**ACTIONS:**

#### scaffold-pages (two-phase)

**Phase A (serial, before fan-out, web-app only):** Service and cli archetypes skip Phase A entirely — proceed to Phase B. (Per `patterns/archetype-behavior-check.md`)

The lead (not a subagent) creates:
- Root layout (`src/app/layout.tsx`) with font imports and globals.css
- 404 page (`src/app/not-found.tsx`)
- Error boundary (`src/app/error.tsx`)
- Favicon (`src/app/icon.tsx`) -- monogram of project name initial in primary color, 128x128, using `ImageResponse` from `next/og`. Uses a system font (sans-serif) -- do NOT fetch Google Fonts in Satori context. Read primary color from `globals.css` `--primary` token or hardcode the derived value.
- OG image (`src/app/opengraph-image.tsx`) -- 1200x630 branded card with project name centered on primary-color gradient background. Uses `ImageResponse` from `next/og` with system font.
- Sitemap (`src/app/sitemap.ts`) -- Next.js built-in sitemap generation from golden_path pages
- Robots (`src/app/robots.ts`) -- Next.js built-in robots.txt, allow all crawlers for MVP
- llms.txt (`public/llms.txt`) -- static AI-readable product summary per messaging.md Section E
- Variant routing files (if `variants` in experiment.yaml): `src/lib/variants.ts`, `src/app/page.tsx`, `src/app/v/[variant]/page.tsx`

Phase A runs AFTER scaffold-init completes (STATE 10) to ensure design tokens exist.

After creating all Phase A files, write the Phase A sentinel:
```bash
mkdir -p .claude/runs/gate-verdicts
cat > .claude/runs/gate-verdicts/phase-a-sentinel.json << 'PAEOF'
{"phase_a_complete": true, "timestamp": "<ISO 8601>", "files": ["src/app/layout.tsx", "src/app/not-found.tsx", "src/app/error.tsx", "src/app/icon.tsx", "src/app/opengraph-image.tsx", "src/app/sitemap.ts", "src/app/robots.ts", "public/llms.txt"]}
PAEOF
```

VERIFY Phase A before proceeding to Phase B:
- `test -f src/app/layout.tsx`
- `test -f src/app/not-found.tsx`
- `test -f src/app/error.tsx`
- `test -f src/app/icon.tsx`
- `test -f src/app/opengraph-image.tsx`
- `test -f src/app/sitemap.ts`
- `test -f src/app/robots.ts`
- `test -f public/llms.txt`
- `test -f .claude/runs/gate-verdicts/phase-a-sentinel.json`

**DO NOT proceed to Phase B until all VERIFY checks pass.**

**Phase B1 (libs + externals):** Spawn scaffold-libs and scaffold-externals in parallel. These two have no cross-dependency. scaffold-pages and scaffold-landing are NOT spawned yet -- they depend on libs output.

**Libs subagent:**
- subagent_type: scaffold-libs
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-libs.md` and execute all steps
  2. Read context files: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
     `.claude/runs/current-plan.md`, all stack files
  3. Follow CLAUDE.md Rules 3, 4, 6, 7

**Externals subagent (analysis only):**
- subagent_type: scaffold-externals
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-externals.md` and execute the
     analysis steps (evaluate dependencies, classify core/non-core)
  2. Read context files: `experiment/experiment.yaml`, `.claude/runs/current-plan.md`,
     `.claude/stacks/TEMPLATE.md`, existing stack files
  3. Follow CLAUDE.md Rules 3, 4, 6
  4. Return the classification table and Fake Door list -- do NOT collect
     credentials or write env vars (the lead handles those)

Wait for both B1 subagents to return.

**B1 manifest verification + recovery protocol:**
1. `test -f .claude/runs/agent-traces/scaffold-libs.json` -- verify manifest exists
2. Read manifest and check `"status": "complete"`
3. `ls src/lib/*.ts` -- verify lib files were created
4. If manifest is missing or status != complete:
   - Re-spawn scaffold-libs ONE time with the same prompt
   - Wait for completion and re-check manifest
   - If retry also fails -> **STOP** and report to user: "scaffold-libs failed after retry. Cannot proceed to Phase B2."

Check off in `.claude/runs/current-plan.md`:
- `- [x] scaffold-libs completed`
- `- [x] scaffold-externals completed`

**B1 type-check checkpoint** (mandatory -- run regardless of `tsp_status`):
Between B1 completion and B2 spawning, verify the lib files compile cleanly:
1. Run `npx tsc --noEmit --project tsconfig.json`
2. If type errors are found: fix them directly as the bootstrap lead (budget: 2 attempts).
   After each fix, re-run `npx tsc --noEmit --project tsconfig.json` to verify.
3. If errors persist after 2 fix attempts: **STOP**. Do not spawn B2 agents.
   Report to user: "Type errors in scaffold-libs output. Cannot proceed to page scaffold
   -- page agents would inherit broken types. Errors: [list errors]"
   This prevents compounding type failures across the B2 fan-out.

**Phase B2 (pages + landing -- web-app only):** Service and cli archetypes skip Phase B2. (Per `patterns/archetype-behavior-check.md`) Only after B1 manifest verification AND type-check checkpoint pass. Spawn one `scaffold-pages` agent per golden_path page (excluding landing -- handled by scaffold-landing). The agent-state-gate hook enforces this ordering: scaffold-pages and scaffold-landing are blocked until `.claude/runs/agent-traces/scaffold-libs.json` exists with status "complete".

Each per-page agent prompt:
- "Create SINGLE page: `<page_name>` at route `<route>`."
- Write ONLY to `src/app/<page_name>/` -- do NOT write to `src/components/` or `src/lib/`
- Write trace as `scaffold-pages-<page_name>.json`
- Read context files: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
  `.claude/runs/current-plan.md`, archetype file,
  framework/UI stack files, `.claude/patterns/design.md`,
  `.claude/runs/current-visual-brief.md`
- Follow CLAUDE.md Rules 3, 4, 6, 7, 9

**Scope guard -- MANDATORY DERIVATION**: Read `golden_path` from experiment.yaml NOW. Extract the unique page names (excluding landing). Write them as a numbered list below before spawning any agents. Spawn scaffold-pages agents for EXACTLY these pages -- no more, no fewer. Do NOT use the `pages:` field or any other source. BG2 check 3b will independently count pages on disk and BLOCK if actual count exceeds golden_path count.

**Per-page subagents (one per golden_path page, excluding landing):**
- subagent_type: scaffold-pages
- prompt per page: See scaffold-pages two-phase instructions above.

**Landing subagent (if surface != none):**
- subagent_type: scaffold-landing
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-landing.md` and execute all steps
  2. Read context files: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
     `.claude/runs/current-plan.md`, `.claude/archetypes/<type>.md`,
     framework/UI/surface stack files,
     `.claude/patterns/design.md`, `.claude/patterns/messaging.md`,
     `.claude/runs/current-visual-brief.md`,
     `src/app/globals.css` (theme tokens from init phase)
  3. Follow CLAUDE.md Rules 3, 4, 6, 7, 9

Wait for all B2 subagents to return.

After all return, merge per-page traces into `scaffold-pages.json`:

```bash
python3 -c "
import json, glob
batches = sorted(glob.glob('.claude/runs/agent-traces/scaffold-pages-*.json'))
if not batches:
    exit(1)
merged = {'agent': 'scaffold-pages', 'pages_created': 0, 'files_created': [], 'issues': []}
for b in batches:
    d = json.load(open(b))
    merged['pages_created'] += 1
    merged['files_created'].extend(d.get('files_created', []))
    merged['issues'].extend(d.get('issues', []))
json.dump(merged, open('.claude/runs/agent-traces/scaffold-pages.json', 'w'))
print(f'Merged {len(batches)} per-page traces into scaffold-pages.json')
"
```

**Post-fan-out trace verification** (before proceeding):
Verify each subagent produced its expected output:
- `test -f .claude/runs/agent-traces/scaffold-libs.json` (already verified in B1)
- `test -f .claude/runs/agent-traces/scaffold-pages-<page>.json` for each golden_path page
- Landing subagent reported completion: `test -f .claude/runs/agent-traces/scaffold-landing.json && python3 -c "import json;d=json.load(open('.claude/runs/agent-traces/scaffold-landing.json'));assert d.get('status')=='complete';print('scaffold-landing trace: OK')"`. If trace missing: log "WARN: scaffold-landing did not write trace -- continuing with file-based verification".

If any trace is missing or output was truncated: note the gap for STATE 13 to address.

**Post-fan-out disk audit** (verify files actually exist on disk -- traces alone are not proof):
- For each golden_path page (excluding landing): run `test -f src/app/<page_name>/page.tsx`.
  If the file is missing but the trace file exists (agent claimed success):
  - Re-create the page file directly as the bootstrap lead (budget: 1 attempt per page)
  - Use the trace's metadata and experiment.yaml context to generate the page
- If surface != none: run `test -f src/app/page.tsx` (or variant: `test -f src/components/landing-content.tsx`).
  If missing: re-create directly (budget: 1 attempt).
- Log any re-created files in the process checklist for visibility.

Check off in `.claude/runs/current-plan.md` for each completed B2 subagent:
- `- [x] scaffold-pages completed`
- `- [x] scaffold-landing completed` (or mark N/A if surface=none)

**POSTCONDITIONS:**
- All subagents returned completion reports
- `src/lib/` contains >=1 `.ts` file
- Page/route files created per archetype
- Externals classification available
- Landing page created (if surface != none)

**VERIFY:**
```bash
ls src/lib/*.ts && echo "libs OK" || echo "libs FAIL"
# Archetype-specific:
# web-app: test -f src/app/layout.tsx
# service: ls src/app/api/
# cli: test -f src/index.ts
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 11
```

**NEXT:** Read [state-12-externals-decisions.md](state-12-externals-decisions.md) to continue.

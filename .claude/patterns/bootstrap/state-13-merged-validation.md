# STATE 13: MERGED_VALIDATION

**PRECONDITIONS:**
- Externals done, BG2.5 PASS (STATE 12 POSTCONDITIONS met)

**ACTIONS:**

> **Archetype routing** (per `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table):
>
> | Concern | web-app | service | cli |
> |---------|---------|---------|-----|
> | Primary unit | page | endpoint | command |
> | Spec field | `golden_path` | `endpoints` | `commands` |
> | Skip | — | pages, landing, Fake Door | pages, API, landing, Fake Door |
> | Visual agents | full pipeline | skip | skip |
> | Analytics | client + server | server only | server only, opt-in |
>
> State-specific logic below takes precedence.

Run combined verification after all parallel subagents complete -- these checks catch compilation and semantic issues:

1. **Build**: run `npm run build` -- the project must compile
2. **Page/endpoint/command existence:** Verify each behavior's primary artifact exists per archetype. (Per `patterns/archetype-behavior-check.md`: web-app=`src/app/<page>/page.tsx` + landing, service=handler per framework stack file, cli=`src/commands/<cmd>.ts`)
3. **Analytics wiring** (if `stack.analytics` is present) -- systematic batch verification:
   - (a) Read `experiment/EVENTS.yaml` `events` map. Filter entries by `requires` (match
     current stack keys) and `archetypes` (match current archetype). This produces the
     canonical set of events that MUST be wired.
   - (b) Batch-grep all filtered event names in `src/` in a single pass:
     `grep -rn "event_name_1\|event_name_2\|..." src/` -- collect which events have
     tracking calls and which are missing.
   - (c) Group missing events by their target page (the page where the event should fire
     based on golden_path context). This groups fixes for efficient per-page editing.
   - (d) Fix missing events per-page. Budget: 2 fix attempts per page, max 5 pages.
     If a page exceeds 2 attempts, log the remaining missing events and move on.
   - (e) Verify `PROJECT_NAME` and `PROJECT_OWNER` in `src/lib/analytics*.ts` are not
     `"TODO"` -- run `grep -n 'TODO' src/lib/analytics*.ts`. Fix if found.
   - (f) After fix budget exhausted: any remaining missing events are listed in the PR
     description under a "Known gaps" section. Do not block the pipeline for these.
4. **Design tokens** (if archetype is `web-app`): verify `src/app/globals.css`
   contains a non-empty `--primary` custom property
5. **Favicon & OG image** (if archetype is `web-app`): verify `src/app/icon.tsx`
   and `src/app/opengraph-image.tsx` exist and export a default function returning
   `ImageResponse`. Fix directly if missing.
6. **Fake door integration** (if `externals-decisions.json` has non-empty `fake_doors`):
   for each fake door entry, verify the parent page.tsx contains both an import
   statement with `component_export_name` and a JSX render tag `<ComponentExportName`.
   Fix directly if missing.
7. **Content quality floor** (web-app only): discover all pages via filesystem scan
   (`find src/app -name 'page.tsx' | grep -v '/api/'`). For each discovered page, read page.tsx and check:
   - File has >=30 lines of JSX content (not just imports and boilerplate)
   - No `>TODO` or `"TODO:` patterns in rendered JSX strings
   - No sections consisting of only placeholder text or empty containers
   If any check fails: fix directly (budget: 1 attempt). WARN if unfixed.
8. **CTA presence** (web-app, landing only): verify landing page source (`src/app/page.tsx`
   or `src/components/landing-content.tsx`) contains at least one `<Button` or `<Link`
   element with non-empty text content. If missing: add a primary CTA to the hero section.
   Budget: 1 fix attempt.
9. **Internal href audit** (web-app only): extract all `href="/..."` values from all
   page files (`grep -roh 'href="/[^"]*"' src/app/*/page.tsx`). For each internal path,
   verify the target route has a corresponding page directory under `src/app/` or is a
   defined API route under `src/app/api/`. Exclude external URLs (`href="http`).
   If broken links found: fix the href to point to the correct route. Budget: 1 fix attempt.
10. **Cross-page token consistency** (web-app only): grep all page.tsx files for
   Tailwind arbitrary color values (`text-\[#`, `bg-\[#`, `border-\[#`). If any page uses
   arbitrary hex color values not traceable to the visual brief, replace with theme token
   classes (`text-primary`, `bg-secondary`, etc.). Budget: 1 fix attempt.
11. **SEO baseline** (web-app only):
   - Verify `src/app/layout.tsx` exports `metadata` with non-empty `title` and `description` (`grep -q 'export const metadata' src/app/layout.tsx`)
   - Verify `src/app/sitemap.ts` exists (`test -f src/app/sitemap.ts`)
   - Verify `src/app/robots.ts` exists (`test -f src/app/robots.ts`)
   - Verify `public/llms.txt` exists (`test -f public/llms.txt`)
   - Verify JSON-LD present in landing page or layout (`grep -rl 'application/ld+json' src/app/layout.tsx src/app/page.tsx src/components/landing-content.tsx 2>/dev/null`)
   Budget: 1 fix attempt.

If any check fails: the bootstrap lead fixes directly (it has full file access
as coordinator). Re-run `npm run build` after fixes. Budget: 2 fix attempts.
If still failing after 2 attempts: list all remaining errors and their file locations. Ask the user whether to (a) continue to wire phase and fix later, or (b) stop and investigate now.

Update checkpoint in `.runs/current-plan.md` frontmatter to `phase2-wire`.

Check off in `.runs/current-plan.md`: `- [x] Merged checkpoint validation passed`

**Scaffold trace audit** (informational -- does not block BG2):
```bash
python3 -c "
import json, glob
expected = ['scaffold-setup','scaffold-init','scaffold-libs','scaffold-landing','scaffold-wire']
traces = {}
for f in glob.glob('.runs/agent-traces/scaffold-*.json'):
    name = f.split('/')[-1].replace('.json','')
    if '-' in name and name.startswith('scaffold-pages'):
        continue
    try:
        d = json.load(open(f))
        traces[name] = d.get('status','unknown')
    except:
        traces[name] = 'error'
missing = [a for a in expected if a not in traces]
incomplete = [a for a,s in traces.items() if s != 'complete' and a in expected]
print(f'Scaffold audit: {len(traces)}/{len(expected)} traces found')
if missing: print(f'  Missing: {missing}')
if incomplete: print(f'  Incomplete: {incomplete}')
if not missing and not incomplete: print('  All scaffold agents completed with traces')
"
```

**POSTCONDITIONS:**
- `npm run build` passes (exit code 0)
- All pages/endpoints/commands exist per archetype
- Analytics wired (if applicable)
- Checkpoint updated to `phase2-wire`

**VERIFY:**
```bash
npm run build && echo "Build OK" || echo "Build FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 13
```

**NEXT:** Read [state-13a-bg2-gate.md](state-13a-bg2-gate.md) to continue.

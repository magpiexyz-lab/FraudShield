# STATE 11b: PAGE_SCAFFOLD

**PRECONDITIONS:**
- Lib scaffold done (STATE 11a POSTCONDITIONS met)
- Type-check passes
- `src/lib/` contains >=1 `.ts` file

**ACTIONS:**

#### Phase B2 (pages + landing -- web-app only)

Service and cli archetypes skip Phase B2 — proceed to STATE TRACKING to advance state immediately. (Per `patterns/archetype-behavior-check.md`)

Only after B1 manifest verification AND type-check checkpoint pass. Spawn one `scaffold-pages` agent per golden_path page (excluding landing -- handled by scaffold-landing). The skill-agent-gate hook enforces this ordering: scaffold-pages and scaffold-landing are blocked until `.runs/agent-traces/scaffold-libs.json` exists with status "complete".

Each per-page agent prompt:
- "Create SINGLE page: `<page_name>` at route `<route>`."
- Write ONLY to `src/app/<page_name>/` -- do NOT write to `src/components/` or `src/lib/`
- Write trace as `scaffold-pages-<page_name>.json`
- Read context files: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
  `.runs/current-plan.md`, archetype file,
  framework/UI stack files, `.claude/patterns/design.md`,
  `.runs/current-visual-brief.md`, `.runs/image-manifest.json`
- Follow CLAUDE.md Rules 3, 4, 6, 7, 9

**Scope guard -- MANDATORY DERIVATION**: Read `golden_path` from experiment.yaml NOW. Extract the unique page names (excluding landing). Write them as a numbered list below before spawning any agents. Spawn scaffold-pages agents for EXACTLY these pages -- no more, no fewer. Do NOT use the `pages:` field or any other source. BG2 check 3b will independently count pages on disk and BLOCK if actual count exceeds golden_path count.

**Per-page subagents (one per golden_path page, excluding landing):**
- subagent_type: scaffold-pages
- prompt per page: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-pages.md` and execute all steps
  2. Create SINGLE page: `<page_name>` at route `<route>`.
     Write ONLY to `src/app/<page_name>/` -- do NOT write to `src/components/` or `src/lib/`
     Write trace as `scaffold-pages-<page_name>.json`
  3. Read context files: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
     `.runs/current-plan.md`, archetype file,
     framework/UI stack files, `.claude/patterns/design.md`,
     `.runs/current-visual-brief.md`, `.runs/image-manifest.json`
  4. Follow CLAUDE.md Rules 3, 4, 6, 7, 9

**Landing subagent (if surface != none):**
- subagent_type: scaffold-landing
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-landing.md` and execute all steps
  2. Read context files: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
     `.runs/current-plan.md`, `.claude/archetypes/<type>.md`,
     framework/UI/surface stack files,
     `.claude/patterns/design.md`, `.claude/patterns/messaging.md`,
     `.runs/current-visual-brief.md`, `.runs/image-manifest.json`,
     `src/app/globals.css` (theme tokens from init phase)
  3. Follow CLAUDE.md Rules 3, 4, 6, 7, 9

Wait for all B2 subagents to return.

After all return, merge per-page traces into `scaffold-pages.json`:

```bash
python3 -c "
import json, glob
batches = sorted(glob.glob('.runs/agent-traces/scaffold-pages-*.json'))
if not batches:
    exit(1)
merged = {'agent': 'scaffold-pages', 'pages_created': 0, 'files_created': [], 'issues': []}
for b in batches:
    d = json.load(open(b))
    merged['pages_created'] += 1
    merged['files_created'].extend(d.get('files_created', []))
    merged['issues'].extend(d.get('issues', []))
json.dump(merged, open('.runs/agent-traces/scaffold-pages.json', 'w'))
print(f'Merged {len(batches)} per-page traces into scaffold-pages.json')
"
```

**Post-fan-out trace verification** (before proceeding):
Verify each subagent produced its expected output:
- `test -f .runs/agent-traces/scaffold-libs.json` (already verified in STATE 11a)
- `test -f .runs/agent-traces/scaffold-pages-<page>.json` for each golden_path page
- Landing subagent reported completion: `test -f .runs/agent-traces/scaffold-landing.json && python3 -c "import json;d=json.load(open('.runs/agent-traces/scaffold-landing.json'));assert d.get('status')=='complete';print('scaffold-landing trace: OK')"`. If trace missing: log "WARN: scaffold-landing did not write trace -- continuing with file-based verification".

If any trace is missing or output was truncated: note the gap for STATE 13 to address.

**Post-fan-out disk audit** (verify files actually exist on disk -- traces alone are not proof):
- For each golden_path page (excluding landing): run `test -f src/app/<page_name>/page.tsx`.
  If the file is missing but the trace file exists (agent claimed success):
  - Re-create the page file directly as the bootstrap lead (budget: 1 attempt per page)
  - Use the trace's metadata and experiment.yaml context to generate the page
- If surface != none: run `test -f src/app/page.tsx` (or variant: `test -f src/components/landing-content.tsx`).
  If missing: re-create directly (budget: 1 attempt).
- Log any re-created files in the process checklist for visibility.

Check off in `.runs/current-plan.md` for each completed B2 subagent:
- `- [x] scaffold-pages completed`
- `- [x] scaffold-landing completed` (or mark N/A if surface=none)

**POSTCONDITIONS:**
- All subagents returned completion reports <!-- enforced by agent behavior, not VERIFY gate -->
- Page/route files created per archetype (web-app: layout.tsx; service: api/; cli: index.ts)
- Landing page created (if surface != none) <!-- enforced by agent behavior, not VERIFY gate -->

**VERIFY:**
```bash
python3 -c "import json,os,glob; a=json.load(open('.runs/bootstrap-context.json')).get('archetype','web-app'); assert (a!='web-app' or os.path.isfile('src/app/layout.tsx')), 'web-app missing layout.tsx'; assert (a!='service' or os.path.isdir('src/app/api')), 'service missing api/'; assert (a!='cli' or any(os.path.isfile(f) for f in ['src/index.ts','src/cli.ts'])), 'cli missing entry'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 11b
```

**NEXT:** Read [state-12-externals-decisions.md](state-12-externals-decisions.md) to continue.

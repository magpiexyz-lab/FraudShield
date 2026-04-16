# STATE 3a: DESIGN_AGENTS

**PRECONDITIONS:** All Phase 1 traces exist (hook-enforced by `skill-agent-gate.sh`).

**ACTIONS:**

Spawn edit-capable agents ONE AT A TIME. Each must complete and pass `npm run build` before the next is spawned. This prevents write conflicts.

> **Trace integrity**: Per-page design-critic agents MUST be spawned via the Agent
> tool. The state-completion-gate cross-references trace files against the spawn
> audit log — traces without matching Agent spawns will be blocked. Do NOT write
> trace files directly. For recovery traces, use `bash .claude/scripts/write-recovery-trace.sh`.

After each edit-capable agent completes, read its completion report and append its fixes to `.runs/fix-log.md`.

> **Shared algorithms:** Before each edit-capable agent spawn, execute [Atomic Execution Protocol](../verify.md#atomic-execution-protocol) snapshot. After each agent returns, use [Trace State Detection](../verify.md#trace-state-detection) and [Exhaustion Protocol](../verify.md#exhaustion-protocol) to handle the result.

### design-critic (if scope is `full` or `visual`, AND archetype is `web-app`) — PARALLEL PER PAGE

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, row "Visual agents".
>
> web-app: design-critic (per-page parallel) | service: skip | cli: skip

#### Pre-flight: Thin-wrapper detection and claim assignment

Before spawning any design-critic agents, detect pages whose visual content
lives entirely in shared components and assign those components as "claims."
This ensures thin-wrapper pages (e.g., landing pages with variants) receive
full visual review instead of fast-pathing with an empty boundary.

1. Compute the PR file boundary: `git diff --name-only $(git merge-base HEAD main)...HEAD`
2. For each discovered page file `src/app/<page>/page.tsx`:
   - Compute `PR_file_boundary ∩ src/app/<page>/**`. If non-empty, skip (page has page-local files in PR).
   - Read the page file. Extract all imports from `src/components/` or `src/lib/`
     using regex: `from ['"](@/components/|@/lib/|../components/|../lib/)(.*?)['"]`
   - Resolve `@/` alias to `src/` to get full paths
   - Intersect imported shared paths with `PR_file_boundary`
   - If intersection is non-empty: this page is a **thin wrapper with claimable dependencies**
3. **Assign claims (first-claimer-wins):** Sort candidate pages: root `/` (landing) first,
   then alphabetical by route. For each page, for each claimable shared dependency:
   - If not yet claimed by another page → assign to this page
   - If already claimed → skip (first claimer owns it)
4. **Write `.runs/design-claims.json`** before first agent spawn:
   ```json
   {
     "claims": {
       "src/components/landing-content.tsx": "landing"
     },
     "thin_wrappers": ["landing"]
   }
   ```
   If no thin wrappers detected: write with empty `claims` and `thin_wrappers` arrays.
   > **Backward compatible:** All downstream logic (gate validation, Stage 1c exclusion)
   > treats missing or empty `design-claims.json` as "no claims" — current behavior preserved.

#### Stage 1: Per-page review (parallel)

Discover **all** pages — not just golden_path pages:

1. Scan the filesystem for all page files:
   ```bash
   find src/app -name 'page.tsx' -o -name 'page.jsx' -o -name 'page.ts' -o -name 'page.js' 2>/dev/null | grep -v '/api/' | sort
   ```
2. Read `golden_path` pages from experiment.yaml for route metadata.
3. Merge: for each discovered page file, derive the route from its path (e.g., `src/app/settings/page.tsx` → `/settings`). Golden_path entries provide the canonical page name; filesystem-only pages use the directory name as the page name.
4. Deduplicate by route. The final list is the **union** of golden_path pages and filesystem pages.

Spawn **one design-critic agent per page**, ALL as parallel foreground Agent calls in a **SINGLE message**. Each agent prompt includes:
- Page name and route: "Review SINGLE page: `<page_name>` at route `<route>`."
- `base_url`: `http://localhost:3000` (from [Dev Server Preamble](../verify.md#dev-server-preamble-if-archetype-is-web-app))
- `run_id`: from verify-context.json
- Per-page file boundary with structured marker. Compute `PR_file_boundary ∩ src/app/<page>/**` — shared paths (`src/components/**`, `src/lib/**`) are explicitly EXCLUDED from per-page agents. Pass ONLY page-local files. Include in the prompt as a machine-parseable block:
  ```
  FILE_BOUNDARY_START
  src/app/<page>/page.tsx
  src/app/<page>/<page>-content.tsx
  FILE_BOUNDARY_END
  ```
  > **Hook-enforced:** `skill-agent-gate.sh` validates that no shared paths appear between these markers. The hook will BLOCK the agent spawn if shared paths are detected.
- **Claimed shared dependencies** (only for thin-wrapper pages with claims in `design-claims.json`):
  Include a SEPARATE machine-parseable block for claimed shared files. These are placed OUTSIDE
  the `FILE_BOUNDARY` markers:
  ```
  CLAIMED_SHARED_START
  src/components/landing-content.tsx
  CLAIMED_SHARED_END
  ```
  > **Semantics:** The agent MAY read and fix files listed in `CLAIMED_SHARED`. These are shared
  > components that this page visually depends on and that were changed in this PR. The agent
  > should review them in the context of this page's visual design.
  > **Hook-enforced:** `skill-agent-gate.sh` validates claimed paths against `.runs/design-claims.json`.
  > Unclaimed shared paths will BLOCK the agent spawn.
  > Pages without claims in `design-claims.json` do NOT receive this marker block.
- Context digest summary
- Image candidates sidecar path: For the **landing page** critic, include: "Image candidates sidecar: `.runs/image-candidates.json` — you have full read-write access for candidate evaluation in Step 5.5." For **all other pages**, include: "Image candidates sidecar: `.runs/image-candidates.json` (READ-ONLY context). Do NOT modify or act on candidates. Record image issues in your trace under `image_issues_for_landing`."
- Instruction to write trace as `design-critic-<page_name>.json`
- **Empty-boundary fast path**: If ALL files between `FILE_BOUNDARY_START` and `FILE_BOUNDARY_END`
  are empty (no page-local files in PR) **AND no `CLAIMED_SHARED_START`/`CLAIMED_SHARED_END` block
  is present**, execute a **fast-path review**: check whether any modified library files (`src/lib/**`)
  or shared components (`src/components/**`) from the full PR boundary are imported by this page.
  If no imports found, output `{"verdict":"pass","fast_path":true,"pages_reviewed":1,"min_score":10,
  "checks_performed":["import-chain-check"],"fixes_applied":0,"sections_below_8":0,
  "unresolved_sections":0}`. If imports found, fall back to standard screenshot + 8-criteria review
  for this page only.
  > **Thin-wrapper override:** If a `CLAIMED_SHARED` block IS present, do NOT fast-path even
  > if FILE_BOUNDARY is empty. The claimed shared files constitute the agent's review and edit
  > scope. Perform full screenshot + 8-criteria review, treating CLAIMED_SHARED files as in-scope
  > for fixes.
- Shared-component reporting instruction:
  > When you find issues in files outside BOTH your `FILE_BOUNDARY` AND your
  > `CLAIMED_SHARED` block (shared components in `src/components/` or `src/lib/`
  > that are NOT listed in either marker), record them in your trace:
  > - `"unresolved_shared": <count>` — number of unresolved issues in unclaimed shared files
  > - `"shared_issues": [{"file": "...", "section": "...", "description": "..."}]`
  > Do NOT attempt to fix these unclaimed files. They will be handled by a separate agent.
  > Files listed in your `CLAIMED_SHARED` block ARE in-scope — fix them directly and
  > count them in `fixes_applied`, not in `unresolved_shared`.

**Wait for all per-page agents to complete.**

After completion: use [Trace State Detection](../verify.md#trace-state-detection) to check **each** `design-critic-<page_name>.json` individually. If any agent is State 2 (exhausted), follow [Exhaustion Protocol](../verify.md#exhaustion-protocol) Tier 1 with reduced scope: "Focus on this page only." If State 1 (never started) and agent returned output, write a recovery trace.

#### Stage 1b: Orchestrator shared-component fixes (serial)

After all per-page agents complete AND before Stage 2 (consistency check):

1. Read each per-page trace. If any trace output mentions shared-component issues without fixing them (shared paths were excluded from boundary), the orchestrator applies those fixes serially, one file at a time.
2. Run `npm run build` after shared-component fixes. If build fails, fix (max 2 attempts).
3. Append each fix to `.runs/fix-log.md`: `Fix (design-critic-shared): <file> — <desc>`
4. If no shared-component issues reported: this step is a no-op.

#### Stage 1c: Shared-component design-critic agent (serial, conditional)

**Guard**: scope is `full` or `visual` AND archetype is `web-app` AND any per-page
trace has `unresolved_shared > 0` for **unclaimed** shared components (issues in shared
files that were NOT claimed by any per-page agent via `design-claims.json`). If all
reported shared issues are for claimed components, Stage 1c has no work — skip to Stage 2.

1. Collect reported-but-unfixed shared-component issues from all per-page traces:
   ```bash
   python3 -c "
   import json, glob
   issues = []
   for f in sorted(glob.glob('.runs/agent-traces/design-critic-*.json')):
       if 'design-critic-shared' in f: continue
       d = json.load(open(f))
       for si in d.get('shared_issues', []):
           issues.append(si)
   if issues: print(json.dumps(issues, indent=2))
   else: print('NONE')
   "
   ```
   If `NONE`: this step is a no-op. Skip to Stage 2.
2. Spawn a SINGLE `design-critic` agent (`subagent_type: design-critic`) with:
   - Trace name: `design-critic-shared.json`
   - File boundary: INVERTED — ONLY `src/components/**` and `src/lib/**` files from the PR boundary,
     **MINUS paths claimed in `.runs/design-claims.json`**. Claimed components were already
     reviewed and fixed by their claiming page's agent.
     ```bash
     # Compute Stage 1c boundary (exclude claimed components)
     python3 -c "
     import json
     claims = {}
     try: claims = json.load(open('.runs/design-claims.json')).get('claims', {})
     except: pass
     pr_shared = [f for f in PR_FILES if f.startswith('src/components/') or f.startswith('src/lib/')]
     unclaimed = [f for f in pr_shared if f not in claims]
     for f in unclaimed: print(f)
     "
     ```
     Include only the **unclaimed** files in the FILE_BOUNDARY:
     ```
     FILE_BOUNDARY_START
     <unclaimed src/components/... files>
     <unclaimed src/lib/... files>
     FILE_BOUNDARY_END
     ```
     > **Empty-after-claims guard:** If ALL shared files from the PR are claimed (unclaimed
     > list is empty), Stage 1c has no work to do. Skip to Stage 2.
   - Input: the collected shared-component issues from step 1
   - Task: "Fix ONLY the shared-component visual issues reported by per-page agents. Do NOT perform a full design review — focus on the specific issues listed."
   - Include `run_id`, context digest, and agent-prompt-footer content
3. After completion: use [Trace State Detection](../verify.md#trace-state-detection) on `design-critic-shared.json`. If State 2 (exhausted), follow [Exhaustion Protocol](../verify.md#exhaustion-protocol) Tier 1 with reduced scope: "Fix only the highest-impact shared issue."
4. Run `npm run build`. If build fails, fix (max 2 attempts).
5. Append fixes to `.runs/fix-log.md`: `Fix (design-critic-shared): <file> — <desc>`

> **Hook-enforced:** `skill-agent-gate.sh` blocks `design-consistency-checker` spawn if per-page traces report shared-component issues but `design-critic-shared.json` does not exist.

**POSTCONDITIONS:**
- `.runs/design-claims.json` exists (may have empty `claims` if no thin wrappers detected)
- Per-page `design-critic-<page>.json` traces exist for all discovered pages (when scope is `full` or `visual` AND archetype is `web-app`)
- `design-critic-shared.json` exists if any per-page trace reported `unresolved_shared > 0` for unclaimed shared components
- Build passes after all Stage 1/1b/1c fixes

**VERIFY:**
```bash
python3 -c "import json,glob,os; ctx=json.load(open('.runs/verify-context.json')); needs_dc=ctx.get('scope') in ('full','visual') and ctx.get('archetype')=='web-app'; assert not needs_dc or os.path.exists('.runs/design-claims.json'), 'design-claims.json missing (pre-flight must run before agent spawns)'; fs=glob.glob('.runs/agent-traces/design-critic-*.json') if needs_dc else []; assert not needs_dc or len(fs)>=1, 'no design-critic traces (scope=%s, archetype=%s)' % (ctx.get('scope'),ctx.get('archetype')); d=json.load(open(fs[0])) if fs else {}; assert not fs or ('exit_code' in d or 'verdict' in d), 'design-critic trace missing exit_code or verdict'; assert not fs or (isinstance(d.get('checks_performed'),list) and len(d.get('checks_performed',[]))>=3), 'checks_performed too shallow (%d) — suspected fabrication' % len(d.get('checks_performed',[])); assert not fs or d.get('pages_reviewed',0)>=1, 'pages_reviewed missing or zero'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 3a
```

**NEXT:** Read [state-3b-quality-gate.md](state-3b-quality-gate.md) to continue.

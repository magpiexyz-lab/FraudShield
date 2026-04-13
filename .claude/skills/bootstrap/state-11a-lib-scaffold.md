# STATE 11a: LIB_SCAFFOLD

**PRECONDITIONS:**
- Core scaffold done (STATE 11 POSTCONDITIONS met)
- Phase A sentinel exists (web-app) or Phase A skipped (service/cli)

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.

#### Phase B1 (libs + externals + images)

Spawn scaffold-libs, scaffold-externals, and (conditionally) scaffold-images in parallel. These have no cross-dependency. scaffold-pages and scaffold-landing are NOT spawned yet -- they depend on libs output.

**Libs subagent:**
- subagent_type: scaffold-libs
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-libs.md` and execute all steps
  2. Read context files: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
     `.runs/current-plan.md`, all stack files
  3. Follow CLAUDE.md Rules 3, 4, 6, 7

**Externals subagent (analysis only):**
- subagent_type: scaffold-externals
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-externals.md` and execute the
     analysis steps (evaluate dependencies, classify core/non-core)
  2. Read context files: `experiment/experiment.yaml`, `.runs/current-plan.md`,
     `.claude/stacks/TEMPLATE.md`, existing stack files
  3. Follow CLAUDE.md Rules 3, 4, 6
  4. Return the classification table and Fake Door list -- do NOT collect
     credentials or write env vars (the lead handles those)

**Images subagent (conditional):**
Read `image_gen_status` from `.runs/bootstrap-context.json`.

If `image_gen_status` is `"available"`:
- subagent_type: scaffold-images
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/scaffold-images.md` and execute all steps
  2. Read context files: `experiment/experiment.yaml`,
     `.runs/current-visual-brief.md`, `.runs/current-plan.md`
  3. Follow CLAUDE.md Rules 3, 6
- Expected outputs: `.runs/image-manifest.json` (required), `.runs/image-candidates.json` (bonus — candidate sidecar for design-critic)

If `image_gen_status` is `"skipped"`:
Do NOT spawn the images subagent. Instead, the bootstrap lead generates
SVG placeholders directly:
1. Create `public/images/` directory
2. For each image in the file path contract (see `.claude/stacks/images/fal.md`):
   generate a themed SVG placeholder using the primary color from `globals.css`.
   Save as `.svg` files (e.g., `public/images/hero.svg`, `public/images/feature-1.svg`, etc.)
3. Write `.runs/image-manifest.json`:
   ```json
   {"status": "placeholders", "fallback": true, "images": [
     {"filename": "hero.svg", "publicPath": "/images/hero.svg", "altText": "Hero illustration", "width": 1920, "height": 1080, "fallback": true},
     {"filename": "feature-1.svg", "publicPath": "/images/feature-1.svg", "altText": "Feature illustration", "width": 800, "height": 600, "fallback": true},
     {"filename": "feature-2.svg", "publicPath": "/images/feature-2.svg", "altText": "Feature illustration", "width": 800, "height": 600, "fallback": true},
     {"filename": "feature-3.svg", "publicPath": "/images/feature-3.svg", "altText": "Feature illustration", "width": 800, "height": 600, "fallback": true},
     {"filename": "empty-state.svg", "publicPath": "/images/empty-state.svg", "altText": "Empty state illustration", "width": 400, "height": 400, "fallback": true}
   ]}
   ```

Wait for all B1 subagents to return (libs, externals, and images if spawned).

**B1 manifest verification + recovery protocol:**
1. `test -f .runs/agent-traces/scaffold-libs.json` -- verify manifest exists
2. Read manifest and check `"status": "complete"`
3. `ls src/lib/*.ts` -- verify lib files were created
4. If manifest is missing or status != complete:
   - Re-spawn scaffold-libs ONE time with the same prompt
   - Wait for completion and re-check manifest
   - If retry also fails -> **STOP** and report to user: "scaffold-libs failed after retry. Cannot proceed to Phase B2."

**B1 image manifest verification** (non-blocking):
1. `test -f .runs/image-manifest.json` -- verify manifest exists
2. Read manifest: if `"status"` is `"complete"` or `"placeholders"`, continue
3. If manifest is missing and `image_gen_status` is `"available"`:
   - Log `WARN: image generation did not complete -- falling back to SVG placeholders`
   - Generate SVG placeholders using the same logic as the `"skipped"` path above
   - Write manifest with `"status": "placeholders", "fallback": true`
4. Image generation failure NEVER blocks the pipeline

**B1 candidate sidecar verification** (non-blocking, informational only):
1. `test -f .runs/image-candidates.json` — check if candidate sidecar exists
2. If present: this is a bonus artifact. Pass it as context to design-critic agents alongside `image-manifest.json`. The design-critic can try pre-generated candidates before regenerating from scratch.
3. If absent: design-critic operates with the current single-image flow (fully backwards compatible). No action needed.

Check off in `.runs/current-plan.md`:
- `- [x] scaffold-libs completed`
- `- [x] scaffold-externals completed`
- `- [x] scaffold-images completed` (or mark N/A if `image_gen_status` was `"skipped"`)

**B1 type-check checkpoint** (mandatory -- run regardless of `tsp_status`):
Between B1 completion and B2 spawning, verify the lib files compile cleanly:
1. Run `npx tsc --noEmit --project tsconfig.json`
2. If type errors are found: fix them directly as the bootstrap lead (budget: 2 attempts).
   After each fix, re-run `npx tsc --noEmit --project tsconfig.json` to verify.
3. If errors persist after 2 fix attempts: **STOP**. Do not spawn B2 agents.
   Report to user: "Type errors in scaffold-libs output. Cannot proceed to page scaffold
   -- page agents would inherit broken types. Errors: [list errors]"
   This prevents compounding type failures across the B2 fan-out.

**POSTCONDITIONS:**
- `src/lib/` contains >=1 `.ts` file
- Externals classification available
- Image manifest written (complete, placeholders, or skipped)
- Type-check passes (`npx tsc --noEmit` exit 0)

**VERIFY:**
```bash
python3 -c "import json,glob; assert len(glob.glob('src/lib/*.ts'))>=1, 'no .ts in src/lib/'" && (test ! -f .runs/image-manifest.json || python3 -c "import json; m=json.load(open('.runs/image-manifest.json')); s=m.get('status'); assert s in ('complete','placeholders','skipped'), f'bad status: {s}'; ic=len(m.get('images',[])); assert s!='complete' or ic>=7, f'expected >=7 images, got {ic}'")
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 11a
```

**NEXT:** Read [state-11b-page-scaffold.md](state-11b-page-scaffold.md) to continue.

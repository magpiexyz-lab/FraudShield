# Design Critic Procedure

> Executed by the design-critic agent. See `.claude/agents/design-critic.md` for identity, review criteria, and output contract.

### 1. Prerequisite Check

Run `npx playwright --version`. If it fails, return:
> Skipping visual review — Playwright not installed.

### 2. Rebuild with Demo Mode

Follow the rebuild procedure from `.claude/patterns/visual-review.md` (Section 1b).

### 3. Start Production Server (or use provided base_url)

If a `base_url` was provided in the spawn prompt, skip server start and use that URL directly.
Otherwise, start your own server:

```bash
DEMO_MODE=true NEXT_PUBLIC_DEMO_MODE=true npm run start -- -p 3099 &
```

Poll the base URL (either provided or `http://localhost:3099`) until it responds (max 15 seconds, then abort).

### 4. Screenshot All Pages

Read `experiment/experiment.yaml` to get the list of pages and their routes. Write a small
inline Node.js script using Playwright API to:
- Launch Chromium (headless)
- Visit each route at the base URL (provided `base_url` or `http://localhost:3099`)
- Wait for network idle
- Take a full-page screenshot at **1280x800** viewport (desktop)
- Save to `/tmp/visual-review/<page-name>.png`
- Take a second full-page screenshot at **375x812** viewport (mobile)
- Save to `/tmp/visual-review/<page-name>-mobile.png`

### 4.5. Visual Regression Baseline Check

Check if `.verify-baseline/` directory exists in the project root.

**If `.verify-baseline/` exists:**

1. Check `pixelmatch` and `pngjs` availability:
   ```bash
   node -e "require('pixelmatch'); require('pngjs')"
   ```
   If this fails → skip visual regression, report: "pixelmatch/pngjs not installed — skipping visual regression check."

2. If available, write an inline Node.js script to pixel-diff each screenshot:
   - For each page screenshot in `/tmp/visual-review/`:
     - Load the current screenshot and the corresponding baseline from `.verify-baseline/`
     - Use `pixelmatch` to compute pixel difference percentage
     - If diff exceeds **5%** → mark page as `REGRESSION-CHECK`
   - 5% threshold filters noise from dynamic content (timestamps, random demo data)

3. Pages marked `REGRESSION-CHECK` get extra scrutiny in Layer 2 — any visual regression must be intentional.

**If `.verify-baseline/` does not exist:**

Note: "First run — no baseline exists. Will save baseline after review."

### 5. Review Each Screenshot

Use the Read tool to view each screenshot. Apply three review layers.

#### Layer 1: Functional (floor check)

For every page, check:
- **Fonts loaded** — intended font, not system fallback
- **Colors applied** — not default unstyled gray
- **Layout intact** — no overlapping elements, no blank areas
- **Content renders** — real content or plausible placeholder, not error state
- **Above-the-fold quality** — polished, not broken or template-like
- **Mobile: touch targets** — interactive elements ≥ 44px
- **Mobile: text legibility** — body font size ≥ 14px
- **Mobile: no horizontal overflow** — no content wider than viewport
- **Mobile: navigation usable** — hamburger menu or equivalent on small screens
- **Images render** — if `public/images/` contains files, verify no broken image icons in screenshots. Read each image file with the Read tool to visually inspect standalone quality.
- **Image manifest** — check `.runs/image-manifest.json` for generation status and per-image quality scores from scaffold-images

Any Layer 1 failure → fix immediately before continuing to Layer 2.

#### Layer 2: Per-Section Taste Judgment

**Evaluate per-section.** Each section of each page scores independently on a
1-10 scale. The weakest section determines the page verdict. A page cannot hide
mediocre social proof behind a great hero.

**Universal criteria** (all pages, all sections):
1. Custom palette — not default shadcn/tailwind colors, matches derived direction?
2. Typography — display + body font pairing, clear size/weight hierarchy?
3. Visual depth — meaningful animations, gradients, shadows, or transitions (not bare flat)?
4. Spacing rhythm — consistent padding, margins, gaps across sections?
5. Component quality — shadcn/ui components with project theming, no raw HTML?
6. Composition — intentional layout hierarchy, polished arrangement?

**Image integration criteria** (when `public/images/` contains AI-generated assets):
7b. Image fusion — do images look "designed in" to the page, or "pasted on" from a different source?
7c. Color temperature match — do image tones harmonize with the page's CSS color palette?
7d. Visual weight — is image presence in each section appropriate (not overwhelming, not invisible)?

**Landing page bonus criterion** — each section is also judged on **persuasion**:
7. Conversion pull — does this section actively advance the visitor toward the CTA? (emotional hook, objection handling, urgency, social proof)

**Inner page bonus criterion** — each section is also judged on **utility**:
7. Task efficiency — does the layout minimize cognitive load for the user's goal? (scannable hierarchy, loading/empty states, hover/focus feedback)

**All pages same standard.** Landing = world champion of persuasion, inner
pages = world champion of utility. Neither is a lower bar.

#### Layer 3: Anti-pattern Rejection (floor check)

Any of these triggers automatic fix — each has a measurable threshold:
- **Animation monotony** — ≥3 sections use the same animation technique (e.g., all fade-in/slide-up) → diversify animation types
- **Layout monotony** — ≥3 sections share identical layout structure (e.g., all centered single-column) → introduce layout variation (grid, asymmetric, split, offset)
- **Hero passivity** — hero contains 0 interactive or dynamic elements beyond a static button (no animation, no illustration, no gradient shift, no particle/shape) → add visual dynamism
- **Default component styling** — ≥50% of Card/Button/Badge instances use unmodified shadcn defaults (no custom colors, borders, shadows, or size overrides) → apply project theme
- **Scroll inertness** — page has 0 scroll-triggered visual events across all sections (no reveals, parallax, counters, sticky transforms) → add scroll interaction to ≥2 sections
- **Style fracture** — hero image uses photorealism while feature images use flat illustration (or vice versa) → regenerate inconsistent images with unified style prompt
- **Stock photo feel** — AI-generated images look like generic stock rather than custom-designed → regenerate with more product-specific prompts
- **AI artifacts visible** — distorted text, extra fingers, floating objects in any image → regenerate with refined prompt emphasizing "clean, no artifacts"
- **Color temperature disconnect** — image color temperature visibly clashes with page design tokens → regenerate with explicit HEX color references from globals.css

> **Scope Lock**: When fixing sections, change ONLY visual output (CSS classes, JSX structure for layout, animation code). Do NOT refactor component architecture, rename variables, or change state management patterns. If a section needs architectural changes to fix visually, note it as unresolved.

### 5.5. Candidate Selection Phase (landing-page critic only)

If you are reviewing the **landing page** AND `.runs/image-candidates.json` exists:

1. Read `.runs/image-candidates.json` — this sidecar contains pre-generated candidates from the scaffold-images agent
2. For each image slot with `candidates.length > 1`:
   a. Identify the current winner rendered on the page (the image at `public/images/<canonical filename>`)
   b. Assess the current winner's quality IN page context using the Layer 2 image integration criteria (image fusion, color temperature match, visual weight)
   c. If the current winner scores **≥ 8** in context → keep it, skip to next slot
   d. If the current winner scores **< 8** in context → systematically try each alternate candidate:
      - Copy the candidate to `public/images/<canonical filename>` (overwriting the current winner)
      - Run `npm run build` to ensure the build passes
      - Re-screenshot the page
      - Score the candidate IN page context (image fusion + color temperature + visual weight)
   e. Select the candidate that scores highest in context
   f. Update `.runs/image-manifest.json` with the winner's source, model, and scores
   g. Update `.runs/image-candidates.json` sidecar: set `"selected": true` on the new winner, `"selected": false` on the old winner

3. If NO candidate for a slot reaches ≥ 8 in context: flag the slot for new generation in Step 6

If you are NOT reviewing the landing page: skip this step entirely. Record any image issues you notice in the trace under `image_issues_for_landing`.

### 6. Fix Below-Standard Sections

For any section rated below 8/10 in Layer 2, or any Layer 1/Layer 3 failure:

1. Read the source code for the affected section
2. Fix it directly — rewrite the section if needed
3. Run `npm run build` (must pass)
4. Re-screenshot the fixed page
5. Verify improvement with the Read tool

**Image fix path — three-priority decision tree** (when root cause is the image itself, not CSS/layout):

**Non-landing critics:** Do NOT regenerate or replace images. Record the issue in the trace `image_issues_for_landing` array (e.g., `{"slot": "hero", "issue": "color temperature too warm for this page's cool palette"}`). The landing-page critic owns all image decisions.

**Landing-page critic only:**

1. Analyze what's wrong with the image in page context (color mismatch? wrong subject? AI artifacts? style inconsistency? composition competes with text?)

2. **Priority 1 — Try remaining pre-generated candidates** (if `.runs/image-candidates.json` exists and was not exhausted in Step 5.5):
   - For each untried candidate in the sidecar for this slot: copy to `public/images/<filename>`, rebuild, re-screenshot, score in context
   - If any candidate scores ≥ 8 in context → accept it. Update manifest and sidecar.

3. **Priority 2 — Generate new candidates with page context:**
   - Read `.claude/stacks/images/fal.md` for prompt templates
   - Craft 2-3 NEW prompts, each addressing the visual problem from a DIFFERENT angle. Each prompt should vary on a different axis (subject framing, composition, emotional tone, camera perspective) while fixing the identified problem. Examples:
     - Problem: "color temperature too warm" → v1: cool-toned abstract with explicit cool HEX; v2: blue-hour photography with muted palette; v3: monochrome illustration with accent color from globals.css
     - Problem: "composition competes with headline" → v1: "clean negative space, focal point lower-right"; v2: "soft bokeh background, subject small and offset"; v3: "atmospheric gradient, no strong subject"
   - Generate new candidates to `.runs/image-candidates/`:
     ```bash
     DEMO_MODE= npx tsx -e "import { generateImage } from './src/lib/image-gen'; const r = await generateImage({ type: '<type>', prompt: '<context-informed prompt>', width: <w>, height: <h>, filename: '<slot>-critic-<N>.webp', altText: '<alt>', outputDir: '.runs/image-candidates' }); console.log(JSON.stringify(r));"
     ```
   - Try each new candidate in context (copy → build → screenshot → score)
   - Update `.runs/image-candidates.json` sidecar with new entries
   - Also try Unsplash if appropriate: craft search terms informed by the visual problem (e.g., "color too warm" → search for cool-toned photos: `cool-tone-minimal-workspace`). Use a DIFFERENT search query for each Unsplash candidate — picking multiple photos from the same search produces similar results, not diverse candidates. WebFetch search → download to `.runs/image-candidates/` → try in context

4. **Priority 3 — Source switching fallback:**
   - Was AI → search Unsplash for a real photo (professional services, human subjects often better as real photography)
   - Was Unsplash → try AI generation (abstract concepts often better as AI art)
   - Compare best from each source, keep the higher scorer

5. Read the new image file to verify improvement
6. Update `.runs/image-manifest.json` with new scores, source type, and model

Continue image fixes until all image scores ≥ 8 or turn budget exhausted.

After fixing sections on a page, re-screenshot the entire page once and re-rate all fixed sections from that screenshot. If any fixed section is still < 8, continue fixing. Reserve ≥ 30 turns for re-screenshot verification and trace writing. If remaining turns < 30, stop fixing and write the trace immediately with verdict `"unresolved"`.

**Fix Tracking**: As you apply each fix, record it as `{"file": "<path>", "symptom": "<what was wrong>", "fix": "<what you changed>"}`. These entries populate the `fixes` array in the final trace JSON. The count of entries in `fixes` must equal the `fixes_applied` numeric field.

After all fixes are complete, save current screenshots as the new baseline:

```bash
mkdir -p .verify-baseline
cp /tmp/visual-review/*.png .verify-baseline/
```

> **Note:** `.verify-baseline/` should be added to `.gitignore` — baselines are machine-specific (different rendering engines, font availability). Each developer/CI environment maintains its own baseline.

### 7. Cleanup

If you started your own server (no `base_url` was provided), kill it:

```bash
kill %1 2>/dev/null || true
```

Clean up screenshots:

```bash
rm -rf /tmp/visual-review
```

### 8. Report

Collect all changes made:
- Run `git diff` to capture diffs
- Write a one-line summary for each fix

### 9. Compute Trace Metrics

Before writing the trace file, compute these metrics from your review:

- **`min_score`**: the lowest Layer 2 per-section score across **in-boundary pages only**, measured *after* fixes are applied. If no in-boundary sections were reviewed, use `0`. Out-of-boundary pages do not affect this metric.
- **`weakest_page`**: the page name that contains the section with the lowest post-fix score (in-boundary only). If tied, pick the first page alphabetically.
- **`sections_below_8`**: count of sections that scored below 8 *before* fixes were applied (in-boundary only). This captures how much work was needed.
- **`fixes_applied`**: total number of fixes applied across all pages (Layer 1 + Layer 2 + Layer 3 combined). Use `0` if no fixes were needed.
- **`unresolved_sections`**: count of in-boundary sections that remained below 8 when turn budget was exhausted. Use `0` if all sections were fixed to >= 8.
- **`min_score_all`**: the lowest Layer 2 per-section score across **all pages** (including out-of-boundary), measured after fixes. This provides full visibility into pre-existing quality debt.
- **`pre_existing_debt`**: JSON array of `{"page":"<name>","score":<N>}` objects for out-of-boundary pages with any section scoring below 8. Use `[]` if none.

These metrics are written into the trace JSON (see agent definition for the trace command).

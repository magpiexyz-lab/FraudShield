# Scaffold: AI Image Generation (Multi-Model)

## Prerequisites
- Branch already created (by bootstrap Step 0)
- Plan approved and saved to `.runs/current-plan.md`
- Packages installed (by scaffold-setup agent)
- Visual brief written at `.runs/current-visual-brief.md` (by scaffold-init agent)
- `image_gen_status: "available"` in `.runs/bootstrap-context.json`
- Read all context files listed in your task assignment before starting

## Steps

### Step 1: Read context and derive visual system prefix
1. Read `.runs/current-visual-brief.md` — focus on **Image Direction** (all 7 sub-sections), **Color Palette**, and **Design Constraints**
2. Read `experiment/experiment.yaml` — extract `name`, `description`, `target_user`, and product domain
3. Read `.claude/stacks/images/fal.md` — study the model selection table, per-model prompt templates, and visual system prefix technique
4. **Derive the visual system prefix**: a 20-30 word shared style block from the visual brief's Color Palette + Image Direction. This prefix is appended to EVERY image prompt. Example:
   ```
   Warm natural light, soft directional shadows. Palette: cream #F5F0EB,
   sage green #87A878, terracotta #C67B5C. Clean minimal composition.
   Premium but approachable.
   ```
5. Extract RGB color values from the visual brief for Recraft models' `colors` API parameter

### Step 1b: Check image source strategy

Read `.runs/current-visual-brief.md` Image Direction → **Image source strategy** field.

- If `photography` or `mixed` with photography images:
  1. For each image marked for photography: use WebFetch (load via ToolSearch)
     to search `https://unsplash.com/s/photos/{search-terms}` with terms from
     the visual brief's Image Direction
  2. Select the most relevant photo, extract the photo ID from the page
  3. Download to `public/images/{filename}` via:
     ```bash
     curl -L "https://images.unsplash.com/photo-{ID}?auto=format&fit=crop&w={width}&q=80" \
       -o public/images/{filename}
     ```
  4. Self-evaluate the downloaded image (same 5 quality dimensions)
  5. Write manifest entry with `"source": "unsplash"` and `"unsplash_id": "{ID}"`

- If `illustration` or remaining AI-generated images in `mixed`:
  Continue with Steps 2-4 below (fal.ai generation)

### Step 1c: Create candidate staging directory

```bash
mkdir -p .runs/image-candidates
```

All candidate images are generated into `.runs/image-candidates/` first (not directly into `public/images/`). Only the winning candidate per slot is copied to `public/images/`.

### Step 2: Install package
```bash
npm install @fal-ai/client
```

### Step 3: Create image generation library
Create `src/lib/image-gen.ts` following the multi-model code template in `.claude/stacks/images/fal.md`.

### Step 4: Generate candidates with explore-exploit feedback loop

For each image slot, generate candidates in two phases: **explore** (maximize diversity to find the right direction) then **exploit** (refine the winning direction). Candidates are stored in `.runs/image-candidates/`; only the winner is copied to `public/images/`.

**Phase 1 (EXPLORE) — maximize diversity, find the right direction:**

| # | Filename | Type | Model | Dimensions | Explore | Sources |
|---|----------|------|-------|-----------|---------|---------|
| 1 | `hero.webp` | hero | FLUX.2 Pro | 1920x1080 | 3 | 2 AI prompt variants + 1 Unsplash |
| 2 | `feature-1.webp` | feature | Recraft V4 Pro | 800x600 | 2 | 1 AI + 1 Unsplash (ensemble anchor) |
| 3 | `feature-2.webp` | feature | Recraft V4 Pro | 800x600 | 2 | 1 AI + 1 Unsplash (style-match feature-1) |
| 4 | `feature-3.webp` | feature | Recraft V4 Pro | 800x600 | 2 | 1 AI + 1 Unsplash (style-match feature-1) |
| 5 | `logo.svg` | logo | Recraft V4 Vector | 512x512 | 3 | 3 AI variants (no Unsplash for logos) |
| 6 | `og-photo.webp` | og | Ideogram V3 | 1200x630 | 2 | 1 AI + 1 Unsplash |
| 7 | `empty-state.webp` | empty-state | Recraft V4 Pro | 400x400 | 2 | 1 AI + 1 Unsplash |

**Phase 2 (EXPLOIT) — refine the winning direction with AI-only variants:**

| # | Filename | Exploit | Notes |
|---|----------|---------|-------|
| 1 | `hero.webp` | 3 AI | Highest-impact slot, most refinement |
| 2 | `feature-1.webp` | 1 AI | Ensemble anchor refinement |
| 3 | `feature-2.webp` | 1 AI | Style-matched to feature-1 |
| 4 | `feature-3.webp` | 1 AI | Style-matched to feature-1 |
| 5 | `logo.svg` | 2 AI | Brand mark precision |
| 6 | `og-photo.webp` | 1 AI | Social sharing refinement |
| 7 | `empty-state.webp` | 0 | Low-frequency display — skip exploit |

**Execution order:** Process each slot sequentially — complete all three phases (explore → direction extraction → exploit → winner selection) for one slot before moving to the next. This is required because feature-1 must have a selected winner before feature-2/3 can begin (style anchor dependency). Process slots in table order (hero first, empty-state last).

#### Step 4.1 (EXPLORE) — diverse candidate generation

**For the current image slot:**

1. **Craft maximally diverse explore prompts.** Each AI candidate MUST vary on a DIFFERENT primary axis. Do not reuse the same axis within a slot:
   - **Subject framing**: aspirational lifestyle vs product in context vs abstract mood
   - **Composition**: centered subject vs rule-of-thirds vs wide establishing shot
   - **Emotional tone**: energetic vs calm vs professional vs playful
   - **Camera perspective**: eye-level vs overhead vs low-angle (for FLUX.2 Pro photorealism)
   
   Example for a fitness app hero (2 AI explore variants):
   - explore-1 (subject framing): "Woman mid-stride on a sunlit trail, golden hour backlight, rule-of-thirds, aspirational energy"
   - explore-2 (composition): "Aerial view of a runner on a coastal path, vast landscape, sense of freedom and possibility"
   
   All prompts share the visual system prefix for color/style consistency but MUST differ in primary axis.

2. **Generate AI explore candidates** into `.runs/image-candidates/`:
   ```bash
   npx tsx -e "
   import { generateImage } from './src/lib/image-gen';
   const result = await generateImage({
     type: '<image_type>',
     prompt: '<explore prompt variant>',
     width: <width>,
     height: <height>,
     filename: '<slot>-explore-<N>.webp',
     altText: '<descriptive alt text>',
     colors: [/* RGB from visual brief, for Recraft models */],
     outputDir: '.runs/image-candidates'
   });
   console.log(JSON.stringify(result));
   "
   ```

3. **Generate Unsplash explore candidates** (for slots with Unsplash budget in the Phase 1 table):
   - Use a DIFFERENT search query for each Unsplash candidate, emphasizing a different angle of the subject.
   - Use WebFetch (load via ToolSearch) for each search. Pick the single best photo from each search result page.
   - Using different search terms produces genuinely diverse candidates. Picking multiple photos from the same search produces similar-looking results — avoid this.
   - If WebFetch extraction fails for any search: reallocate that slot to an additional AI explore variant instead
   - Download each to `.runs/image-candidates/<slot>-explore-unsplash-<N>.webp`:
     ```bash
     curl -L "https://images.unsplash.com/photo-{ID}?auto=format&fit=crop&w={width}&q=80" \
       -o .runs/image-candidates/<slot>-explore-unsplash-<N>.webp
     ```

4. **View and score each explore candidate** using the Read tool:
   - Read `.runs/image-candidates/<slot>-explore-<N>.webp` to view
   - Self-evaluate against the 5 quality dimensions (subject, style, color, composition, polish)
   - Record scores for each candidate

#### Direction extraction (between explore and exploit)

**Skip this step for empty-state** (no exploit phase — proceed directly to winner selection from explore candidates).

After scoring all explore candidates for a slot, **derive the direction signal** for the exploit phase:

1. Identify the **top-2 scoring explore candidates** for this slot
2. Visually re-inspect both via the Read tool — look at the actual images, not just scores
3. Write a **direction signal** (15-20 words) that combines the strongest visual elements from the top-2: dominant color temperature, composition style, subject treatment, rendering technique, emotional register
4. Record the direction signal in the sidecar under the slot's metadata

This mechanism is identical to the feature ensemble style anchor — but applied per-slot rather than only to features. Example direction signal: "Aerial coastal perspective, warm golden hour, vast open composition, textured path detail, sense of freedom"

#### Step 4.2 (EXPLOIT) — direction-informed refinement

For each image slot with exploit budget (all except empty-state):

1. **Craft exploit prompts** that REFERENCE the direction signal. Each exploit prompt MUST:
   - Include specific visual elements named in the direction signal
   - Vary on SECONDARY axes only: lighting angle, material detail, perspective shift, edge treatment, depth of field
   - NOT change the primary direction (subject framing, composition style, emotional tone)
   
   Example for hero with direction signal "Aerial coastal perspective, warm golden hour, vast open composition, sense of freedom":
   - exploit-1 (lighting): "Aerial coastal path, late golden hour with long shadows, lens flare at horizon edge"
   - exploit-2 (detail): "Aerial coastal path, golden hour, textured sand and water detail, shallow depth tilt-shift"
   - exploit-3 (perspective): "Slightly lower aerial angle on coastal path, golden hour, runner small in frame, emphasizing scale"

2. **Generate AI exploit candidates** into `.runs/image-candidates/`:
   ```bash
   npx tsx -e "
   import { generateImage } from './src/lib/image-gen';
   const result = await generateImage({
     type: '<image_type>',
     prompt: '<exploit prompt — must reference direction signal>',
     width: <width>,
     height: <height>,
     filename: '<slot>-exploit-<N>.webp',
     altText: '<descriptive alt text>',
     colors: [/* RGB from visual brief, for Recraft models */],
     outputDir: '.runs/image-candidates'
   });
   console.log(JSON.stringify(result));
   "
   ```

3. **View and score each exploit candidate** using the Read tool (same 5 dimensions)

4. **Select the winner across BOTH phases.** Compare all explore AND exploit candidates for this slot, pick the highest-scoring one. Copy it to the canonical path:
   ```bash
   cp .runs/image-candidates/<winning-file> public/images/<canonical-filename>
   ```

5. **Feature ensemble selection** (feature-2 and feature-3 only):
   After selecting the feature-1 winner, derive a **style anchor prefix** from it — describe its visual characteristics (illustration style, color temperature, abstraction level, rendering technique) in 15-20 words. When generating feature-2 and feature-3 candidates (both explore AND exploit), prepend this style anchor prefix to every prompt. This ensures cross-feature consistency while still allowing per-feature subject diversity.

6. If the specialized model fails entirely, the `generateImage()` function automatically falls back to FLUX.2 Pro, then to SVG placeholder. Continue with the next slot.

7. **SVG post-processing (logo slot only):**
   After generating each SVG logo candidate, read the SVG source and remove any opaque white/near-white background rectangle that Recraft V4 Vector commonly adds:
   ```bash
   # Remove rect elements with white fill (common Recraft V4 Vector artifact)
   sed -i '' '/<rect[^>]*fill="\(#[Ff][Ff][Ff]\|#[Ff][Ff][Ff][Ff][Ff][Ff]\|white\)"[^>]*\/\?>/d' .runs/image-candidates/<logo-file>.svg
   ```
   After removal, verify the SVG still contains at least one visible path element and renders correctly by reading it with the Read tool. If the background rect was part of an intentional design element (the SVG looks broken after removal), restore the original and note the issue — the design-critic Layer 1 SVG transparency check will catch it in context.

### Step 4.3: Completeness Check

Before writing the manifest, verify all images from the Phase 1 table exist on disk:

1. Count image files in `public/images/` — must equal the row count from the Phase 1 table (7 images)
2. For each row in the table, verify the expected filename exists in `public/images/`:
   - `hero.webp`, `feature-1.webp`, `feature-2.webp`, `feature-3.webp`, `logo.svg`, `og-photo.webp`, `empty-state.webp`
3. If any image is missing, generate it now using the same explore-exploit cycle from Steps 4.1-4.2 before proceeding

Do NOT proceed to Step 5 until all images are present on disk.

### Step 5: Write manifest
Write `.runs/image-manifest.json`:
```json
{
  "status": "complete",
  "fallback": false,
  "images": [
    {
      "filename": "<actual filename>",
      "publicPath": "/images/<actual filename>",
      "altText": "<descriptive alt text>",
      "width": <width>,
      "height": <height>,
      "fallback": <true if SVG placeholder>,
      "model": "<model ID used>",
      "source": "<fal | unsplash | placeholder>",
      "unsplash_id": "<photo ID if source is unsplash, null otherwise>",
      "score": {
        "subject": <1-10>,
        "style": <1-10>,
        "color": <1-10>,
        "composition": <1-10>,
        "polish": <1-10>
      },
      "retries": <number of retries across all sources>
    }
  ]
}
```
Set `"fallback": true` at top level if ALL images fell back to SVG.

### Step 5b: Write candidate sidecar

Write `.runs/image-candidates.json` with metadata for ALL candidates generated (winners and runners-up):
```json
{
  "generated_at": "<ISO 8601>",
  "strategy": "explore-exploit",
  "total_candidates": <total across all slots>,
  "slots": {
    "hero": {
      "candidates": [
        {
          "path": ".runs/image-candidates/hero-explore-1.webp",
          "source": "fal",
          "model": "fal-ai/flux-2-pro",
          "phase": "explore",
          "prompt_variant": "<short description of prompt focus>",
          "score": { "subject": <1-10>, "style": <1-10>, "color": <1-10>, "composition": <1-10>, "polish": <1-10> },
          "selected": false
        },
        {
          "path": ".runs/image-candidates/hero-explore-unsplash-1.webp",
          "source": "unsplash",
          "unsplash_id": "<photo ID>",
          "phase": "explore",
          "score": { "subject": <1-10>, "style": <1-10>, "color": <1-10>, "composition": <1-10>, "polish": <1-10> },
          "selected": false
        },
        {
          "path": ".runs/image-candidates/hero-exploit-1.webp",
          "source": "fal",
          "model": "fal-ai/flux-2-pro",
          "phase": "exploit",
          "prompt_variant": "<refinement of winning direction>",
          "score": { "subject": <1-10>, "style": <1-10>, "color": <1-10>, "composition": <1-10>, "polish": <1-10> },
          "selected": true
        }
      ],
      "winner_index": 2,
      "direction_signal": "<15-20 word description of winning visual direction>"
    },
    "feature-1": {
      "candidates": ["..."],
      "winner_index": 0,
      "ensemble_anchor": true,
      "direction_signal": "<direction signal>"
    },
    "feature-2": {
      "candidates": ["..."],
      "winner_index": 0,
      "style_matched_to": "feature-1",
      "direction_signal": "<direction signal>"
    },
    "feature-3": {
      "candidates": ["..."],
      "winner_index": 0,
      "style_matched_to": "feature-1",
      "direction_signal": "<direction signal>"
    },
    "logo": { "candidates": ["..."], "winner_index": 0, "direction_signal": "<direction signal>" },
    "og-photo": { "candidates": ["..."], "winner_index": 0, "direction_signal": "<direction signal>" },
    "empty-state": { "candidates": ["..."], "winner_index": 0, "direction_signal": null }
  }
}
```

The sidecar is consumed by the design-critic agent during `/verify`. If the design-critic finds the winner unsuitable in page context, it can try alternate candidates from this pool before regenerating from scratch.

### Step 6: Write trace
Write `.runs/agent-traces/scaffold-images.json`:
```json
{
  "agent": "scaffold-images",
  "status": "complete",
  "files_created": ["public/images/hero.webp", "..."],
  "issues": [],
  "image_count": 7,
  "fallback_count": 0,
  "total_candidates": <total across all slots>,
  "candidates_per_slot": { "hero": 6, "feature-1": 3, "feature-2": 3, "feature-3": 3, "logo": 5, "og-photo": 3, "empty-state": 2 },
  "phases_executed": ["explore", "exploit"],
  "explore_candidates_count": 16,
  "exploit_candidates_count": 9,
  "direction_signals": { "hero": "<signal>", "feature-1": "<signal>", "feature-2": "<signal>", "feature-3": "<signal>", "logo": "<signal>", "og-photo": "<signal>", "empty-state": null },
  "weakest_image": "<filename>",
  "weakest_score": <min score across all dimensions and images>,
  "total_retries": <sum of retries across all images>,
  "models_used": ["fal-ai/flux-2-pro", "fal-ai/recraft/v4/pro/text-to-image", "..."]
}
```

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

### Step 4: Generate candidates with visual feedback loop (Compete & Shortlist)

For each image slot, generate **multiple diverse candidates**, score each, and select the best. Candidates are stored in `.runs/image-candidates/`; only the winner is copied to `public/images/`.

**Tiered generation order** (sequential per slot, respect rate limits):

| # | Filename | Type | Model | Dimensions | Candidates | Sources |
|---|----------|------|-------|-----------|-----------|---------|
| 1 | `hero.webp` | hero | FLUX.2 Pro | 1920x1080 | 5 | 3 AI prompt variants + 2 Unsplash |
| 2 | `feature-1.webp` | feature | Recraft V4 Pro | 800x600 | 3 | 2 AI + 1 Unsplash (ensemble anchor) |
| 3 | `feature-2.webp` | feature | Recraft V4 Pro | 800x600 | 3 | 2 AI + 1 Unsplash (style-match feature-1) |
| 4 | `feature-3.webp` | feature | Recraft V4 Pro | 800x600 | 3 | 2 AI + 1 Unsplash (style-match feature-1) |
| 5 | `logo.svg` | logo | Recraft V4 Vector | 512x512 | 2 | 2 AI variants |
| 6 | `og-photo.webp` | og | Ideogram V3 | 1200x630 | 3 | 2 AI + 1 Unsplash |
| 7 | `empty-state.webp` | empty-state | Recraft V4 Pro | 400x400 | 2 | 1 AI + 1 Unsplash |

**Circuit breaker check** (before EACH image slot): If `turns_remaining < images_remaining × 8 + 20`, degrade to **single-candidate mode** for all remaining slots (generate one candidate per slot, skip multi-candidate). Track whether the circuit breaker triggered for the trace.

**For each image slot:**

1. **Craft diverse prompts.** For each AI candidate, write a DIFFERENT prompt variant. Diversity comes from varying these axes (pick a different axis for each variant):
   - **Subject framing**: aspirational lifestyle vs product in context vs abstract mood
   - **Composition**: centered subject vs rule-of-thirds vs wide establishing shot
   - **Emotional tone**: energetic vs calm vs professional vs playful
   - **Camera perspective**: eye-level vs overhead vs low-angle (for FLUX.2 Pro photorealism)
   
   Example for a fitness app hero (3 AI variants):
   - v1: "Woman mid-stride on a sunlit trail, golden hour backlight, rule-of-thirds, aspirational energy"
   - v2: "Close-up of hands checking a fitness tracker, morning light, shallow depth of field, calm focus"
   - v3: "Aerial view of a runner on a coastal path, vast landscape, sense of freedom and possibility"
   
   All prompts share the visual system prefix for color/style consistency but differ in subject, composition, and mood.

2. **Generate AI candidates** into `.runs/image-candidates/`:
   ```bash
   npx tsx -e "
   import { generateImage } from './src/lib/image-gen';
   const result = await generateImage({
     type: '<image_type>',
     prompt: '<prompt variant>',
     width: <width>,
     height: <height>,
     filename: '<slot>-v<N>.webp',
     altText: '<descriptive alt text>',
     colors: [/* RGB from visual brief, for Recraft models */],
     outputDir: '.runs/image-candidates'
   });
   console.log(JSON.stringify(result));
   "
   ```

3. **Generate Unsplash candidates** (for slots with Unsplash budget):
   - For each Unsplash candidate, use a DIFFERENT search query emphasizing a different angle of the subject. Examples for a hero image of a fitness app:
     - Unsplash-1: `https://unsplash.com/s/photos/woman-running-sunrise` (aspirational action shot)
     - Unsplash-2: `https://unsplash.com/s/photos/fitness-lifestyle-minimal` (lifestyle mood)
   - Use WebFetch (load via ToolSearch) for each search. Pick the single best photo from each search result page.
   - Using different search terms produces genuinely diverse candidates. Picking multiple photos from the same search produces similar-looking results — avoid this.
   - If WebFetch extraction fails for any search: reallocate that slot to an additional AI prompt variant instead
   - Download each to `.runs/image-candidates/<slot>-unsplash-<N>.webp`:
     ```bash
     curl -L "https://images.unsplash.com/photo-{ID}?auto=format&fit=crop&w={width}&q=80" \
       -o .runs/image-candidates/<slot>-unsplash-<N>.webp
     ```

4. **View and score each candidate** using the Read tool:
   - Read `.runs/image-candidates/<slot>-v<N>.webp` to view
   - Self-evaluate against the 5 quality dimensions (subject, style, color, composition, polish)
   - Record scores for each candidate

5. **Select the winner.** Compare all candidates for this slot, pick the highest-scoring one. Copy it to the canonical path:
   ```bash
   cp .runs/image-candidates/<winning-file> public/images/<canonical-filename>
   ```

6. **Feature ensemble selection** (feature-2 and feature-3 only):
   After selecting the feature-1 winner, derive a **style anchor prefix** from it — describe its visual characteristics (illustration style, color temperature, abstraction level, rendering technique) in 15-20 words. When generating feature-2 and feature-3 candidates, prepend this style anchor prefix to every prompt. This ensures cross-feature consistency while still allowing per-feature subject diversity.

7. If the specialized model fails entirely, the `generateImage()` function automatically falls back to FLUX.2 Pro, then to SVG placeholder. Continue with the next slot.

### Step 4b: Completeness Check

Before writing the manifest, verify all images from the Step 4 table exist on disk:

1. Count image files in `public/images/` — must equal the row count from the Step 4 table (7 images)
2. For each row in the table, verify the expected filename exists in `public/images/`:
   - `hero.webp`, `feature-1.webp`, `feature-2.webp`, `feature-3.webp`, `logo.svg`, `og-photo.webp`, `empty-state.webp`
3. If any image is missing, generate it now using the same prompt-craft-generate-evaluate cycle from Step 4 before proceeding

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
  "strategy": "compete-and-shortlist",
  "total_candidates": <total across all slots>,
  "circuit_breaker_triggered": false,
  "slots": {
    "hero": {
      "candidates": [
        {
          "path": ".runs/image-candidates/hero-v1.webp",
          "source": "fal",
          "model": "fal-ai/flux-2-pro",
          "prompt_variant": "<short description of prompt focus>",
          "score": { "subject": <1-10>, "style": <1-10>, "color": <1-10>, "composition": <1-10>, "polish": <1-10> },
          "selected": true
        },
        {
          "path": ".runs/image-candidates/hero-v2.webp",
          "source": "fal",
          "model": "fal-ai/flux-2-pro",
          "prompt_variant": "<different prompt focus>",
          "score": { "subject": <1-10>, "style": <1-10>, "color": <1-10>, "composition": <1-10>, "polish": <1-10> },
          "selected": false
        },
        {
          "path": ".runs/image-candidates/hero-unsplash-1.webp",
          "source": "unsplash",
          "unsplash_id": "<photo ID>",
          "score": { "subject": <1-10>, "style": <1-10>, "color": <1-10>, "composition": <1-10>, "polish": <1-10> },
          "selected": false
        }
      ],
      "winner_index": 0
    },
    "feature-1": {
      "candidates": ["..."],
      "winner_index": 0,
      "ensemble_anchor": true
    },
    "feature-2": {
      "candidates": ["..."],
      "winner_index": 0,
      "style_matched_to": "feature-1"
    },
    "feature-3": {
      "candidates": ["..."],
      "winner_index": 0,
      "style_matched_to": "feature-1"
    },
    "logo": { "candidates": ["..."], "winner_index": 0 },
    "og-photo": { "candidates": ["..."], "winner_index": 0 },
    "empty-state": { "candidates": ["..."], "winner_index": 0 }
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
  "candidates_per_slot": { "hero": 5, "feature-1": 3, "feature-2": 3, "feature-3": 3, "logo": 2, "og-photo": 3, "empty-state": 2 },
  "circuit_breaker_triggered": false,
  "weakest_image": "<filename>",
  "weakest_score": <min score across all dimensions and images>,
  "total_retries": <sum of retries across all images>,
  "models_used": ["fal-ai/flux-2-pro", "fal-ai/recraft/v4/pro/text-to-image", "..."]
}
```

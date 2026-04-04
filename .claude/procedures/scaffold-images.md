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

### Step 2: Install package
```bash
npm install @fal-ai/client
```

### Step 3: Create image generation library
Create `src/lib/image-gen.ts` following the multi-model code template in `.claude/stacks/images/fal.md`.

### Step 4: Generate images with visual feedback loop

For each image, follow this cycle: **Craft prompt → Generate → View → Score → Retry if needed**.

**Generation order** (sequential, respect rate limits):

| # | Filename | Type | Model | Dimensions |
|---|----------|------|-------|-----------|
| 1 | `hero.webp` | hero | FLUX.2 Pro | 1920x1080 |
| 2 | `feature-1.webp` | feature | Recraft V4 Pro | 800x600 |
| 3 | `feature-2.webp` | feature | Recraft V4 Pro | 800x600 |
| 4 | `feature-3.webp` | feature | Recraft V4 Pro | 800x600 |
| 5 | `logo.svg` | logo | Recraft V4 Vector | 512x512 |
| 6 | `og-photo.webp` | og | Ideogram V3 | 1200x630 |
| 7 | `empty-state.webp` | empty-state | Recraft V4 Pro | 400x400 |

**For each image:**

1. **Craft the prompt** using the per-model template from `fal.md`:
   - Use the visual brief's Image Direction for that image type
   - Apply the visual system prefix
   - Follow model-specific rules (FLUX: 30-80 words + camera specs; Recraft: design language + `colors` API param; Ideogram: text in quotes + `style: "DESIGN"`; etc.)

2. **Call the API** via `src/lib/image-gen.ts`:
   ```bash
   npx tsx -e "
   import { generateImage } from './src/lib/image-gen';
   const result = await generateImage({
     type: '<image_type>',
     prompt: '<crafted prompt>',
     width: <width>,
     height: <height>,
     filename: '<filename>',
     altText: '<descriptive alt text>',
     colors: [/* RGB from visual brief, for Recraft models */]
   });
   console.log(JSON.stringify(result));
   "
   ```

3. **View the generated image** using the Read tool:
   ```
   Read public/images/<filename>
   ```
   This displays the image visually (Claude is multimodal).

4. **Self-evaluate** against the 5 quality dimensions (see agent definition):
   - Subject relevance (1-10)
   - Style cohesion (1-10)
   - Color harmony (1-10)
   - Compositional quality (1-10)
   - Production polish (1-10)

5. **If any dimension < 8**: Analyze the specific problem. Refine the prompt to address it (e.g., "colors too cold" → add warm color HEX codes; "composition cluttered" → add "clean negative space, single focal point"). Re-generate. Max 2 retries per image.

6. If the specialized model fails entirely, the `generateImage()` function automatically falls back to FLUX.2 Pro, then to SVG placeholder. Continue with the next image.

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
      "score": {
        "subject": <1-10>,
        "style": <1-10>,
        "color": <1-10>,
        "composition": <1-10>,
        "polish": <1-10>
      },
      "retries": <0-2>
    }
  ]
}
```
Set `"fallback": true` at top level if ALL images fell back to SVG.

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
  "weakest_image": "<filename>",
  "weakest_score": <min score across all dimensions and images>,
  "total_retries": <sum of retries across all images>,
  "models_used": ["fal-ai/flux-2-pro", "fal-ai/recraft/v4/pro/text-to-image", "..."]
}
```

---
assumes: [framework/nextjs]
packages:
  runtime: ["@fal-ai/client"]
  dev: []
files:
  - src/lib/image-gen.ts
env:
  server: [FAL_KEY]
  client: []
ci_placeholders:
  FAL_KEY: placeholder-fal-key
clean:
  files: []
  dirs: [public/images]
gitignore: []
---
# Images: fal.ai (Multi-Model)
> Template infrastructure -- used during bootstrap image generation.
> Not gated by experiment.yaml stack. Activated when `FAL_KEY` is available.
> Single `FAL_KEY` drives 5 specialized models for world-champion image quality.

## Packages
```bash
npm install @fal-ai/client
```

## Model Selection Strategy

Each image type uses the optimal model. All models share one `FAL_KEY` via fal.ai.

| Image Type | Model | fal.ai Model ID | Why |
|-----------|-------|-----------------|-----|
| Hero (photography) | FLUX.2 Pro | `fal-ai/flux-2-pro` | Best photorealism, JSON prompts, HEX colors |
| Feature illustrations | Recraft V4 Pro | `fal-ai/recraft/v4/pro/text-to-image` | Native design taste, RGB color control |
| Logo (SVG) | Recraft V4 Vector | `fal-ai/recraft/v4/pro/text-to-vector` | Only model producing native SVG paths |
| OG/Social (with text) | Ideogram V3 | `fal-ai/ideogram/v3` | ~90% text rendering accuracy |
| Product mockup | GPT Image 1.5 | `fal-ai/gpt-image-1.5` | Superior instruction-following, transparent BG |
| Empty state | Recraft V4 Pro | `fal-ai/recraft/v4/pro/text-to-image` | Design taste for friendly illustrations |

**Fallback chain:** Specialized model fails → retry with FLUX.2 Pro → SVG placeholder.

## Files to Create

### `src/lib/image-gen.ts` -- Multi-model AI image generation with fal.ai
```ts
import { fal } from "@fal-ai/client";
import { writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2000;
const PUBLIC_IMAGES_DIR = join(process.cwd(), "public", "images");

const FALLBACK_MODEL = "fal-ai/flux-2-pro";

// --- Model Configuration ---

export type ImageType = "hero" | "feature" | "logo" | "og" | "mockup" | "empty-state";

interface ModelConfig {
  modelId: string;
  defaultParams: Record<string, unknown>;
  outputFormat: "jpeg" | "png" | "webp" | "svg";
}

const MODEL_CONFIGS: Record<ImageType, ModelConfig> = {
  hero: {
    modelId: "fal-ai/flux-2-pro",
    defaultParams: { output_format: "jpeg", safety_tolerance: "2" },
    outputFormat: "jpeg",
  },
  feature: {
    modelId: "fal-ai/recraft/v4/pro/text-to-image",
    defaultParams: {},
    outputFormat: "webp",
  },
  logo: {
    modelId: "fal-ai/recraft/v4/pro/text-to-vector",
    defaultParams: {},
    outputFormat: "svg",
  },
  og: {
    modelId: "fal-ai/ideogram/v3",
    defaultParams: { style: "DESIGN", expand_prompt: false, rendering_speed: "QUALITY" },
    outputFormat: "png",
  },
  mockup: {
    modelId: "fal-ai/gpt-image-1.5",
    defaultParams: { quality: "high", background: "opaque", output_format: "png" },
    outputFormat: "png",
  },
  "empty-state": {
    modelId: "fal-ai/recraft/v4/pro/text-to-image",
    defaultParams: {},
    outputFormat: "webp",
  },
};

// --- Types ---

export interface GenerateImageOptions {
  type: ImageType;
  prompt: string;
  width: number;
  height: number;
  filename: string;
  altText: string;
  colors?: Array<{ r: number; g: number; b: number }>; // For Recraft models
  outputDir?: string; // Override output directory (default: public/images). Used for multi-candidate generation to write to .runs/image-candidates/
}

export interface ImageResult {
  path: string;
  publicPath: string;
  altText: string;
  fallback: boolean;
  model: string;
}

// --- Internal ---

function isDemoMode(): boolean {
  if (process.env.DEMO_MODE === "true") return true;
  if (process.env.FAL_KEY) return false;
  // Check persistent key file (matches bootstrap preflight detection in state-8)
  try {
    const keyPath = join(homedir(), '.fal', 'key');
    const key = readFileSync(keyPath, 'utf-8').trim();
    if (key && !key.startsWith('placeholder')) {
      process.env.FAL_KEY = key; // Bridge to env var for fal client
      return false;
    }
  } catch { /* ~/.fal/key not readable */ }
  return true;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir: string = PUBLIC_IMAGES_DIR): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function callModel(
  modelId: string,
  input: Record<string, unknown>
): Promise<string> {
  const result = await fal.subscribe(modelId, { input });
  const data = result.data as { images?: { url: string }[] };
  const url = data.images?.[0]?.url;
  if (!url) throw new Error(`No image URL from ${modelId}`);
  return url;
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
}

// --- Public API ---

/**
 * Generate an image using the optimal model for the image type.
 * Falls back to FLUX.2 Pro if the specialized model fails,
 * then to SVG placeholder if all API calls fail.
 */
export async function generateImage(
  options: GenerateImageOptions
): Promise<ImageResult> {
  const { type, prompt, width, height, filename, altText, colors, outputDir } = options;
  const config = MODEL_CONFIGS[type];
  const targetDir = outputDir ?? PUBLIC_IMAGES_DIR;
  const filePath = join(targetDir, filename);
  const publicPath = outputDir ? `${outputDir}/${filename}` : `/images/${filename}`;

  await ensureDir(targetDir);

  if (isDemoMode()) {
    return generateSvgPlaceholder({ width, height, filename, altText });
  }

  // Build model-specific input
  const input: Record<string, unknown> = {
    prompt,
    ...config.defaultParams,
  };

  // Size handling differs per model
  if (config.modelId === "fal-ai/gpt-image-1.5") {
    input.image_size = `${width}x${height}`;
  } else {
    input.image_size = { width, height };
  }

  // Recraft color support
  if (colors && config.modelId.includes("recraft")) {
    input.colors = colors;
  }

  // Try specialized model, then fallback to FLUX, then SVG
  const modelsToTry = config.modelId === FALLBACK_MODEL
    ? [config.modelId]
    : [config.modelId, FALLBACK_MODEL];

  for (const modelId of modelsToTry) {
    const modelInput = modelId === FALLBACK_MODEL && modelId !== config.modelId
      ? { prompt, image_size: { width, height }, output_format: "jpeg", safety_tolerance: "2" }
      : input;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const imageUrl = await callModel(modelId, modelInput);
        await downloadToFile(imageUrl, filePath);
        return { path: filePath, publicPath, altText, fallback: false, model: modelId };
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        } else if (modelId !== FALLBACK_MODEL) {
          console.warn(`${modelId} failed for ${filename}, trying fallback...`);
          break; // Move to fallback model
        }
      }
    }
  }

  console.warn(`All models failed for ${filename}, using SVG placeholder`);
  return generateSvgPlaceholder({ width, height, filename, altText });
}

/**
 * Generate a themed SVG placeholder at the same file path.
 */
export async function generateSvgPlaceholder(options: {
  width: number;
  height: number;
  filename: string;
  altText: string;
}): Promise<ImageResult> {
  const { width, height, filename, altText } = options;
  const svgFilename = filename.replace(/\.\w+$/, ".svg");
  const filePath = join(PUBLIC_IMAGES_DIR, svgFilename);
  const publicPath = `/images/${svgFilename}`;

  await ensureDir();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:hsl(var(--primary, 220 70% 50%));stop-opacity:0.15"/>
      <stop offset="100%" style="stop-color:hsl(var(--primary, 220 70% 50%));stop-opacity:0.05"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${width * 0.3}" cy="${height * 0.4}" r="${Math.min(width, height) * 0.15}" fill="hsl(var(--primary, 220 70% 50%))" opacity="0.1"/>
  <circle cx="${width * 0.7}" cy="${height * 0.6}" r="${Math.min(width, height) * 0.2}" fill="hsl(var(--primary, 220 70% 50%))" opacity="0.08"/>
</svg>`;

  await writeFile(filePath, svg, "utf-8");
  return { path: filePath, publicPath, altText, fallback: true, model: "svg-placeholder" };
}
```

## Image File Path Contract

| Path | Purpose | Dimensions | Model |
|------|---------|-----------|-------|
| `public/images/hero.webp` (or `.svg`) | Landing page hero | 1920x1080 | FLUX.2 Pro |
| `public/images/feature-1.webp` (or `.svg`) | Feature section 1 | 800x600 | Recraft V4 Pro |
| `public/images/feature-2.webp` (or `.svg`) | Feature section 2 | 800x600 | Recraft V4 Pro |
| `public/images/feature-3.webp` (or `.svg`) | Feature section 3 | 800x600 | Recraft V4 Pro |
| `public/images/logo.svg` | Brand logo icon | 512x512 | Recraft V4 Vector |
| `public/images/og-photo.webp` (or `.svg`) | OG social share image | 1200x630 | Ideogram V3 |
| `public/images/empty-state.webp` (or `.svg`) | Empty state illustration | 400x400 | Recraft V4 Pro |

The image manifest (`.runs/image-manifest.json`) records actual filenames and models used.

## Image Manifest

Written to `.runs/image-manifest.json` after generation:
```json
{
  "status": "complete",
  "fallback": false,
  "images": [
    {
      "filename": "hero.webp",
      "publicPath": "/images/hero.webp",
      "altText": "...",
      "width": 1920,
      "height": 1080,
      "fallback": false,
      "model": "fal-ai/flux-2-pro",
      "score": { "subject": 9, "style": 8, "color": 9, "composition": 8, "polish": 9 }
    }
  ]
}
```

## Multi-Candidate Usage

The `outputDir` option enables the **Compete & Shortlist** architecture. Instead
of writing directly to `public/images/`, candidates are written to a staging
directory for comparison and selection.

**Generating a candidate:**
```ts
const result = await generateImage({
  type: "hero",
  prompt: "...",
  width: 1920, height: 1080,
  filename: "hero-v1.webp",
  altText: "...",
  outputDir: ".runs/image-candidates"
});
// result.path = ".runs/image-candidates/hero-v1.webp"
```

**Selecting a winner:** After scoring all candidates, copy the winner to the
canonical path:
```bash
cp .runs/image-candidates/hero-v2.webp public/images/hero.webp
```

**Sidecar file:** All candidate metadata is recorded in `.runs/image-candidates.json`
(separate from the main `.runs/image-manifest.json`). See
`.claude/procedures/scaffold-images.md` Step 5b for the sidecar schema.

**Backwards compatibility:** When `outputDir` is omitted, behavior is identical
to the original single-candidate flow. The main manifest schema is unchanged.

## Model Documentation

### FLUX.2 Pro — Hero images, lifestyle photography
- **Model ID**: `fal-ai/flux-2-pro`
- **ELO**: ~1265 on LM Arena (tied #1 for photorealism)
- **Key params**: `image_size` (named enum or `{width, height}`), `output_format`, `safety_tolerance`
- **No negative prompts** — describe what you want, not what to avoid
- **Supports JSON structured prompts** for complex multi-element scenes
- **HEX colors**: Associate with specific objects: `"car is #FF0000"`, not `"use #FF0000"`

### Recraft V4 Pro — Feature illustrations, empty states
- **Model ID**: `fal-ai/recraft/v4/pro/text-to-image`
- **Key params**: `colors` (RGB array for brand color control), `background_color`
- **No `style` API param for V4** — describe style entirely in prompt
- **Native design taste** — compositions feel intentional, not stock-like
- **Output**: WebP

### Recraft V4 Vector — Logo SVGs
- **Model ID**: `fal-ai/recraft/v4/pro/text-to-vector`
- **Output**: Real SVG (`image/svg+xml`) with clean vector paths
- **Key params**: `colors` (RGB array), `background_color` (null for transparent)
- **Best with constraint-driven prompts**: "flat colors only, no gradients, no shadows"

### Ideogram V3 — OG cards, ad creative (text-heavy)
- **Model ID**: `fal-ai/ideogram/v3`
- **~90% text rendering accuracy** — far ahead of competitors
- **Key params**: `style: "DESIGN"`, `expand_prompt: false` (disable MagicPrompt for control), `rendering_speed: "QUALITY"`, `negative_prompt`
- **Put text in quotation marks early in prompt**: `'"SHIP FASTER" in bold white sans-serif'`
- **Prompt limit**: ~160 words (excess silently truncated)

### GPT Image 1.5 — Product mockups
- **Model ID**: `fal-ai/gpt-image-1.5`
- **Key params**: `quality: "high"`, `background: "transparent"` (for compositing), `output_format`
- **Fixed pixel sizes**: `"1024x1024"`, `"1536x1024"`, `"1024x1536"` (not named enum)
- **Hard constraint phrases**: `"No watermark. No extra text. Preserve exact product shape."`
- **32,000 char prompt limit** — far longer than any other model

## Prompt Engineering Patterns

### Visual System Prefix

Derive a 20-30 word shared style block from the visual brief's **Color Palette** and **Image Direction** sections. Prepend or append this to EVERY image prompt to maintain cross-image visual consistency.

Example:
```
Warm natural light, soft directional shadows. Palette: cream #F5F0EB,
sage green #87A878, terracotta #C67B5C, charcoal #2D2D2D.
Clean minimal composition. Premium but approachable.
```

This prefix is NOT a new artifact — it is a formatting technique applied to existing Image Direction content.

### Per-Model Prompt Templates

**FLUX.2 Pro (hero images) — 30-80 words, subject-first, photography language:**
```
{Detailed subject description}. {Environment and scene context}.
{Lighting: direction, quality, temperature}. {Composition: angle, framing, negative space for text overlay}.
Shot on {camera}, {focal length} lens, {aperture}. {Visual System Prefix}.
```

Example:
```
Premium wireless headphone resting on weathered oak desk, soft morning light
filtering through linen curtains from the left, shallow depth of field, warm
amber tones. Shot on Sony A7IV, 85mm lens, f/1.8. Lifestyle editorial
photography, clean and aspirational. Palette: cream #F5F0EB, sage #87A878.
```

**Recraft V4 Pro (feature illustrations) — design-director language, format context:**
```
{Output format: feature illustration for a SaaS landing page}.
{Core concept and subject}. {Background/environment}. {Style: bold flat / editorial ink / geometric minimal}.
{Line behavior: clean strokes, consistent weight}. {Color logic: flat colors only, limited palette}.
{Mood and composition}. {Dimensions context: landscape 16:9}.
```
API: `colors: [{r:X, g:Y, b:Z}, ...]` from visual brief palette

**Recraft V4 Vector (logo) — constraint-driven, minimal:**
```
{Graphic type: geometric logo mark / abstract symbol / letterform}.
{Shape description and visual metaphor}. {Symmetry: radial/bilateral/asymmetric}.
Flat colors only, no gradients, no shadows, no texture. Strong silhouette,
readable at 16px favicon size. {Color count: 2-3 colors on transparent background}.
```
API: `colors: [{r:X, g:Y, b:Z}, ...]`, `background_color: null`

**Ideogram V3 (OG/social cards) — text-first, control params:**
```
Professional social media card design. {Background description with HEX color}.
Large bold "{HEADLINE TEXT}" in {color} {font style}, {position}.
{Subtext}. {Visual elements}. {Style and mood}. Landscape 16:9 composition.
```
API: `style: "DESIGN"`, `expand_prompt: false`, `rendering_speed: "QUALITY"`

**GPT Image 1.5 (product mockups) — Background→Subject→Details→Constraints:**
```
{Scene/background setup}. {Product subject in detail: materials, colors, state}.
{Lighting: studio lighting from upper left, soft shadows}. {Camera angle and framing}.
{Visual System Prefix}. No watermark. No extra text. No background clutter.
```
API: `quality: "high"`, `background: "transparent"` for cutouts

**Recraft V4 Pro (empty states) — friendly, encouraging:**
```
Friendly minimal illustration for an empty {context} state in a web application.
{Emotional subject: person looking curious / empty box with sparkles / open door with light}.
{Style: same as feature illustrations}. Encouraging and welcoming mood.
Simple clean design, centered composition, square format.
```
API: `colors` matching feature illustration palette

## Environment Variables
```
FAL_KEY=fal-...
```

## Security
- `FAL_KEY` is server-only -- never expose to client
- Image generation runs during bootstrap (build time) and design-critic (verify time), not at user request time
- No user input reaches image generation prompts -- prompts derive from experiment.yaml and visual brief only

## Demo Mode
When `DEMO_MODE=true` or `FAL_KEY` is not available, all calls return SVG placeholders without hitting the API. This enables visual review and CI builds without credentials. `FAL_KEY` is resolved from: (1) `process.env.FAL_KEY`, then (2) `~/.fal/key` persistent file. The first successful source is bridged to `process.env.FAL_KEY` for the fal SDK.

## PR Instructions
- After merging, set `FAL_KEY` via any of these methods:
  - `export FAL_KEY=fal-...` in your shell or add to `.env.local`
  - Or use the fal CLI (`~/.fal/key` is auto-detected)
  - Get your key from [fal.ai](https://fal.ai) > Dashboard > Keys
- For deployment: set `FAL_KEY` in your hosting provider's environment variables
  - Images are generated at bootstrap time and committed as static assets
  - The deployed app does NOT need `FAL_KEY` at runtime

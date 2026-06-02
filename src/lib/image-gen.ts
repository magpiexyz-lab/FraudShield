import { fal } from "@fal-ai/client";
import { writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import sharp from "sharp";

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2000;
const PUBLIC_IMAGES_DIR = join(process.cwd(), "public", "images");

const FALLBACK_MODEL = "fal-ai/flux-2-pro";

// Dimension Contract: longest side must be <= 1920px (Claude vision pipeline
// caps single-image side at 2000px; oversized candidates crash design-critic).
const MAX_SIDE = 1920;

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
    modelId: "fal-ai/gpt-image-2",
    defaultParams: { quality: "high", output_format: "png" },
    outputFormat: "png",
  },
  mockup: {
    modelId: "fal-ai/gpt-image-2",
    defaultParams: { quality: "high", output_format: "png" },
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
  seed: number | null; // fal-returned seed when available (for provenance binding)
  httpStatus: number | null; // last non-2xx HTTP status observed (for fal-api-errors logging)
}

// --- Internal ---

function isDemoMode(): boolean {
  if (process.env.DEMO_MODE === "true") return true;
  if (process.env.FAL_KEY) return false;
  // Check persistent key file (matches bootstrap preflight detection in state-8)
  try {
    const keyPath = join(homedir(), ".fal", "key");
    const key = readFileSync(keyPath, "utf-8").trim();
    if (key && !key.startsWith("placeholder")) {
      process.env.FAL_KEY = key; // Bridge to env var for fal client
      return false;
    }
  } catch {
    /* ~/.fal/key not readable */
  }
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

interface ModelCallResult {
  url: string;
  seed: number | null;
}

async function callModel(
  modelId: string,
  input: Record<string, unknown>
): Promise<ModelCallResult> {
  const result = await fal.subscribe(modelId, { input });
  const data = result.data as {
    images?: { url: string }[];
    seed?: number;
  };
  const url = data.images?.[0]?.url;
  if (!url) throw new Error(`No image URL from ${modelId}`);
  return { url, seed: typeof data.seed === "number" ? data.seed : null };
}

// Extract an HTTP status code from a fal client error, when present.
function extractHttpStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    const body = e.body as Record<string, unknown> | undefined;
    if (body && typeof body.status === "number") return body.status;
  }
  return null;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Enforce the Dimension Contract and write to disk in a single pass:
 * resize so the longest side is <= 1920px, then write to filePath.
 * fit:"inside" preserves aspect ratio; withoutEnlargement never upscales.
 * Reading from an in-memory buffer (not the destination file) avoids the
 * read-then-overwrite-same-path race that fails on Windows (EPERM on rename).
 * Output format is inferred from the destination extension so the on-disk
 * bytes match the filename (.webp -> webp, .png -> png, .jpg -> jpeg).
 */
async function capAndWrite(buffer: Buffer, filePath: string): Promise<void> {
  const lower = filePath.toLowerCase();
  let pipeline = sharp(buffer).resize({
    width: MAX_SIDE,
    height: MAX_SIDE,
    fit: "inside",
    withoutEnlargement: true,
  });
  if (lower.endsWith(".webp")) {
    pipeline = pipeline.webp({ quality: 90 });
  } else if (lower.endsWith(".png")) {
    pipeline = pipeline.png();
  } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    pipeline = pipeline.jpeg({ quality: 90 });
  }
  const out = await pipeline.toBuffer();
  await writeFile(filePath, out);
}

// --- Public API ---

/**
 * Generate an image using the optimal model for the image type.
 * Falls back to FLUX.2 Pro if the specialized model fails,
 * then to SVG placeholder if all API calls fail.
 * Every successful raster write is passed through the sharp dimension cap.
 */
export async function generateImage(
  options: GenerateImageOptions
): Promise<ImageResult> {
  const { type, prompt, width, height, filename, altText, colors, outputDir } =
    options;
  const config = MODEL_CONFIGS[type];
  const targetDir = outputDir ?? PUBLIC_IMAGES_DIR;
  const filePath = join(targetDir, filename);
  const publicPath = outputDir ? `${outputDir}/${filename}` : `/images/${filename}`;

  await ensureDir(targetDir);

  if (isDemoMode()) {
    return generateSvgPlaceholder({ width, height, filename, altText, outputDir });
  }

  // Build model-specific input
  const input: Record<string, unknown> = {
    prompt,
    ...config.defaultParams,
  };

  // Align to 16-pixel multiples (required by GPT-Image-2; harmless for other models)
  const alignedW = Math.round(width / 16) * 16;
  const alignedH = Math.round(height / 16) * 16;
  input.image_size = { width: alignedW, height: alignedH };

  // Recraft color support
  if (colors && config.modelId.includes("recraft")) {
    input.colors = colors;
  }

  // SVG (vector logo) output is written verbatim — no raster cap.
  const isVector = config.outputFormat === "svg";

  // Try specialized model, then fallback to FLUX, then SVG
  const modelsToTry =
    config.modelId === FALLBACK_MODEL
      ? [config.modelId]
      : [config.modelId, FALLBACK_MODEL];

  let lastHttpStatus: number | null = null;

  for (const modelId of modelsToTry) {
    const modelInput =
      modelId === FALLBACK_MODEL && modelId !== config.modelId
        ? {
            prompt,
            image_size: { width: alignedW, height: alignedH },
            output_format: "jpeg",
            safety_tolerance: "2",
          }
        : input;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { url, seed } = await callModel(modelId, modelInput);
        const buffer = await downloadToBuffer(url);
        if (isVector) {
          await writeFile(filePath, buffer);
        } else {
          await capAndWrite(buffer, filePath);
        }
        return {
          path: filePath,
          publicPath,
          altText,
          fallback: false,
          model: modelId,
          seed,
          httpStatus: lastHttpStatus,
        };
      } catch (error) {
        lastHttpStatus = extractHttpStatus(error) ?? lastHttpStatus;
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
  const placeholder = await generateSvgPlaceholder({
    width,
    height,
    filename,
    altText,
    outputDir,
  });
  return { ...placeholder, httpStatus: lastHttpStatus };
}

/**
 * Generate a themed SVG placeholder at the same file path.
 */
export async function generateSvgPlaceholder(options: {
  width: number;
  height: number;
  filename: string;
  altText: string;
  outputDir?: string;
}): Promise<ImageResult> {
  const { width, height, filename, altText, outputDir } = options;
  const svgFilename = filename.replace(/\.\w+$/, ".svg");
  const targetDir = outputDir ?? PUBLIC_IMAGES_DIR;
  const filePath = join(targetDir, svgFilename);
  const publicPath = outputDir
    ? `${outputDir}/${svgFilename}`
    : `/images/${svgFilename}`;

  await ensureDir(targetDir);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:hsl(var(--primary, 213 60% 49%));stop-opacity:0.15"/>
      <stop offset="100%" style="stop-color:hsl(var(--primary, 213 60% 49%));stop-opacity:0.05"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${width * 0.3}" cy="${height * 0.4}" r="${Math.min(width, height) * 0.15}" fill="hsl(var(--primary, 213 60% 49%))" opacity="0.1"/>
  <circle cx="${width * 0.7}" cy="${height * 0.6}" r="${Math.min(width, height) * 0.2}" fill="hsl(var(--primary, 213 60% 49%))" opacity="0.08"/>
</svg>`;

  await writeFile(filePath, svg, "utf-8");
  return {
    path: filePath,
    publicPath,
    altText,
    fallback: true,
    model: "svg-placeholder",
    seed: null,
    httpStatus: null,
  };
}

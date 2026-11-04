#!/usr/bin/env node
// Validates RUNTIME configuration before build, on hosting platforms only.
// Runs as `prebuild` lifecycle hook. Skips on bootstrap/local builds.
//
// Why this is a separate file rather than three more checks inside
// scripts/check-analytics-env.mjs: that file is listed in the posthog stack's
// `files:` manifest (.claude/stacks/analytics/posthog.md:10), which makes it
// template-owned. An `/upgrade` re-materialises it from the template and would
// silently revert anything added here — and a guard that disappears without
// telling anyone is worse than no guard, because the thing it was protecting
// (see below) costs money when it is missing. This file is project-owned, so
// `/upgrade` leaves it alone.

import nextEnv from "@next/env";

// .mjs (raw Node ESM) requires DEFAULT-import + destructure for @next/env. The
// named-import form (`import { loadEnvConfig } from ...`) fails under Node 22+
// raw ESM with `SyntaxError: Named export 'loadEnvConfig' not found` because
// Node's CJS named-export detection does not surface this package's exports.
// See scripts/check-analytics-env.mjs:8-14 for the per-loader contract.
const { loadEnvConfig } = nextEnv;

// Load .env.local / .env so local `npm run build` invocations see the same
// values Next.js itself would. On Vercel/Railway build platforms env vars are
// already populated, so this is a no-op there.
loadEnvConfig(process.cwd());

// Skip-gate: only run on real Vercel/Railway build platforms. Mirrors
// check-analytics-env.mjs:25-27 exactly.
//
// `process.env.CI === "1"` distinguishes Vercel CI builds from a local
// `vercel build`, which also sets VERCEL=1 but not CI=1. A local
// `vercel build --prod` therefore SKIPS this script even though it sets
// VERCEL_ENV=production — deliberate, and the same behaviour the analytics
// check already has: a developer building locally is not shipping, and should
// not need production secrets on their machine to type `npm run build`.
//
// Note what is NOT gated on: VERCEL_ENV. Every deployed build asserts,
// previews included. A preview deploy with no limiter is uncapped against the
// same paid API as production.
const isVercelBuildPlatform = process.env.CI === "1" && process.env.VERCEL === "1";
const isRailwayBuildPlatform = !!process.env.RAILWAY_ENVIRONMENT_NAME;
if (!isVercelBuildPlatform && !isRailwayBuildPlatform) process.exit(0);

// --- Runtime secrets the anonymous free scan cannot do without -------------
//
// Why each of these is worth failing a build over rather than warning:
//
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   src/lib/rate-limit.ts enables Upstash only when BOTH are set, and falls
//   back to a process-local in-memory Map otherwise (see its header comment).
//   On Vercel that Map dies with every serverless instance, so the counter
//   resets continuously and the cap is not a cap. The free scan is anonymous —
//   there is no account to attribute spend to and nothing else standing
//   between a stranger and the API — and what it is uncapped against is
//   claude-opus-5 vision calls (VISION_MODEL, src/lib/fraud/vision.ts:40) that
//   are billed per image. An unenforced limiter here is a bill, not a warning.
//
//   The free-scan route also fails CLOSED when NODE_ENV === "production" and
//   the limiter is not Upstash-backed: it refuses free scans rather than
//   serving them uncapped. That is the right default, but it means a
//   misconfigured production deploy ships a landing page whose headline
//   feature returns a cap error to every visitor — green build, green deploy,
//   dead funnel. This guard is what stops that reaching production silently.
//
// ANTHROPIC_API_KEY
//   analyzeDocumentForFraud returns unusable("unavailable") when the key is
//   absent (src/lib/fraud/vision.ts:410) — it does not throw. The scan still
//   "succeeds" as a metadata-only partial, so the build is green, the page
//   renders, and every free scan silently returns no verdict. h-12
//   (free_scan_complete / free_scan_start) would read 0 and look like a
//   product finding instead of a missing env var.
const REQUIRED = [
  {
    name: "UPSTASH_REDIS_REST_URL",
    why: "the rate limiter falls back to an in-memory Map that resets on every serverless cold start, so the anonymous free scan is effectively uncapped against paid claude-opus-5 vision calls",
    fixes: [
      "Set UPSTASH_REDIS_REST_URL in your hosting platform (Vercel -> Project -> Settings -> Environment Variables).",
      "Create a free Redis database at https://console.upstash.com and copy the REST URL from its \"REST API\" section.",
    ],
  },
  {
    name: "UPSTASH_REDIS_REST_TOKEN",
    why: "the limiter has only half its credentials and silently uses the in-memory fallback, so the free-scan cap is not enforced (both Upstash vars are required)",
    fixes: [
      "Set UPSTASH_REDIS_REST_TOKEN in your hosting platform (Vercel -> Project -> Settings -> Environment Variables).",
      "Copy the REST token from the same Upstash database's \"REST API\" section.",
    ],
  },
  {
    name: "ANTHROPIC_API_KEY",
    why: "the vision pass degrades to a metadata-only partial instead of throwing, so every free scan returns no AI verdict and the failure is invisible in the build",
    fixes: [
      "Set ANTHROPIC_API_KEY in your hosting platform (Vercel -> Project -> Settings -> Environment Variables).",
      "Get a key at https://console.anthropic.com -> API Keys.",
    ],
  },
];

const missing = REQUIRED.filter(({ name }) => !(process.env[name] ?? "").trim());

if (missing.length > 0) {
  console.error(`\n[runtime-env] This deployment is missing runtime configuration the free scan requires.`);
  for (const { name, why, fixes } of missing) {
    console.error(`\n  ${name} is not set.`);
    console.error(`  Without it, ${why}.`);
    console.error(`\n  Fix one of:`);
    fixes.forEach((fix, i) => console.error(`    ${i + 1}. ${fix}`));
  }
  console.error(`\nAll of these are documented in .env.example. Build aborted.\n`);
  process.exit(1);
}

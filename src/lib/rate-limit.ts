// Serverless-safe rate limiter.
//
// Production: Upstash Redis (via @upstash/ratelimit) — counters survive
// across Vercel serverless cold starts because they live in an external
// store. Enabled when both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
// are set.
//
// Development fallback: a process-local in-memory Map. Counters reset on
// every cold start, so this is NOT safe for production — it exists only so
// `npm run dev` works without an Upstash account.
//
// Callers use the same signature in both modes:
//   const { success, remaining } = await rateLimit(identifier, max, windowSec);

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitResult = { success: boolean; remaining: number };

// --- Upstash (production) ---------------------------------------------------

const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const upstashEnabled = Boolean(upstashUrl && upstashToken);

const redis = upstashEnabled
  ? new Redis({ url: upstashUrl!, token: upstashToken! })
  : null;

// One Ratelimit instance per (max, windowSec) tuple — Upstash recommends
// reusing instances so the underlying script cache is shared.
const limiterCache = new Map<string, Ratelimit>();

function getLimiter(max: number, windowSec: number): Ratelimit | null {
  if (!redis) return null;
  const key = `${max}:${windowSec}`;
  let limiter = limiterCache.get(key);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, `${windowSec} s`),
      analytics: false,
      prefix: "fraudshield:rl",
    });
    limiterCache.set(key, limiter);
  }
  return limiter;
}

// --- In-memory fallback (development only) ---------------------------------

const memoryStore = new Map<string, { count: number; resetTime: number }>();

function memoryRateLimit(
  identifier: string,
  max: number,
  windowSec: number,
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const entry = memoryStore.get(identifier);

  if (!entry || now > entry.resetTime) {
    memoryStore.set(identifier, { count: 1, resetTime: now + windowMs });
    return { success: true, remaining: max - 1 };
  }

  if (entry.count >= max) {
    return { success: false, remaining: 0 };
  }

  entry.count++;
  return { success: true, remaining: max - entry.count };
}

// --- Public API -------------------------------------------------------------

export async function rateLimit(
  identifier: string,
  max: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const limiter = getLimiter(max, windowSec);
  if (limiter) {
    try {
      const result = await limiter.limit(identifier);
      return { success: result.success, remaining: result.remaining };
    } catch (e) {
      // If Upstash is unreachable, fall through to memory so the endpoint
      // still works. Log so operators can spot the degradation.
      console.error("[rate-limit] Upstash error, falling back to memory:", e);
    }
  }
  return memoryRateLimit(identifier, max, windowSec);
}

// Vercel's proxy appends the verified client IP as the LAST entry in the
// X-Forwarded-For chain. Entries BEFORE the last one are forwarded from the
// client (or upstream proxies) and are NOT trusted — an attacker can supply
// arbitrary `X-Forwarded-For: <random>` to inject a unique-per-request key,
// bypassing per-IP rate caps. Always derive the rate-limit key via this
// helper, never via the raw header value. (Issue #1361 / CVSS-medium.)
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const last = xff.split(",").at(-1)?.trim();
    if (last) return last;
  }
  return headers.get("x-real-ip") ?? "unknown";
}

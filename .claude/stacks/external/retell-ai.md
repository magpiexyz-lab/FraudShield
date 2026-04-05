---
assumes: [framework/nextjs]
packages:
  runtime: [retell-sdk]
  dev: []
files:
  - src/lib/retell.ts
  - src/app/api/webhooks/retell/route.ts
env:
  server: [RETELL_API_KEY, RETELL_WEBHOOK_SECRET]
  client: []
ci_placeholders: {}
clean:
  files: []
  dirs: []
gitignore: []
---
# External: Retell AI
> Used when experiment.yaml behaviors require AI voice agents or Retell AI webhooks
> Assumes: `framework/nextjs` for API route handlers

## Packages
```bash
npm install retell-sdk
```

## Files to Create

### `src/lib/retell.ts` — Retell AI client and helpers
```ts
import Retell from "retell-sdk";
import { createHmac, timingSafeEqual } from "crypto";

const apiKey = process.env.RETELL_API_KEY;

if (!apiKey) {
  console.error("[503] Retell AI not configured — run /deploy to provision");
}

export const retellClient = apiKey ? new Retell({ apiKey }) : null;

/**
 * Verify HMAC-SHA256 signature on incoming Retell AI webhooks.
 */
export function verifyRetellSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### `src/app/api/webhooks/retell/route.ts` — Webhook handler template
```ts
import { NextRequest, NextResponse } from "next/server";
import { verifyRetellSignature } from "@/lib/retell";

export async function POST(req: NextRequest) {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Service not configured" }, { status: 503 });
  }

  // Read raw body before parsing
  const rawBody = await req.text();
  const signature = req.headers.get("x-retell-signature") ?? "";

  if (!verifyRetellSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // Cross-validate agent_id against stored record
  // const agentId = payload.agent_id;
  // Verify agentId matches the expected agent for this endpoint

  return NextResponse.json({ received: true });
}
```

## Environment Variables
```
RETELL_API_KEY=your-api-key                # Retell AI API key
RETELL_WEBHOOK_SECRET=your-webhook-secret  # HMAC-SHA256 secret for webhook verification
```

## Patterns
- Always verify HMAC-SHA256 signatures on incoming webhooks before processing any payload
- Read the raw body before JSON parsing to ensure signature verification uses the original bytes
- After signature verification, cross-validate `agent_id` in the payload against the stored record in the database — a valid signature alone does not prevent a legitimate agent from posting to the wrong endpoint
- Avoid logging raw Zod validation errors — log only the error count to prevent leaking request structure

## Security
- HMAC-SHA256 signature verification is mandatory on all webhook routes — without it, any caller can send arbitrary payloads
- Use `timingSafeEqual` for signature comparison to prevent timing attacks
- Redact phone numbers and PII from all log output
- Remove internal service names from error responses returned to callers
- Add rate limiting to webhook routes

## CLI Provisioning
No CLI available — credentials must be obtained via the Retell AI dashboard at https://www.retellai.com.

## PR Instructions
- Sign up at https://www.retellai.com and create a project
- Copy the API key from the dashboard
- Configure a webhook secret in Retell AI settings
- Add env vars to `.env.local`
- Set the webhook URL in Retell AI → Agents → select agent → Webhook URL

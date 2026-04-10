---
assumes: [framework/nextjs]
packages:
  runtime: []
  dev: []
files:
  - src/app/api/webhooks/linear/route.ts
env:
  server: [LINEAR_WEBHOOK_SECRET]
  client: []
ci_placeholders: {}
clean:
  files: []
  dirs: []
gitignore: []
---
# External: Linear
> Used when experiment.yaml behaviors require Linear issue tracking or webhook integrations
> Assumes: `framework/nextjs` for API route handlers

## Packages

No additional packages needed — uses Node.js built-in `crypto` module.

## Webhook Signature Verification

Linear signs webhook payloads with HMAC-SHA256 using the webhook secret. Every incoming webhook request MUST verify the `linear-signature` header before processing.

### `src/app/api/webhooks/linear/route.ts` — Webhook handler with signature verification
```ts
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

function verifyLinearSignature(body: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function POST(request: Request) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[503] LINEAR_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Service not configured" }, { status: 503 });
  }

  const signature = request.headers.get("linear-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const body = await request.text();
  if (!verifyLinearSignature(body, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(body);

  // Process webhook payload here
  // payload.type: "Issue", "Comment", "Cycle", etc.
  // payload.action: "create", "update", "remove"

  return NextResponse.json({ received: true });
}
```

Notes:
- `timingSafeEqual` prevents timing side-channel attacks on signature comparison
- The raw request body (`request.text()`) must be used for HMAC computation — not the parsed JSON
- Return 401 for missing or invalid signatures, 503 for missing configuration
- Linear webhook secret is configured in Linear Settings > API > Webhooks

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LINEAR_WEBHOOK_SECRET` | Webhook signing secret from Linear (Settings > API > Webhooks) |

## Known Issues

### Webhook payload size
Linear webhook payloads can be large (especially for Issue updates with full descriptions). Ensure your deployment platform's request body size limit is sufficient (Vercel default: 4.5 MB for serverless, which is adequate).

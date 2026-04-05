---
assumes: [framework/nextjs]
packages:
  runtime: [twilio]
  dev: []
files:
  - src/lib/twilio.ts
  - src/app/api/webhooks/twilio/route.ts
env:
  server: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER]
  client: []
ci_placeholders: {}
clean:
  files: []
  dirs: []
gitignore: []
---
# External: Twilio
> Used when experiment.yaml behaviors require SMS, voice, or Twilio webhooks
> Assumes: `framework/nextjs` for API route handlers

## Packages
```bash
npm install twilio
```

## Files to Create

### `src/lib/twilio.ts` — Twilio client and helpers
```ts
import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error("[503] Twilio not configured — run /deploy to provision");
}

export const twilioClient = accountSid && authToken
  ? twilio(accountSid, authToken)
  : null;

/**
 * XML-escape a string for safe TwiML interpolation.
 * Prevents TwiML injection via user-supplied or database-stored values.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
```

### `src/app/api/webhooks/twilio/route.ts` — Webhook handler template
```ts
import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "twilio";

export async function POST(req: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return NextResponse.json({ error: "Service not configured" }, { status: 503 });
  }

  // HMAC-SHA1 signature verification
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = req.url;
  const body = await req.text();
  const params = Object.fromEntries(new URLSearchParams(body));

  if (!validateRequest(authToken, signature, url, params)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Process webhook payload...
  return new NextResponse("<Response></Response>", {
    headers: { "Content-Type": "text/xml" },
  });
}
```

## Environment Variables
```
TWILIO_ACCOUNT_SID=your-account-sid       # Twilio Account SID
TWILIO_AUTH_TOKEN=your-auth-token         # Twilio Auth Token (used for HMAC-SHA1 verification)
TWILIO_PHONE_NUMBER=+1234567890           # Twilio phone number for outbound SMS/calls
```

## Patterns
- Always verify HMAC-SHA1 signatures on incoming webhooks using the Twilio SDK's `validateRequest()` function
- Always XML-escape dynamic values before embedding in TwiML responses using the `escapeXml()` helper
- Validate all FormData fields with zod before building TwiML responses
- Use the `escapeXml()` helper for every interpolated value in TwiML — practice names, phone numbers, URLs, and service lists

## Security
- HMAC-SHA1 signature verification is mandatory on all webhook routes — without it, any caller can spoof Twilio callbacks
- XML-escape all dynamic strings in TwiML to prevent TwiML injection (characters like `<`, `>`, `&`, `"` can inject arbitrary TwiML verbs)
- Validate that dynamic URL values belong to an expected domain before inserting them into TwiML `<Stream>` or `<Redirect>` elements
- Add rate limiting to webhook routes (60 req/min/IP recommended)
- Never log raw request bodies — they may contain PII (phone numbers, caller names)

## CLI Provisioning
No CLI available — credentials must be obtained via the Twilio Console at https://console.twilio.com.

## PR Instructions
- Sign up at https://www.twilio.com and create a project
- Copy Account SID and Auth Token from the dashboard
- Purchase or configure a phone number
- Add env vars to `.env.local`
- Configure the webhook URL in Twilio Console → Phone Numbers → Active Numbers → select number → Messaging/Voice webhook

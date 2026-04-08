---
assumes: [framework/nextjs, database/supabase, auth/supabase]
packages:
  runtime: [resend]
  dev: []
files:  # conditional: requires framework/nextjs, database/supabase, auth/supabase
  - src/lib/email.ts
  - src/app/api/email/welcome/route.ts
  - src/app/api/email/nudge/route.ts
  - vercel.json
env:
  server: [RESEND_API_KEY, CRON_SECRET, RESEND_FROM]
  client: []
ci_placeholders:
  RESEND_API_KEY: re_placeholder_key
  CRON_SECRET: placeholder-cron-secret
  RESEND_FROM: noreply@placeholder.example.com
clean:
  files: []
  dirs: []
gitignore: []
---
Transactional email for retention: welcome email after signup + 24h activation nudge via cron.

## Setup

1. Sign up at [resend.com](https://resend.com) and go to **API Keys** → create a new key
2. Add the key to `.env.local`: `RESEND_API_KEY=re_...`
3. **Domain verification** — optional for local testing (uses `onboarding@resend.dev` sandbox). For production: verify your domain in Resend → Domains, add DNS records (DKIM, SPF, Return-Path). `/deploy` sets `RESEND_FROM=noreply@<domain>` automatically.

## Packages

```bash
npm install resend
```

## Files to Create

### `src/lib/email.ts`

```ts
import { Resend } from "resend";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not configured");
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}


const FROM_ADDRESS = process.env.RESEND_FROM || "onboarding@resend.dev";

export async function sendWelcomeEmail(to: string, name: string, ctaUrl: string) {
  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") return;
  const { error } = await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Welcome to the app, ${name}!`,
    html: `
      <h1>Welcome, ${name}!</h1>
      <p>Thanks for signing up. We built this to help you get started fast.</p>
      <p><a href="${ctaUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">Get Started</a></p>
    `,
  });
  if (error) throw error;
}

export async function sendActivationNudge(to: string, name: string, activationAction: string, ctaUrl: string) {
  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") return;
  const { error } = await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Quick reminder: ${activationAction}`,
    html: `
      <h1>Hey ${name}, you're almost there</h1>
      <p>You signed up but haven't ${activationAction} yet. It only takes a minute.</p>
      <p><a href="${ctaUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">${activationAction}</a></p>
    `,
  });
  if (error) throw error;
}
```

### `src/app/api/email/welcome/route.ts`

When `stack.analytics` is absent: remove the `@/lib/analytics-server` import and the `await trackServerEvent()` call from both email route templates below. The email routes work without analytics.

Called from the auth success callback after `signup_complete`. Sends a welcome email with the value prop and a CTA to complete the activation action.

```ts
import { NextRequest, NextResponse } from "next/server";
import { sendWelcomeEmail } from "@/lib/email";
import { trackServerEvent } from "@/lib/analytics-server";

export async function POST(req: NextRequest) {
  const { email, name, ctaUrl } = await req.json();

  if (!email || !name) {
    return NextResponse.json({ error: "Missing email or name" }, { status: 400 });
  }

  await sendWelcomeEmail(email, name, ctaUrl || "/");
  await trackServerEvent("email_welcome_sent", email, { recipient: email });

  return NextResponse.json({ ok: true });
}
```

### `src/app/api/email/nudge/route.ts`

Called by Vercel Cron daily. Queries the database for users who signed up > 24h ago AND have not yet activated. Sends a nudge email. Skips users already nudged.

```ts
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { sendActivationNudge } from "@/lib/email";
import { trackServerEvent } from "@/lib/analytics-server";

export async function GET(req: NextRequest) {
  // Validate cron secret (timing-safe to prevent side-channel attacks)
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Find users who signed up > 24h ago, not activated, not yet nudged
  const { data: users, error } = await supabase
    .from("user_status")
    .select("user_id, email, name, created_at")
    .lt("created_at", twentyFourHoursAgo)
    .is("activated_at", null)
    .is("nudge_sent_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let sent = 0;
  for (const user of users ?? []) {
    try {
      const daysSinceSignup = Math.floor(
        (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)
      );
      await sendActivationNudge(user.email, user.name, "complete your first action", "/");
      await supabase
        .from("user_status")
        .update({ nudge_sent_at: new Date().toISOString() })
        .eq("user_id", user.user_id);
      await trackServerEvent("email_nudge_sent", user.email, {
        recipient: user.email,
        days_since_signup: daysSinceSignup,
      });
      sent++;
    } catch {
      // Skip individual failures, continue with remaining users
    }
  }

  return NextResponse.json({ ok: true, sent });
}
```

## Vercel Cron Config

### `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/email/nudge",
      "schedule": "0 9 * * *"
    }
  ]
}
```

The cron runs daily at 9am UTC. Add `CRON_SECRET` to your Vercel environment variables — Vercel automatically sends this as an `Authorization: Bearer <CRON_SECRET>` header to cron endpoints.

## Database Requirements

The nudge route needs to identify un-activated users. Add these columns to your user-related table (or create a `user_status` table if no user table exists beyond Supabase auth):

- `activated_at timestamptz` — set when the user completes the activation action
- `nudge_sent_at timestamptz` — set after the nudge email is sent (prevents duplicate nudges)

If using Supabase auth only (no custom users table), create a small `user_status` table:

```sql
create table if not exists user_status (
  user_id uuid primary key references auth.users(id),
  email text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  nudge_sent_at timestamptz
);

alter table user_status enable row level security;

create policy "Service role only" on user_status
  for all using (auth.role() = 'service_role');
```

## Analytics Integration

Welcome and nudge email sends fire server-side events via `trackServerEvent()`. Bootstrap adds the event definitions (`email_welcome_sent`, `email_nudge_sent`) to the experiment/EVENTS.yaml `events` map when `stack.email` is present — see scaffold procedure Step 2 for the canonical event list and properties.

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `RESEND_API_KEY` | Server | Resend API key from resend.com → API Keys |
| `CRON_SECRET` | Server | Vercel Cron secret — auto-sent as Bearer token to cron endpoints |
| `RESEND_FROM` | Server | Sender address for transactional emails. Set by `/deploy` to `noreply@<domain>`. Defaults to `onboarding@resend.dev` (sandbox) when absent. |

## Email Sender Domain

Both pipelines use the same sender domain when `stack.email: resend` is enabled:

| Pipeline | Sender | Configured By |
|----------|--------|---------------|
| Auth emails (confirmation, reset, magic link) | `noreply@<domain>` | `/deploy` Agent A — Supabase SMTP config |
| Transactional emails (welcome, nudge) | `noreply@<domain>` | `/deploy` state-3b — `RESEND_FROM` env var |

`<domain>` = `deploy.domain` from experiment.yaml; fallback `draftlabs.org`.

**Prerequisite:** Verify domain in Resend Dashboard → Domains (one-time, team-level setup).

## Without Auth or Database

Email without auth is not supported — the email stack requires `stack.auth` to know who to send emails to and `stack.database` to track activation status. If either dependency is absent, bootstrap will stop with an error before installing the email stack.

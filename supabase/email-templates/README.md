# FraudShield — Custom email templates for Supabase Auth

Supabase ships with a default "Confirm your email address" template that:
- Sends from `noreply@mail.app.supabase.io` (low deliverability, generic look)
- Uses unbranded plain-text-ish HTML

This directory contains branded HTML for the **Confirm signup**, **Reset password**, and **Magic link** templates that match the FraudShield "Forensic Instrument" visual brief (dark ink + signal-cyan accent + Archivo-styled wordmark, with a system-font fallback because email clients strip web fonts).

## How to apply (one-time, ~3 minutes, no code change)

1. Open https://supabase.com/dashboard/project/golvupqegjprujwrxotb/auth/templates
2. For each of the three templates below:
   - Open the template in the dashboard
   - Replace **Subject heading** and **Message body** with the matching values from the files in this folder
   - Click **Save changes**

| Supabase template | File here | Subject heading |
|---|---|---|
| Confirm signup | [confirm-signup.html](./confirm-signup.html) | Confirm your FraudShield account |
| Reset password | [reset-password.html](./reset-password.html) | Reset your FraudShield password |
| Magic link | [magic-link.html](./magic-link.html) | Your FraudShield sign-in link |

The templates use Supabase's standard Go template variables:
- `{{ .ConfirmationURL }}` — the confirmation link (single-use, expires)
- `{{ .Email }}` — the recipient address (used in the salutation line)
- `{{ .SiteURL }}` — your app's public URL (`https://fraudshield.draftlabs.org`)

## Why we kept the default sender

Switching the **sender address** (from `noreply@mail.app.supabase.io` to e.g. `auth@fraudshield.draftlabs.org`) requires SMTP setup via Resend. That needs:
- A Resend API key
- Domain verification (DKIM + SPF records on draftlabs.org)
- Adding `stack.email: resend` to `experiment.yaml`

For Phase 1 MVP traffic the default sender is fine (it's not blocklisted, just unbranded). When deliverability becomes a measurable problem (signup→confirm conversion drops, signups complain emails go to spam), upgrade with `/change "add stack.email: resend for branded email sender"`.

## Why we did NOT auto-PATCH these via the Management API

The Supabase Management API can update auth templates via `PATCH /v1/projects/{ref}/config/auth` with `mailer_templates_confirmation_content`, but the call requires a Supabase **personal access token**, which on Windows lives in the OS Credential Manager (not on disk) — we couldn't read it programmatically during `/deploy`. The manual paste is faster than the access-token round-trip.

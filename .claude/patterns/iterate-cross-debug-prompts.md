# Iterate Cross — Debug Prompt Templates

These prompt templates are referenced by `state-x4-rank-recommend.md` (and embedded into the per-owner Telegram artifact emitted by `iterate_cross_verdicts.py --emit-telegram`). Each section heading **must** be the verdict name verbatim — the parser in `iterate_cross_verdicts.py:parse_debug_prompts()` keys on `## <VERDICT>` exactly.

Owners copy-paste these into Claude Code from their MVP repo to diagnose the verdict.

---

## NO_DATA

The cross-MVP discovery query found this MVP via gclid traffic on a related domain, but PostHog has no events under its `project_name` (or extracted host). Two possibilities: (a) the MVP isn't deployed at the URL the campaign is pointing to, or (b) the deployed app doesn't have the PostHog snippet loading (or `project_name` global property isn't being set).

Verify in order:

1. Open the deployed production URL in a browser. Does the page load? If no — the MVP isn't deployed; redeploy.
2. In DevTools Network tab, filter for `posthog`. Does any request go out? If no — `posthog.init()` isn't running. Check `NEXT_PUBLIC_POSTHOG_KEY` is set in Vercel production env, and verify `app/layout.tsx` (or equivalent) imports + initializes PostHog.
3. In DevTools Console, run `window.posthog`. If `undefined` — same as step 2.
4. Make a test PostHog event: open Console, run `posthog.capture('test_from_console', { source: 'manual' })`. Then check the PostHog dashboard live events feed. If the event doesn't appear within 30 seconds — the API key is wrong or the project ID is wrong.
5. Verify the PostHog event has `project_name` set as a global property. If not, the cross-MVP query won't group this MVP under its expected name. Compare against `.claude/stacks/analytics/posthog.md` for the expected init pattern.
6. When you append `?gclid=test123` to the URL and reload, does the frontend capture `gclid` into the PostHog event properties for the `$pageview` event? Does `gclid` persist across the session via `$session_entry_gclid`?

   > **Test-gclid convention — use length ≤ 40 OR a prefix that is NOT in `{Cj, EAI, CIa}`.** `/iterate --cross` filters paid traffic by `length > 40 AND prefix in {Cj, EAI, CIa}` — real Google Ads gclids match both. Short sentinels like `test123` work (fail length); readable strings like `MANUAL_VERIFY_CHECK_2026_ANYTHING_LONG_OK` work (fail prefix). Real Google Ads gclids start with `Cj0KCQ`, `CjwKCAjw`, or `EAIaIQob` and are 60-120 chars (base64-url). **Do not use a test gclid that BOTH exceeds 40 chars AND starts with `Cj` / `EAI` / `CIa`** — that would bypass the filter and silently inflate cross-MVP signup/visitor counts. The filter is the single source of truth in `.claude/scripts/lib/gclid_filter.py` (`PAID_GCLID_FILTER`), enforced via state-x0/x1/x2/c2 of the iterate skill.

Report which step failed and what the root cause is. Then propose the minimum fix — don't apply it yet, I'll review first.

---

## WEAK

This MVP is above the visitors floor (≥50 gclid visitors) but has fewer than 3 signups. It's not a clear NO_GO (some users converted) but not yet a GO either. The signal is real but thin — investigate before deciding.

Verify in order:

1. Read `experiment/experiment.yaml` and confirm what the MVP's "signup" actually means. Is `signup_events` in `experiment/iterate-cross-config.yaml mvp_mappings.<this_mvp>.signup_events` correct? If wrong (e.g., a tracking event was excluded), update it and re-run `/iterate --cross`.
2. Open the landing page. Time the path from "first visit" to "completed signup" — count the steps, the form fields, the friction. Anything users would bail at?
3. Check landing page Core Web Vitals (LCP, INP, CLS). Slow page = high bounce.
4. Look at the gclid_visitors:signups ratio. If it's 0.5%, conversion is very low — likely a landing-page or product-message problem. If it's 4%+, conversion works but volume is low — extend the campaign or raise budget.

Report which factor is most likely. Then propose either: (a) a landing-page fix to ship and re-test, OR (b) extend the campaign window for more data.

# Iterate Cross — Debug Prompt Templates

These prompt templates are referenced by `state-x4-rank-recommend.md` (and embedded into the per-owner Telegram artifact emitted by `iterate_cross_verdicts.py --emit-telegram`). Each section heading **must** be the verdict name verbatim — the parser in `iterate_cross_verdicts.py:parse_debug_prompts()` keys on `## <VERDICT>` exactly.

Owners copy-paste these into Claude Code from their MVP repo to diagnose the verdict.

---

## TRACKING_BROKEN

Debug why PostHog tracking isn't reaching production for this MVP. Don't apply fixes yet — diagnose and report.

Verify in order:
1. Is the PostHog SDK installed (`posthog-js` or `@posthog/react` in `package.json`)?
2. Is `posthog.init()` (or `<PostHogProvider>`) wired into the root layout / app entry point?
3. Is `NEXT_PUBLIC_POSTHOG_KEY` set in BOTH `.env.local` AND in the Vercel project's environment variables (production)?
4. Open the deployed production URL in a browser. In DevTools:
   - Does the `posthog-js` bundle load (Network tab)?
   - Does `window.posthog` exist after page load (Console)?
   - When you append `?gclid=test123` to the URL and reload, does the frontend capture `gclid` into the PostHog event properties for the `$pageview` event?
   - Does `gclid` persist to `localStorage` or a cookie so subsequent events on the same session/user also include it?
5. Compare the MVP's analytics library file (`src/lib/analytics.*` or equivalent) against the template's `.claude/stacks/analytics/posthog.md`. Flag any deviation.

Report which step failed and what the root cause is. Then propose the minimum fix — don't apply it yet, I'll review first.

---

## NOT_DEPLOYED

The Google Ads campaign is firing real ad clicks, but PostHog has zero events for this MVP's deploy domain. Two possibilities: (a) the MVP isn't deployed at the URL the campaign is pointing to, or (b) the deployed app doesn't have the PostHog snippet loading.

Verify in order:
1. Open the campaign's Final URL in a browser. Does the page load? If no — the MVP isn't deployed; redeploy.
2. In DevTools Network tab, filter for `posthog`. Does any request go out? If no — `posthog.init()` isn't running. Check `NEXT_PUBLIC_POSTHOG_KEY` is set in Vercel production env, and verify `app/layout.tsx` (or equivalent) imports + initializes PostHog.
3. In DevTools Console, run `window.posthog`. If `undefined` — same as step 2.
4. Make a test PostHog event: open Console, run `posthog.capture('test_from_console', { source: 'manual' })`. Then check the PostHog dashboard live events feed. If the event doesn't appear within 30 seconds — the API key is wrong or the project ID is wrong.

Report which step failed. Don't apply fixes yet — explain the root cause and propose the minimum fix.

---

## CONVERSION_MISCONFIGURED

The sub-account's "Account default" conversion action isn't in the operator's whitelist. This is a soft warning — the cross-MVP comparison still works because we use PostHog's signup events, not Google Ads' conversion column. But Google Ads' own optimization signals (used for Smart Bidding strategies, even though Phase 1 uses Manual CPC) are pointed at the wrong action.

Steps to fix:
1. Open Google Ads → Sub-account → Tools & Settings → Conversions → Goals (or Summary).
2. Find the action labeled "Account default" or the highest-priority Primary action.
3. If it's currently set to a non-sign-up action (e.g., "Page view", "Qualified lead"), edit it to one of: `Sign-up`, `MVP Signup`, `Submit lead form`, or any other action in the operator's `experiment/iterate-cross-config.yaml` `conversion_action_whitelist`.
4. Save and let Google Ads re-classify recent conversions.

This change does NOT affect Phase 1 cross-MVP scoring (we use PostHog), but it makes Google Ads' bid optimization smarter for Phase 2/3 when Smart Bidding is enabled.

---

## STANDARD_VIOLATION

The campaign isn't using Manual CPC — it's running Maximize Clicks, Target CPA, or another auto-bidding strategy. Phase 1 standard requires Manual CPC for fair cross-MVP comparison.

Steps:
1. Open Google Ads → the affected campaign → Settings → Bidding.
2. Change "Bid strategy" to "Manual CPC".
3. Set max CPC to the Keyword Planner's "top of page bid (low range)" for your primary keywords.
4. Reset the total budget to follow Phase 1 click target (run until 50+ clicks; spending under $140 is fine).
5. Re-launch and let the campaign collect data under the standard.

We can't include this MVP in cross-MVP ranking until data is collected under Manual CPC like every other MVP.

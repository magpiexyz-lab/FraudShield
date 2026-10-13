/**
 * Who PostHog thinks the current browser is.
 *
 * THE BUG THIS EXISTS FOR. Client-side events were landing on one PostHog
 * person and server-side events on another, for the same human. A paid test
 * checkout on 12 Oct produced:
 *
 *   checkout_started        (web)          person 5acbff54...  <- anonymous id
 *   subscription_activated  (posthog-node) person 5230fbe3...  <- Supabase user id
 *
 * Server events are sent with `trackServerEvent(event, user.id, ...)`, so the
 * server always uses the Supabase user id. The browser only uses that id once
 * something calls `identify()`. Three pages did call it -- login, signup and
 * reset-password -- but all three are pages the user types into, and TWO of the
 * four ways into an authenticated session do not pass through any of them:
 *
 *   1. Email-confirmation signup. src/app/signup/page.tsx returns early with
 *      "check your email" when no session comes back, BEFORE its identify()
 *      call. The user then confirms via /auth/callback, which is a server route
 *      handler and so cannot run client-side code at all.
 *   2. Google OAuth. Also lands on /auth/callback, same reason.
 *
 * So anyone who signed up by email confirmation or with Google stayed
 * anonymous in the browser for the whole life of that session, while the server
 * reported them under their real user id.
 *
 * WHY IT MATTERS BEYOND A BROKEN FUNNEL VIEW. A funnel from checkout_started to
 * subscription_activated reads 0%, because the two ends belong to different
 * people. Worse, one buyer is counted as two users, which is how a paid
 * acquisition number quietly doubles.
 *
 * NOT an ads-attribution bug: Google Ads conversions are uploaded from the
 * `gclid` column on `public.subscriptions`, which never involved PostHog
 * persons. That path was and is correct.
 *
 * This module holds the DECISION only, as a pure function, so it can be tested
 * under vitest's "node" environment -- this project has no jsdom and cannot
 * render components in unit tests. The component that acts on the decision is
 * src/components/AnalyticsIdentity.tsx.
 */

/**
 * Whether the browser should be re-identified to `userId`.
 *
 * Returns false when there is no signed-in user: `identify()` must never be
 * called with an empty or placeholder id, which would collapse every anonymous
 * visitor into one shared person.
 *
 * Returns false when PostHog already reports `userId` as the distinct id. This
 * is the common case on every page load after the first, and re-identifying
 * each time is not free: posthog-js issues an $identify event, so calling it on
 * every mount would add a write per page view for no new information.
 *
 * Returns true when the distinct id is unknown (`undefined`). PostHog has not
 * loaded yet or is blocked; identifying is the safe choice, because the cost of
 * a redundant identify is one event, while the cost of skipping a needed one is
 * a permanently split person.
 */
export function shouldIdentify(
  currentDistinctId: string | undefined,
  userId: string | null | undefined,
): boolean {
  if (typeof userId !== "string" || userId.length === 0) return false;
  return currentDistinctId !== userId;
}

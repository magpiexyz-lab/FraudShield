/**
 * Trailing-slash normalisation for the proxy's public-path gate.
 *
 * WHY THIS EXISTS. On 2026-11-02 every public URL with a trailing slash was
 * found to be behind the login wall in production:
 *
 *   /guides/fake-pay-stub    200
 *   /guides/fake-pay-stub/   307 -> /login
 *   /pricing/                307 -> /login
 *   /terms/                  307 -> /login
 *
 * Two things combine to cause it. `src/proxy.ts` matched the public set with
 * exact string equality -- `publicPaths.some((p) => pathname === p)` -- and
 * `next.config.ts` sets `skipTrailingSlashRedirect: true`, so Next.js issues no
 * canonicalising redirect and the proxy receives the pathname with the slash
 * still attached. "/pricing/" !== "/pricing", the path falls through to the auth
 * branch, `getUser()` finds no session, and the visitor is redirected.
 *
 * The cost was concentrated exactly where it hurt most: the three SEO guides
 * published on 30 Oct exist to be read by strangers arriving from Google with
 * no account, and /pricing is the page someone is on when they decide whether
 * to pay. Both were auth-walled for anyone whose link carried a slash.
 *
 * WHY IT LIVES IN src/lib RATHER THAN INLINE IN THE PROXY. The gate cannot be
 * exercised locally. `src/proxy.ts` short-circuits on
 * `NEXT_PUBLIC_DEMO_MODE === "true"` before the public-path check is ever
 * reached, and local dev has no Supabase credentials, so a local request to
 * /pricing/ returns 200 whether or not this fix is applied. An inline ternary
 * would therefore have had no reachable test at all -- the fix would ship on the
 * strength of reading it. Pulled out here it is a pure function a unit test can
 * call directly, so the behaviour is pinned by `tests/normalize-path.test.ts`
 * instead of by inspection.
 *
 * WHY NOT JUST DROP skipTrailingSlashRedirect. That would also fix it, but the
 * flag governs every route in the app and sits beside the PostHog
 * `/ingest/:path*` rewrites. Normalising proxy-side is the contained change.
 *
 * WHY NOT ADD "/pricing/" ENTRIES TO publicPaths. That fixes the routes someone
 * remembers and re-arms the trap for the next route added.
 */

/**
 * Strip exactly one trailing slash from a pathname.
 *
 * Exactly one, not all: one slash is what `skipTrailingSlashRedirect` leaves
 * behind, so one slash is what we undo. Greedily stripping `/\/+$/` would make
 * "/pricing//" match the public set, canonicalising a URL the proxy was never
 * asked to canonicalise.
 *
 * The `length > 1` guard is the important half. A bare
 * `pathname.replace(/\/$/, "")` maps "/" to "", which matches no publicPaths
 * entry, so the landing page itself would start bouncing anonymous visitors to
 * /login -- a worse bug than the one this fixes. For any non-empty input the
 * result is non-empty.
 *
 * Total by design: "" returns "" rather than throwing. `request.nextUrl.pathname`
 * is always at least "/", so that input is unreachable from the proxy, and
 * callers need no guard.
 */
export function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

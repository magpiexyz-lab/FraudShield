// Same-origin guard for `?next=` redirect targets.
//
// Why this file exists: /login reads ?next= and hands it to router.push(), and
// /auth/callback reads it and concatenates it onto the origin. Each used to
// carry its own copy of
//
//     raw.startsWith("/") && !raw.startsWith("//")
//
// which is not a same-origin check. Reported and reproduced against production:
//
//     https://fraudshield.draftlabs.org/login?next=/%5Cevil.com
//
//   1. searchParams.get("next") percent-decodes, yielding "/" + backslash + "evil.com".
//   2. The guard passes: the value starts with "/" and not with "//".
//   3. router.push() resolves it RELATIVELY, and WHATWG URL parsing treats a
//      backslash as a forward slash -- so the value is protocol-relative in
//      effect and the resulting host is evil.com.
//
// The victim clicks a genuine first-party link, sees the real login page, types
// real credentials, authenticates, and is then delivered to the attacker.
//
// WHY THE STRIP MUST HAPPEN BEFORE THE PREFIX TEST -- do not "simplify" this.
// A prefix test on its own is bypassable, including the tighter-looking
// /^\/(?![/\])/. The value
//
//     "/" + TAB + backslash + "evil.com"
//
// passes that regex, because the second character is a tab rather than a slash
// or a backslash. But the URL parser REMOVES tab, newline and carriage return
// from anywhere in the input before it parses -- so the backslash slides back
// into second position and the value resolves to https://evil.com/ once more.
// Verified in Node. The guard therefore has to inspect the same string the
// parser will inspect: strip the removed characters FIRST, test the prefix
// SECOND. Reordering these two steps silently reopens the hole.
//
// The STRIPPED value is what gets returned, not the original. The browser acts
// on the stripped form regardless, and handing back a string different from the
// one that was validated is exactly the gap this bug lived in. It also keeps a
// stray CR or LF out of the Location header that /auth/callback builds by
// string concatenation.
//
// Pure and dependency-free, so it is unit-testable without a browser or a
// running Next.js server -- see tests/safe-redirect.test.ts.

/**
 * The characters WHATWG URL parsing removes from its input before parsing:
 * U+0009 TAB, U+000A LF, U+000D CR. Spelled out as its own constant so the link
 * between "what this file removes" and "what the parser removes" stays visible.
 */
const URL_STRIPPED_CHARS = /[\t\n\r]/g;

/**
 * Returns a redirect target guaranteed to stay on this origin, else `fallback`.
 *
 * Accepts only a value whose stripped form begins with a single "/" that is not
 * followed by another "/" or by a backslash -- that is, a genuine in-app path.
 * Query strings and fragments ride along untouched.
 */
export function safeInternalPath(
  raw: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (typeof raw !== "string") return fallback;

  const stripped = raw.replace(URL_STRIPPED_CHARS, "");
  if (!stripped.startsWith("/")) return fallback;

  // The second character decides. "//" is protocol-relative by spec, and the
  // parser folds a backslash into a forward slash, so "/" + backslash is
  // protocol-relative too. Either one leaves this origin.
  const second = stripped.charAt(1);
  if (second === "/") return fallback;
  if (second === "\\") return fallback;

  return stripped;
}

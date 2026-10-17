// Keeping a signed-in user signed in.
//
// WHY IT EXISTS. A user reported on 2026-10-17 that closing the tab and coming
// back meant logging in again. That sounds like a cookie-lifetime problem and
// was not one -- the cookies were correct, they were written to an object that
// was thrown away.
//
// src/proxy.ts builds `response`, hands its cookie jar to the Supabase client,
// and calls getUser(). Access tokens last about an hour; when a returning user
// arrives after that, getUser() spends the refresh token to mint a new pair,
// and Supabase ROTATES refresh tokens -- the old one dies the moment it is
// used. setAll() writes the new pair onto `response`.
//
// On the authenticated path `response` is returned and the new cookies stick.
// On the unauthenticated path the proxy returned a bare
// NextResponse.redirect(), discarding them: old refresh token already spent,
// new one never saved, session unrecoverable.
//
// The fix copies the cookie jar onto the redirect. These tests pin that, and
// pin that the redirect itself still happens -- a fix that leaked the protected
// page to a signed-out visitor would be worse than the bug.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

/** Source with comment lines removed, so prose describing a rule is never
 *  mistaken for the rule itself. */
const codeOnly = (src: string): string =>
  src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const PROXY = read("src", "proxy.ts");
const SERVER = read("src", "lib", "supabase-server.ts");

describe("the proxy does not drop refreshed auth cookies", () => {
  // THE BUG ITSELF. Before the fix the redirect was returned bare, and every
  // cookie Supabase had just refreshed went with it.
  it("copies the response cookie jar onto the redirect", () => {
    const code = codeOnly(PROXY);
    const block = code.slice(code.indexOf("if (!user)"));
    expect(block).toContain("response.cookies.getAll()");
    expect(block).toContain("redirect.cookies.set");
  });

  // The shape that caused it: constructing the redirect and returning it in one
  // step leaves no chance to carry anything over.
  it("never returns a redirect it has not had the chance to populate", () => {
    const code = codeOnly(PROXY);
    expect(code).not.toMatch(/return\s+NextResponse\.redirect\(/);
  });

  // THE THING THE FIX MUST NOT BREAK. Carrying cookies across is only safe if
  // the visitor is still sent to /login -- serving them the protected page
  // instead would be a far worse bug than the one being fixed.
  it("still redirects a signed-out visitor to /login", () => {
    const code = codeOnly(PROXY);
    const block = code.slice(code.indexOf("if (!user)"));
    expect(block).toContain('new URL("/login"');
    expect(block).toContain("NextResponse.redirect(loginUrl)");
  });

  // So they land back where they were going once signed in.
  it("still preserves the attempted path in ?next=", () => {
    expect(codeOnly(PROXY)).toContain('loginUrl.searchParams.set("next", pathname)');
  });
});

describe("the server client cannot crash a page render", () => {
  // Next throws on cookieStore.set() inside a Server Component -- only Route
  // Handlers and Server Actions may write cookies. Supabase calls setAll
  // whenever it refreshes a token, so an ordinary page render by a returning
  // user could throw and take the page down. Safe to swallow: the proxy
  // refreshes on every matched request and has already persisted the pair.
  it("guards the cookie write it is not always allowed to make", () => {
    const code = codeOnly(SERVER);
    const start = code.indexOf("setAll(cookiesToSet)");
    expect(start).toBeGreaterThan(-1);
    const block = code.slice(start, start + 400);
    expect(block).toContain("try {");
    expect(block).toContain("catch");
  });
});

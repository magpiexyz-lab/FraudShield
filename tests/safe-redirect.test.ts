// Regression suite for the open redirect via ?next= on /login.
// See src/lib/safe-redirect.ts for the full explanation of the vulnerability.
//
// vitest runs with environment: "node" and no jsdom, so nothing here renders a
// React component. The predicate is pure, so it is exercised directly, and both
// redirect call sites are checked as SOURCE TEXT -- the root cause was not one
// bad regex but two hand-rolled copies of the same guard drifting apart.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { safeInternalPath } from "@/lib/safe-redirect";

// Built from char codes, not escapes: a literal tab or newline inside a source
// string is invisible to a reviewer, and these bytes are the whole point.
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const FALLBACK = "/dashboard";

// Exactly what searchParams.get("next") hands the login page for ?next=/%5Cevil.com.
// Built through URL so the test proves the percent-decoding path rather than a
// hand-written guess at what the decoder produces.
const DECODED_FROM_QUERY = new URL(
  "https://fraudshield.draftlabs.org/login?next=/%5Cevil.com",
).searchParams.get("next");

const REJECTED: Array<[string, string | null | undefined]> = [
  ["a backslash after the slash (the live exploit)", "/" + BACKSLASH + "evil.com"],
  ["the percent-decoded form off a real query string", DECODED_FROM_QUERY],
  ["two backslashes", "/" + BACKSLASH + BACKSLASH + "evil.com"],
  ["a protocol-relative url (regression guard)", "//evil.com"],
  ["a tab before the backslash (defeats a naive prefix regex)", "/" + TAB + BACKSLASH + "evil.com"],
  ["a newline before the backslash", "/" + NEWLINE + BACKSLASH + "evil.com"],
  ["a carriage return before the slash", "/" + CR + "/evil.com"],
  ["an absolute url", "https://evil.com"],
  ["null", null],
  ["undefined", undefined],
  ["an empty string", ""],
];

const ACCEPTED: Array<[string, string]> = [
  ["a plain in-app path", "/dashboard"],
  ["a path with a query string", "/scan-result?x=1"],
  ["a path with a fragment", "/terms#refunds"],
];

describe("safeInternalPath", () => {
  describe("rejects off-site targets", () => {
    for (const [label, value] of REJECTED) {
      it("falls back to the default for " + label, () => {
        expect(safeInternalPath(value)).toBe(FALLBACK);
      });
    }

    it("honours a caller-supplied fallback", () => {
      expect(safeInternalPath("/" + BACKSLASH + "evil.com", "/login")).toBe("/login");
    });
  });

  describe("accepts genuine in-app paths", () => {
    for (const [label, value] of ACCEPTED) {
      it("returns " + value + " unchanged: " + label, () => {
        expect(safeInternalPath(value)).toBe(value);
      });
    }
  });

  // Documents WHY each rejected value is in the table: resolved against the
  // real origin a browser would use, every one of them leaves the site. Without
  // this, the table above is just a list of strings someone could "tidy up".
  describe("the rejected values really are off-site", () => {
    for (const [label, value] of REJECTED) {
      if (typeof value !== "string") continue;
      if (value === "") continue;
      it(label + " resolves away from fs.app", () => {
        expect(new URL(value, "https://fs.app").host).not.toBe("fs.app");
      });
    }
  });

  // The stripped characters are exactly the ones WHATWG URL parsing removes, so
  // the value handed back must already be the one the browser will act on.
  it("strips tab, newline and CR from the value it returns", () => {
    const messy = "/dash" + TAB + "board" + NEWLINE;
    expect(safeInternalPath(messy)).toBe("/dashboard");
  });
});

// Root-cause guard: both redirect sites must consume the shared predicate. If
// either one grows its own inline prefix check again, the two guards can drift
// apart and the next fix lands on only one of them -- which is exactly how the
// backslash bypass survived in /login while /auth/callback carried a twin copy.
describe("both redirect call sites use the shared predicate", () => {
  const callSites = ["src/app/login/page.tsx", "src/app/auth/callback/route.ts"];
  const read = (relative: string) =>
    readFileSync(path.join(process.cwd(), relative), "utf8");

  for (const relative of callSites) {
    it(relative + " imports safe-redirect", () => {
      const source = read(relative);
      expect(source).toContain("safe-redirect");
      expect(source).toContain("safeInternalPath");
    });

    it(relative + " keeps no hand-rolled prefix guard", () => {
      expect(read(relative)).not.toContain("startsWith(\"//\")");
    });
  }
});

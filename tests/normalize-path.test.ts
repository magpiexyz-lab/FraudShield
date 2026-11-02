import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { normalizePathname } from "@/lib/normalize-path";

const repoRoot = path.resolve(__dirname, "..");
const proxySource = readFileSync(path.join(repoRoot, "src/proxy.ts"), "utf8");

/**
 * The public set, DERIVED from src/proxy.ts rather than retyped.
 *
 * Same parser shape as tests/nav-bar.test.ts (the AC5 guard from PR #100), and
 * for the same reason: src/proxy.ts is the only authority on which routes a
 * signed-out visitor may open. Retyping the list here would mean the next
 * public route added carries no forcing function to prove its slashed form
 * works -- the trailing-slash bug would simply come back for that one route
 * while this file reported green. Parsing the literal means a new entry is
 * covered the moment it lands.
 */
function parsePublicPaths(source: string): string[] {
  const literal = source.match(/const publicPaths\s*=\s*\[([\s\S]*?)\]/);
  if (literal === null) {
    throw new Error(
      "could not find the `const publicPaths = [...]` literal in src/proxy.ts — " +
        "if it was reshaped (split across lines, moved to another module, built " +
        "at runtime), update this parser rather than deleting the assertions it feeds",
    );
  }
  const entries = Array.from(literal[1].matchAll(/["']([^"']+)["']/g)).map(
    (m) => m[1],
  );
  if (entries.length === 0) {
    // FAIL LOUD. An empty list makes every assertion below vacuously true.
    throw new Error(
      "parsed ZERO entries from publicPaths in src/proxy.ts — the derived guard " +
        "would be vacuous, which is worse than no test at all",
    );
  }
  return entries;
}

const publicPaths = parsePublicPaths(proxySource);

describe("normalizePathname: strips exactly one trailing slash", () => {
  it("leaves the root path alone", () => {
    // THE EDGE CASE THAT MATTERS. A naive `pathname.replace(/\/$/, "")` turns
    // "/" into "", and "" matches no publicPaths entry, so the landing page
    // itself would fall through to the auth branch and bounce every anonymous
    // visitor to /login. That is a strictly worse bug than the one being fixed.
    expect(normalizePathname("/")).toBe("/");
  });

  it("strips the trailing slash from a one-segment path", () => {
    expect(normalizePathname("/pricing/")).toBe("/pricing");
  });

  it("leaves an already-unslashed path untouched", () => {
    expect(normalizePathname("/pricing")).toBe("/pricing");
  });

  it("strips the trailing slash from a nested path", () => {
    // The reported symptom: /guides/fake-pay-stub returned 200 while
    // /guides/fake-pay-stub/ returned 307 to /login (production, 2026-11-02).
    expect(normalizePathname("/guides/fake-pay-stub/")).toBe(
      "/guides/fake-pay-stub",
    );
  });

  it("strips exactly ONE slash, not every trailing slash", () => {
    // Deliberate: "exactly one" is the contract. A greedy /\/+$/ strip would
    // make "/pricing//" match publicPaths, quietly canonicalising a URL the
    // proxy was never asked to canonicalise. One slash is what
    // skipTrailingSlashRedirect leaves behind; one slash is what we undo.
    expect(normalizePathname("/pricing//")).toBe("/pricing/");
    expect(normalizePathname("//")).toBe("/");
    expect(normalizePathname("///")).toBe("//");
  });

  it("is idempotent on its own output", () => {
    for (const p of publicPaths) {
      expect(normalizePathname(normalizePathname(p))).toBe(
        normalizePathname(p),
      );
    }
  });
});

describe("normalizePathname: never empties a non-empty pathname", () => {
  const inputs = [
    "/",
    "//",
    "///",
    "/a",
    "/a/",
    "/a/b/",
    "/pricing",
    "/pricing/",
    "/dashboard/",
    "/guides/fake-pay-stub/",
    "no-leading-slash",
    "no-leading-slash/",
    ...publicPaths,
    ...publicPaths.map((p) => `${p}/`),
  ];

  it.each(inputs)("never returns an empty string for %j", (input) => {
    // The invariant that protects the gate: a non-empty pathname must stay
    // non-empty, because "" matches no publicPaths entry and would auth-wall
    // whatever route produced it.
    expect(normalizePathname(input)).not.toBe("");
    expect(normalizePathname(input).length).toBeGreaterThan(0);
  });

  it("returns the empty string unchanged, the one degenerate input", () => {
    // Documented, not asserted away. `request.nextUrl.pathname` is always at
    // least "/", so "" is unreachable from the proxy; the function stays total
    // rather than throwing so callers need no guard. Stated explicitly so a
    // future reader knows the "never empty" invariant above is scoped to
    // non-empty input by design, not by oversight.
    expect(normalizePathname("")).toBe("");
  });
});

describe("normalizePathname: every public path matches in both forms", () => {
  it.each(publicPaths)(
    "%s is recognised with and without a trailing slash",
    (publicPath) => {
      const slashed = publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
      // Both forms must normalise to something the exact-equality membership
      // test in src/proxy.ts accepts.
      expect(publicPaths).toContain(normalizePathname(publicPath));
      expect(publicPaths).toContain(normalizePathname(slashed));
    },
  );

  it("covers every public path, not a hand-picked subset", () => {
    // Guards the parser itself: if the literal is reshaped so the regex
    // captures only the first entry, this fails instead of silently testing
    // one route.
    expect(publicPaths.length).toBeGreaterThanOrEqual(11);
    expect(publicPaths).toContain("/");
    expect(publicPaths).toContain("/pricing");
    expect(publicPaths).toContain("/terms");
    expect(publicPaths).toContain("/guides/fake-pay-stub");
  });
});

describe("normalizePathname: gated routes stay gated (AC3)", () => {
  // THE WHOLE POINT OF NORMALISING ONLY THE MEMBERSHIP TEST. Stripping the
  // slash cannot open a private route, because the stripped form of a gated
  // route is still absent from publicPaths and so still falls through to the
  // auth branch. Asserted with the real function against the real parsed
  // array rather than argued in a comment.
  const gated = [
    "/dashboard",
    "/dashboard/",
    "/scan-result",
    "/scan-result/",
    "/settings/",
  ];

  it.each(gated)("%s is not a public path after normalisation", (route) => {
    expect(publicPaths).not.toContain(normalizePathname(route));
  });

  it("does not normalise the pathname used by the auth branch", () => {
    // The `next=` param must carry the URL the visitor actually asked for, so
    // the post-login redirect lands them where they were going. It reads the
    // raw `pathname`, never the normalised value.
    expect(proxySource).toContain(
      'loginUrl.searchParams.set("next", pathname)',
    );
    expect(proxySource).not.toMatch(
      /searchParams\.set\(\s*"next"\s*,\s*normalized/,
    );
  });

  it("confines normalizePathname to a single call site", () => {
    // If a later edit normalises inside the auth branch too, this fails. One
    // call site is the contract: computed once, used only by the membership
    // test.
    const calls = Array.from(proxySource.matchAll(/normalizePathname\s*\(/g));
    expect(calls).toHaveLength(1);
  });
});

describe("proxy.ts wires normalisation in before the membership test (AC2)", () => {
  it("imports normalizePathname from src/lib", () => {
    expect(proxySource).toMatch(
      /import\s*\{\s*normalizePathname\s*\}\s*from\s*["'][^"']*lib\/normalize-path["']/,
    );
  });

  it("calls normalizePathname BEFORE the publicPaths membership test", () => {
    // ORDERING IS LOAD-BEARING, SO IT IS COMPARED AS SOURCE INDICES. Asserting
    // only that both strings appear would pass just as happily if a future
    // refactor moved the call below the gate -- at which point the gate reads
    // an out-of-scope or stale value and the trailing-slash bug is back with
    // every test still green. Index comparison is what makes a reorder fail.
    const callIndex = proxySource.search(
      /const\s+normalized\s*=\s*normalizePathname\s*\(/,
    );
    const membershipIndex = proxySource.indexOf("publicPaths.some(");

    expect(callIndex).toBeGreaterThan(-1);
    expect(membershipIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeLessThan(membershipIndex);
  });

  it("compares the normalised value, not the raw pathname, in the gate", () => {
    const membership = proxySource.match(/publicPaths\.some\(([^)]*\)[^)]*)\)/);
    expect(membership).not.toBeNull();
    expect(membership?.[1]).toContain("normalized");
    // The exact-equality check against the RAW pathname is the bug. It must be
    // gone, not merely supplemented.
    expect(membership?.[1]).not.toMatch(/pathname\s*===/);
  });

  it("does not inline the call into the predicate", () => {
    // Computing it inside `some()` re-runs it once per entry and, more to the
    // point, puts the value out of reach of anything else in the gate.
    const membership = proxySource.match(/publicPaths\.some\(([^)]*\)[^)]*)\)/);
    expect(membership?.[1]).not.toContain("normalizePathname");
  });

  it("leaves skipTrailingSlashRedirect in next.config.ts untouched", () => {
    // The contained fix is proxy-side. Dropping the flag would also make
    // /pricing/ work, but it governs every route in the app and sits beside
    // the PostHog /ingest rewrites, so it is deliberately not the lever used.
    const nextConfig = readFileSync(
      path.join(repoRoot, "next.config.ts"),
      "utf8",
    );
    expect(nextConfig).toContain("skipTrailingSlashRedirect: true");
  });

  it("does not add trailing-slash twins to publicPaths", () => {
    // Treating the symptom: a "/pricing/" entry beside "/pricing" would fix
    // one route and re-arm the trap for the next one added.
    const twins = publicPaths.filter((p) => p !== "/" && p.endsWith("/"));
    expect(twins).toEqual([]);
  });
});

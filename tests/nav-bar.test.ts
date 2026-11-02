import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const navSource = read("src/components/nav-bar.tsx");
const proxySource = read("src/proxy.ts");

// vitest runs environment "node" with no jsdom in this project, so the component
// cannot be rendered. These assertions read the module source instead. The
// behavioural proof that the rendered nav is correct lives in
// e2e/nav-auth.spec.ts, which drives a real browser signed out.

/**
 * The fragment that is rendered only once a session is resolved AND present.
 * Captured by brace matching from the `gatedNavLinks` binding so the tests can
 * ask which links are inside it versus outside it.
 */
function extractFragment(source: string, binding: string): string {
  const start = source.indexOf(`const ${binding} = (`);
  if (start === -1) {
    throw new Error(
      `binding '${binding}' not found in nav-bar.tsx — the auth-gated split is missing`,
    );
  }
  const open = source.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced parentheses while reading '${binding}'`);
}

/**
 * The auth-gated set, DERIVED rather than listed.
 *
 * src/proxy.ts is the only authority on which routes a signed-out visitor may
 * open: `publicPaths.some((p) => pathname === p)` is the exact check the proxy
 * runs, and anything absent from that array gets redirected to /login. So the
 * gated set is its complement, and the honest way to test the nav is to read
 * that array rather than restate it.
 *
 * Restating it is what the first version of this file did -- it named
 * `href="/dashboard"` and `href="/scan-result"` and nothing else. That guards
 * only the two routes that existed the day it was written. The next page
 * appended to the nav carries NO forcing function to declare whether it is
 * public, so a hand-maintained list silently stops guarding the moment someone
 * forgets to extend it, and the test keeps reporting green while the nav offers
 * a signed-out stranger a link that bounces them to /login. Deriving the set
 * means the person who adds the link does not have to remember anything: if the
 * route is not in proxy.ts publicPaths, this file fails.
 */
function parsePublicPaths(source: string): Set<string> {
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
    // FAIL LOUD. An empty set makes every assertion below vacuously true:
    // "no gated route is public" passes trivially when nothing is public, and
    // "every public link is a known public path" would fail for the wrong
    // reason. A test that cannot tell you anything must say so, not pass.
    throw new Error(
      "parsed ZERO entries from publicPaths in src/proxy.ts — the derived guard " +
        "would be vacuous, which is worse than no test at all",
    );
  }
  return new Set(entries);
}

/** Every internal `href="/..."` literal inside a fragment, in source order. */
function hrefsIn(fragment: string): string[] {
  return Array.from(fragment.matchAll(/href="(\/[^"]*)"/g)).map((m) => m[1]);
}

describe("nav-bar: auth-gated links are hidden from signed-out visitors", () => {
  it("puts /dashboard and /scan-result in the gated fragment", () => {
    const gated = extractFragment(navSource, "gatedNavLinks");
    expect(gated).toContain('href="/dashboard"');
    expect(gated).toContain('href="/scan-result"');
  });

  it("keeps /pricing out of the gated fragment", () => {
    // /pricing is in proxy.ts publicPaths as a deliberate hand-added entry: it is
    // the paywall destination, and gating it bounced signed-out visitors to
    // /login at the exact moment they were deciding whether to pay. It must stay
    // visible to everyone, so it belongs in the public fragment.
    const gated = extractFragment(navSource, "gatedNavLinks");
    expect(gated).not.toContain('href="/pricing"');

    const publicLinks = extractFragment(navSource, "publicNavLinks");
    expect(publicLinks).toContain('href="/pricing"');
  });

  it("guards the gated fragment on both loading and user", () => {
    // Treating `loading` as anonymous is the point. Rendering the gated links
    // first and retracting them once auth resolves is the defect being fixed,
    // so a guard on `user` alone is not sufficient.
    const guard = navSource.match(/const showGatedLinks\s*=\s*([^;]+);/);
    expect(guard).not.toBeNull();
    expect(guard![1]).toContain("loading");
    expect(guard![1]).toContain("user");
  });

  it("applies the guard at both the desktop and the mobile render site", () => {
    // navLinks is consumed twice — the desktop bar and the mobile hamburger
    // Sheet. A fix applied to one branch only would leave the bug alive on
    // phones, which is where most search traffic reads these pages.
    const uses = navSource.match(/\{showGatedLinks && gatedNavLinks\}/g) ?? [];
    expect(uses).toHaveLength(2);
  });
});

describe("nav-bar: the public/gated split is derived from proxy.ts, not listed", () => {
  // AC5. These assertions never name a route. They compare the nav's two
  // fragments against the proxy's public-path set, so they extend themselves to
  // routes that do not exist yet.
  const publicPaths = parsePublicPaths(proxySource);

  it("parses a non-empty public path set out of src/proxy.ts", () => {
    // Sanity gate for everything below: if this set were empty, or either
    // fragment held no links, the comparisons would be vacuously green.
    expect(publicPaths.size).toBeGreaterThan(0);
    expect(hrefsIn(extractFragment(navSource, "publicNavLinks")).length).toBeGreaterThan(0);
    expect(hrefsIn(extractFragment(navSource, "gatedNavLinks")).length).toBeGreaterThan(0);
  });

  it("offers signed-out visitors only routes proxy.ts treats as public", () => {
    // THE LOAD-BEARING ASSERTION. publicNavLinks renders for everyone,
    // including a crawler and a stranger arriving from search. Every href in it
    // must be a path the proxy lets through unauthenticated; otherwise the nav
    // is advertising a redirect to /login. Note that proxy.ts matches by exact
    // equality, so this comparison is exact equality too -- a "/guides" prefix
    // entry would not cover "/guides/fake-pay-stub", and neither does this.
    const offered = hrefsIn(extractFragment(navSource, "publicNavLinks"));
    const gatedButOffered = offered.filter((href) => !publicPaths.has(href));
    expect(
      gatedButOffered,
      `these hrefs are rendered in publicNavLinks but are NOT in publicPaths in ` +
        `src/proxy.ts, so a signed-out visitor who clicks them is redirected to ` +
        `/login: ${JSON.stringify(gatedButOffered)}. Either add the route to ` +
        `publicPaths (if it really should be reachable without an account) or ` +
        `move the <Link> into gatedNavLinks.`,
    ).toEqual([]);
  });

  it("refuses to run on an empty or unparseable publicPaths set", () => {
    // Proves the vacuity guard rather than asserting it in a comment. If
    // proxy.ts ever stops yielding paths -- renamed binding, built at runtime,
    // array emptied -- the two assertions in this block would otherwise go
    // quietly green while checking nothing, which is the failure mode this
    // whole file exists to prevent. Synthetic sources, so proxy.ts is untouched.
    expect(() => parsePublicPaths("const publicPaths = [];")).toThrow(
      /parsed ZERO entries/,
    );
    expect(() => parsePublicPaths("const somethingElse = 1;")).toThrow(
      /could not find the `const publicPaths/,
    );
    // And it really does read the literal, rather than matching anything.
    expect(parsePublicPaths('const publicPaths = ["/", "/login"];')).toEqual(
      new Set(["/", "/login"]),
    );
  });

  it("keeps the gated fragment free of routes that are already public", () => {
    // The mirror of the above, and it catches the opposite mistake: a public
    // page hidden behind the session guard is invisible to search traffic and
    // to anyone deciding whether to sign up, which is the exact harm /pricing
    // being gated used to cause.
    const gated = hrefsIn(extractFragment(navSource, "gatedNavLinks"));
    const publicButHidden = gated.filter((href) => publicPaths.has(href));
    expect(
      publicButHidden,
      `these hrefs sit in gatedNavLinks but ARE in publicPaths in src/proxy.ts, ` +
        `so they are needlessly hidden from signed-out visitors: ` +
        `${JSON.stringify(publicButHidden)}. Move them into publicNavLinks.`,
    ).toEqual([]);
  });
});

describe("nav-bar: route-reachability literals are preserved", () => {
  // REGRESSION GUARD — do not "simplify" this away.
  //
  // The bg2-wire-nav-reachability gate (.claude/patterns/gate-evidence-rules.json,
  // described in .claude/scripts/lib/README.md) proves every static scope page is
  // reachable by bare-slug `href=` SUBSTRING matching against this exact file.
  //
  // Refactoring the links into a data array — `{ href: "/dashboard", label:
  // "Dashboard" }` mapped over — reads better and deletes those literals, which
  // silently fails route reachability on a future /change or /bootstrap run.
  // Nothing else in the repo catches that. This test is the only thing standing
  // between a tidy-looking refactor and a broken gate.
  it("keeps the literal href strings a substring matcher can find", () => {
    expect(navSource).toContain('href="/dashboard"');
    expect(navSource).toContain('href="/scan-result"');
  });

  it("keeps the DERIVED-FROM provenance comment", () => {
    // nav-bar.tsx is emitted once at bootstrap from derive_scope_pages() and
    // hand-edited thereafter — nothing regenerates it. The comment is the only
    // record of where the link set came from.
    expect(navSource).toContain("DERIVED-FROM: derive_scope_pages");
  });
});

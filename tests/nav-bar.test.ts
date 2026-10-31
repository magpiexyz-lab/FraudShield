import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const navSource = read("src/components/nav-bar.tsx");

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

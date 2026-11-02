// THE FAIL-OPEN HOLE, AND THE ONLY THING THAT CAN SEE IT.
//
// hasProAccess decides Pro from three columns: status, stripe_subscription_id
// and current_period_end. The third one is what expires a comped grant, and a
// comp is NULL-dated by design -- every grant written before migration 009 has
// no end date and must keep working forever. So "no end date" has to mean
// "never expires".
//
// Which means a read site that FORGETS to select current_period_end is
// indistinguishable, at the predicate, from a lifetime grant. The field arrives
// undefined, the rule reads it as "no end date", and the user keeps Pro for
// ever. It fails OPEN, it throws no error, it logs nothing, and in review the
// diff looks like a shorter select string.
//
// Types cannot catch it either: every one of these rows arrives from Supabase
// as untyped JSON and is cast at the call site, so a cast to a Pick<> that
// claims a column the select never asked for compiles cleanly.
//
// Hence a test that reads the source. It is a source-grep, which normally pins
// a spelling rather than a behaviour -- here the spelling IS the behaviour,
// because the column list in the select string is the only place the decision's
// inputs are chosen.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) =>
  readFileSync(path.join(repoRoot, ...p), "utf8");

/** Drop `//` line comments so prose about a select is never mistaken for one. */
const codeOnly = (src: string) =>
  src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

/**
 * Every place that reads the subscriptions row to decide entitlement.
 *
 * DELIBERATELY NOT the Stripe webhook (src/app/api/webhooks/stripe/route.ts).
 * That file WRITES subscription state and reads only what it needs to write
 * correctly (scan_credits, cancel_at_period_end); Stripe is its authority and
 * it grants nobody access.
 */
const ENTITLEMENT_READS: ReadonlyArray<{
  readonly label: string;
  readonly file: readonly string[];
}> = [
  { label: "/api/scan quota gate", file: ["src", "app", "api", "scan", "route.ts"] },
  { label: "the dashboard meter", file: ["src", "app", "dashboard", "page.tsx"] },
  {
    label: "the scan-result paywall",
    file: ["src", "app", "scan-result", "scan-result-client.tsx"],
  },
  {
    label: "the pricing page's buy buttons",
    file: ["src", "app", "pricing", "pricing-plans.tsx"],
  },
  {
    label: "the already_subscribed guard",
    file: ["src", "app", "api", "checkout", "route.ts"],
  },
  {
    label: "the billing portal",
    file: ["src", "app", "api", "billing-portal", "route.ts"],
  },
];

/** The two columns a select must carry for the predicate to be answerable. */
const REQUIRED_COLUMNS = ["stripe_subscription_id", "current_period_end"] as const;

type ParsedSelect = { label: string; file: string; columns: string };

/**
 * Pull the select column list out of every `from("subscriptions")` chain.
 *
 * THROWS, at module load, when a declared site yields no select at all. A
 * vacuous pass here is worse than having no test: this file is the only thing
 * standing between a shortened select and perpetual free Pro, so if it ever
 * stops being able to find the selects it must take the suite down with it
 * rather than report green on zero assertions. A renamed file, a refactor into
 * a helper, or a switch to a variable column list all land here.
 */
function parseSelects(): ParsedSelect[] {
  const found: ParsedSelect[] = [];
  for (const site of ENTITLEMENT_READS) {
    const rel = site.file.join("/");
    const src = codeOnly(read(...site.file));
    const pattern =
      /\.from\(\s*"subscriptions"\s*\)[\s\S]{0,400}?\.select\(\s*"([^"]*)"/g;
    let hits = 0;
    for (const match of src.matchAll(pattern)) {
      hits += 1;
      found.push({ label: site.label, file: rel, columns: match[1] });
    }
    if (hits === 0) {
      throw new Error(
        `entitlement-select-coverage could not parse any subscriptions select in ${rel} ` +
          `(${site.label}). This test is the only guard against a read site ` +
          `silently dropping current_period_end and granting perpetual Pro. ` +
          `Either the read moved, or it no longer uses a literal column list -- ` +
          `fix the parser or this guard is a comment.`,
      );
    }
  }
  return found;
}

const SELECTS = parseSelects();

describe("entitlement selects ask for everything the Pro rule reads", () => {
  // FAIL LOUD ON ZERO. parseSelects() already throws per missing site; this
  // asserts the aggregate, so a future edit that empties ENTITLEMENT_READS --
  // and would otherwise register no cases at all below -- is caught too.
  it("parsed at least one select for every declared read site", () => {
    expect(SELECTS.length).toBeGreaterThanOrEqual(ENTITLEMENT_READS.length);
    expect(ENTITLEMENT_READS.length).toBeGreaterThan(0);
    const files = new Set(SELECTS.map((s) => s.file));
    expect(files.size).toBe(ENTITLEMENT_READS.length);
  });

  it.each(SELECTS)(
    "$file ($label) selects the entitlement columns",
    ({ columns, file }) => {
      for (const column of REQUIRED_COLUMNS) {
        expect(
          columns.includes(column),
          `${file} selects "${columns}" -- missing ${column}. Without it the Pro ` +
            `rule sees undefined, reads that as a lifetime grant, and hands out ` +
            `perpetual Pro to an expired comp.`,
        ).toBe(true);
      }
    },
  );

  // status is what the first branch of the rule tests. No site has ever
  // dropped it, which is exactly why it is worth pinning alongside the two new
  // columns rather than only guarding this month's bug.
  it.each(SELECTS)("$file ($label) still selects status", ({ columns }) => {
    expect(columns.includes("status")).toBe(true);
  });
});

describe("the checkout guard goes through the rule, not the column", () => {
  const CHECKOUT = ["src", "app", "api", "checkout", "route.ts"];

  // THE COUPLED DEFECT. Expiring a comp is only half a fix: the row still says
  // status "active", so a guard comparing status directly would refuse the
  // expired comp a subscription -- locking the exact cohort the business wants
  // to convert out of paying. The refusal has to ask "do they hold Pro RIGHT
  // NOW", which is the predicate, not the column.
  it("refuses a second subscription via hasProAccess", () => {
    const code = codeOnly(read(...CHECKOUT));
    expect(code).toContain("hasProAccess");
    expect(code).not.toMatch(/status\s*===\s*"active"/);
  });

  // Unchanged and worth pinning: the 409 still exists, and still happens
  // before any Stripe session is created.
  it("still returns already_subscribed before creating a session", () => {
    const src = read(...CHECKOUT);
    expect(src).toContain("already_subscribed");
    expect(src.indexOf("status: 409")).toBeLessThan(
      src.indexOf("sessions.create"),
    );
  });

  // The pricing page suppresses its buy buttons from the same rule. An expired
  // comp must see them: their row says active, so a direct comparison would
  // show them "You're on Pro" with nothing to click.
  it("drives the pricing page's subscribed state from hasProAccess", () => {
    const code = codeOnly(read("src", "app", "pricing", "pricing-plans.tsx"));
    expect(code).toContain("hasProAccess");
    expect(code).not.toMatch(/status\s*===\s*"active"/);
  });
});

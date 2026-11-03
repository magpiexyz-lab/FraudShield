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
// because the column list in the select string is the only place the decision
// inputs are chosen.
//
// WHY THIS WALKS THE TREE INSTEAD OF LISTING FILES. It used to be a hardcoded
// list of six paths, and a list of paths can only ever guard the files someone
// remembered to add. Two ways through it were demonstrated:
//
//   1. A NEW file doing from("subscriptions").select("status") and feeding the
//      row to hasProAccess. Not on the list, never opened, suite green.
//   2. A SECOND read in a file already on the list, using a backtick template
//      literal for the column list. The old parser only captured
//      double-quoted literals, and the existing literal read kept the
//      per-file hit count above zero, so nothing threw.
//
// So the guard now discovers its own subjects: every from("subscriptions") in
// src/**, found by walking the tree. Anything it cannot PARSE is a failure
// rather than a skip -- a template literal or a computed column list is the
// one shape that hides the column names from a source-grep, so it has to be
// loud. An exemption exists for reads that decide no entitlement, and a file
// claiming it must not touch the predicate.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const SRC_DIR = path.join(repoRoot, "src");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/** Drop comment lines so prose about a select is never mistaken for one. */
const codeOnly = (src: string) =>
  src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

/** Every TypeScript source file under src/, repo-relative, POSIX separators. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(abs));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path.relative(repoRoot, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

/** The columns a select must carry for the predicate to be answerable. */
const REQUIRED_COLUMNS = [
  "status",
  "stripe_subscription_id",
  "current_period_end",
] as const;

/**
 * Reads of the subscriptions row that decide NO entitlement.
 *
 * An exemption from the column requirement, not from the parser: these files
 * are still walked, and a select they cannot parse still fails. Each is also
 * asserted to be free of the predicate below, so the exemption cannot be used
 * to smuggle in an entitlement read.
 */
const NON_ENTITLEMENT: ReadonlyArray<{
  readonly file: string;
  readonly reason: string;
}> = [
  {
    file: "src/app/api/webhooks/stripe/route.ts",
    reason:
      "WRITES subscription state and reads only what it needs to write " +
      "correctly (scan_credits, plan, cancel_at_period_end). Stripe is its " +
      "authority and it grants nobody access.",
  },
  {
    file: "src/app/api/billing-portal/route.ts",
    reason:
      "Resolves stripe_customer_id so it can open a Stripe portal. It makes " +
      "no access decision, so the entitlement columns would be a pure " +
      "over-fetch justified only by this test.",
  },
];

/**
 * The functions that consume an entitlement row. A file exempted above must
 * mention none of them: if it does, its read is an entitlement read whatever
 * the allowlist claims.
 */
const PREDICATES = ["hasProAccess", "computeQuota", "scanWindowStart"] as const;

/**
 * Read sites that must keep existing. The walk finds new ones on its own; this
 * is the other direction -- a read being deleted, renamed or moved out of
 * src/ would otherwise just shrink the subject list and report green.
 */
const KNOWN_ENTITLEMENT_READS = [
  "src/app/api/scan/route.ts",
  "src/app/api/checkout/route.ts",
  "src/app/dashboard/page.tsx",
  "src/app/scan-result/scan-result-client.tsx",
  "src/app/pricing/pricing-plans.tsx",
] as const;

type Site = {
  readonly file: string;
  readonly kind: "read" | "write";
  /** The literal column list, for a read. */
  readonly columns: string | null;
};

/**
 * Every from("subscriptions") chain in src/**, classified.
 *
 * THROWS, at module load, on anything it cannot read with confidence. A
 * vacuous pass here is worse than having no test: this file is the only thing
 * standing between a shortened select and perpetual free Pro, so when it stops
 * being able to see the column names it has to take the suite down with it
 * rather than quietly skip the site it could not parse.
 */
function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const code = codeOnly(read(file));
    for (const hit of code.matchAll(/\.from\(\s*"subscriptions"\s*\)/g)) {
      const from = hit.index + hit[0].length;
      const tail = code.slice(from, from + 600);
      const op = tail.match(/\.(select|upsert|update|insert|delete)\(/);
      if (!op) {
        throw new Error(
          `${file}: a from("subscriptions") chain has no recognisable ` +
            `select/upsert/update/insert/delete within 600 characters, so ` +
            `this guard cannot tell whether it reads the entitlement ` +
            `columns. Make the chain legible or this guard is a comment.`,
        );
      }
      if (op[1] !== "select") {
        sites.push({ file, kind: "write", columns: null });
        continue;
      }
      const afterSelect = tail.slice((op.index ?? 0) + op[0].length);
      // THE EVASION THIS CLOSES. A backtick template literal, or a variable
      // holding the column list, hides the names from any source-grep -- and
      // the old parser simply did not match, which read as "nothing to check"
      // instead of "cannot check". Only a plain double-quoted literal is
      // readable, so anything else is a failure.
      const literal = afterSelect.match(/^\s*"([^"]*)"/);
      if (!literal) {
        throw new Error(
          `${file}: a from("subscriptions").select(...) does not use a plain ` +
            `double-quoted string literal, so its column list cannot be ` +
            `read from source. A template literal or a computed list hides ` +
            `the very column whose absence grants perpetual Pro. Found: ` +
            `${JSON.stringify(afterSelect.slice(0, 80))}`,
        );
      }
      sites.push({ file, kind: "read", columns: literal[1] });
    }
  }
  return sites;
}

const SITES = collectSites();
const READS = SITES.filter((s) => s.kind === "read");
const EXEMPT = new Set(NON_ENTITLEMENT.map((e) => e.file));
const ENTITLEMENT_READS = READS.filter((s) => !EXEMPT.has(s.file));

describe("entitlement selects ask for everything the Pro rule reads", () => {
  // FAIL LOUD ON ZERO. collectSites() throws on anything unparseable; this
  // asserts the walk actually found subjects, so a broken walk -- a moved
  // src/, a changed extension -- cannot report green on no assertions.
  it("found entitlement reads to check", () => {
    expect(ENTITLEMENT_READS.length).toBeGreaterThan(0);
    const files = new Set(ENTITLEMENT_READS.map((s) => s.file));
    for (const known of KNOWN_ENTITLEMENT_READS) {
      expect(
        files.has(known),
        `${known} no longer contains a parseable subscriptions read. If the ` +
          `read moved, move this entry with it; if it was removed, say so ` +
          `here. Shrinking the subject list in silence is how this guard ` +
          `stops guarding.`,
      ).toBe(true);
    }
  });

  it.each(ENTITLEMENT_READS)(
    "$file selects the columns the Pro rule reads",
    ({ columns, file }) => {
      for (const column of REQUIRED_COLUMNS) {
        expect(
          columns!.includes(column),
          `${file} selects "${columns}" -- missing ${column}. Without it the ` +
            `Pro rule sees undefined, reads that as a lifetime grant, and ` +
            `hands out perpetual Pro to an expired comp. If this read ` +
            `decides no entitlement, add it to NON_ENTITLEMENT with a ` +
            `reason -- do not shorten the rule to fit the select.`,
        ).toBe(true);
      }
    },
  );
});

describe("the non-entitlement exemption cannot be abused", () => {
  // AN ALLOWLIST IS ONLY AS GOOD AS WHAT IT CANNOT EXCUSE. Exempting a file
  // from the column requirement is safe exactly while that file decides no
  // access. The moment it calls the predicate, its short select is the
  // original bug again -- so the exemption is conditional on the file not
  // importing the decision.
  it.each(NON_ENTITLEMENT)(
    "$file never consumes an entitlement row",
    ({ file, reason }) => {
      const code = codeOnly(read(file));
      for (const predicate of PREDICATES) {
        expect(
          code.includes(predicate),
          `${file} is exempt from the entitlement-column requirement ` +
            `because: ${reason} -- but it now calls ${predicate}, so it DOES ` +
            `decide entitlement from this row. Remove the exemption and ` +
            `select the entitlement columns.`,
        ).toBe(false);
      }
    },
  );

  // A STALE EXEMPTION IS A HOLE WAITING FOR A FILE. If the read it was written
  // for is gone, the entry outlives its reason and silently covers whatever
  // that path holds next.
  it.each(NON_ENTITLEMENT)("$file still reads the row at all", ({ file }) => {
    expect(SITES.some((s) => s.file === file)).toBe(true);
  });
});

describe("the checkout guard goes through the rule, not the column", () => {
  const CHECKOUT = "src/app/api/checkout/route.ts";

  // THE COUPLED DEFECT. Expiring a comp is only half a fix: the row still says
  // status "active", so a guard comparing status directly would refuse the
  // expired comp a subscription -- locking the exact cohort the business wants
  // to convert out of paying. The refusal has to ask "do they hold Pro RIGHT
  // NOW", which is the predicate, not the column.
  it("refuses a second subscription via hasProAccess", () => {
    const code = codeOnly(read(CHECKOUT));
    expect(code).toContain("hasProAccess");
    expect(code).not.toMatch(/status\s*===\s*"active"/);
  });

  // Unchanged and worth pinning: the 409 still exists, and still happens
  // before any Stripe session is created.
  it("still returns already_subscribed before creating a session", () => {
    const src = read(CHECKOUT);
    expect(src).toContain("already_subscribed");
    expect(src.indexOf("status: 409")).toBeLessThan(
      src.indexOf("sessions.create"),
    );
  });

  // The pricing page suppresses its buy buttons from the same rule. An expired
  // comp must see them: their row says active, so a direct comparison would
  // show them "You are on Pro" with nothing to click.
  it("drives the pricing page subscribed state from hasProAccess", () => {
    const code = codeOnly(read("src/app/pricing/pricing-plans.tsx"));
    expect(code).toContain("hasProAccess");
    expect(code).not.toMatch(/status\s*===\s*"active"/);
  });

  // THE HALF THAT GOT LEFT BEHIND. computeQuota moved to the predicate and
  // scanWindowStart -- the function that picks the window the allowance is
  // counted over -- kept its own status === "active". The two then disagreed
  // about who was paid, and an expired comp drew the free allowance over a
  // monthly window: its free scan and every purchased credit re-granted every
  // month, for ever. src/lib/quota.test.ts proves the behaviour; this pins
  // that the module owns no second, private copy of the rule.
  it("decides the quota window from the same predicate", () => {
    const code = codeOnly(read("src/lib/quota.ts"));
    expect(code).toContain("hasProAccess");
    expect(code).not.toMatch(/status\s*===\s*"active"/);
    expect(code).not.toMatch(/status\s*!==\s*"active"/);
  });
});

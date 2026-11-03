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
// Hence a test that reads the source. It is a source test, which normally pins
// a spelling rather than a behaviour -- here the spelling IS the behaviour,
// because the column list in the select string is the only place the decision
// inputs are chosen.
//
// WHY THIS WALKS THE TREE INSTEAD OF LISTING FILES. It used to be a hardcoded
// list of six paths, and a list of paths can only ever guard the files someone
// remembered to add. Four ways through it have been demonstrated, in order:
//
//   1. A NEW file doing from("subscriptions").select("status") and feeding the
//      row to hasProAccess. Not on the list, never opened, suite green.
//   2. A SECOND read in a file already on the list, using a backtick template
//      literal for the column list. The old parser only captured
//      double-quoted literals, and the existing literal read kept the
//      per-file hit count above zero, so nothing threw.
//   3. A read whose TABLE name was not spelled with double quotes: a
//      single-quoted literal, or a const holding the name. The matcher that
//      found subjects recognised only the double-quoted spelling, so such a
//      read was not an unparseable subject -- it was not a SUBJECT AT ALL,
//      invisible to the entire walk, and its status-only select granted
//      perpetual Pro with the suite green. eslint.config.mjs has no quotes
//      rule and prettier does not run in npm run lint, so the single-quoted
//      spelling is committable and lint-clean.
//   4. An ALIASED re-export of the predicate. The exemption below was policed
//      by a substring grep for hasProAccess / computeQuota / scanWindowStart,
//      so an `export const isEntitled = hasProAccess` in a third module let
//      an allowlisted one-column read decide entitlement, suite still green.
//
// WHY IT PARSES INSTEAD OF MATCHING TEXT. 2 and 3 are one bug wearing two
// hats: a text matcher that does not match reads as "nothing here" when the
// only safe reading is "cannot tell". So the walk uses the TypeScript compiler
// API -- as tests/single-clock-per-quota-decision.test.ts already does for the
// clock invariant -- and quoting style, line breaks, comments and `as const`
// stop mattering: a string literal is a string literal whichever quote wrote
// it, and an argument that is NOT a literal is a THROW rather than a silence.
// A regex could have been taught the second quote character, but only the
// spellings someone thought of; the parser is exhaustive by construction.
//
// WHY THE EXEMPTION IS POLICED BY THE IMPORT GRAPH. 4 cannot be answered by
// names, because a name can be renamed: the predicate is reachable through any
// number of aliases. What cannot be renamed is the dependency. An exempt file
// must import no runtime value from any module that transitively reaches
// src/lib/pro-access.ts or src/lib/quota.ts -- so the aliasing module is
// itself tainted by its own import, and importing the alias fails.
//
// Anything the walk cannot PARSE is a failure rather than a skip. An exemption
// exists for reads that decide no entitlement, and a file claiming it must not
// be able to reach the predicate at all.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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

const parse = (file: string, source: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Strip parens and type assertions, which change no runtime value. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
    } else if (
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

/**
 * The text of a plain string literal -- single, double or bare backtick.
 *
 * The quote character is a lexer detail the AST has already discarded, which
 * is the whole reason this file parses rather than greps: evasion 3 was
 * nothing but a second quote character. A template with a substitution is
 * deliberately NOT one of these -- its value is not in the source, so this
 * returns null and the caller throws.
 */
function literalText(expr: ts.Expression | undefined): string | null {
  if (!expr) return null;
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text;
  }
  return null;
}

/** The called method name, for `x.from()`, `x["from"]()` and bare `from()`. */
function callee(call: ts.CallExpression): {
  name: string | null;
  receiver: ts.Expression | null;
} {
  const target = unwrap(call.expression);
  if (ts.isIdentifier(target)) return { name: target.text, receiver: null };
  if (ts.isPropertyAccessExpression(target)) {
    return { name: target.name.text, receiver: target.expression };
  }
  if (ts.isElementAccessExpression(target)) {
    return {
      name: literalText(target.argumentExpression),
      receiver: target.expression,
    };
  }
  return { name: null, receiver: null };
}

/**
 * Statics that own the name `from` without owning a table.
 *
 * The ONLY receivers the walk may skip without reading their argument.
 * Everything else calling .from() is assumed to be a query builder, so an
 * unknown receiver with a non-literal argument fails loudly instead of
 * passing quietly -- the direction of that error matters more than its
 * occasional noise, and the fix is one line here.
 */
const NOT_A_QUERY_BUILDER = new Set([
  "Array",
  "Object",
  "String",
  "Number",
  "Set",
  "Map",
  "Buffer",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/** The table whose row answers the Pro question. */
const TABLE = "subscriptions";

/** Chain members that settle what a from() does with the row. */
const QUERY_OPS = new Set(["select", "insert", "update", "upsert", "delete"]);

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
 * asserted to be unable to REACH the predicate, so the exemption cannot be
 * used to smuggle in an entitlement read.
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
 * the allowlist claims. Names are the cheap half of that check -- renaming
 * past them is what the import graph below exists for.
 */
const PREDICATES = ["hasProAccess", "computeQuota", "scanWindowStart"] as const;

/** The modules that DEFINE the entitlement decision. */
const PREDICATE_MODULES = [
  "src/lib/pro-access.ts",
  "src/lib/quota.ts",
] as const;

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
  readonly line: number;
  readonly kind: "read" | "write";
  /** The literal column list, for a read. */
  readonly columns: string | null;
};

/** The first query operation hanging off a from() call, walking outwards. */
function chainOp(
  fromCall: ts.CallExpression,
): { name: string; call: ts.CallExpression } | null {
  let node: ts.Node = fromCall;
  while (
    node.parent &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node
  ) {
    const access = node.parent;
    const call = access.parent;
    if (!ts.isCallExpression(call) || call.expression !== access) return null;
    if (QUERY_OPS.has(access.name.text)) {
      return { name: access.name.text, call };
    }
    node = call;
  }
  return null;
}

function classify(
  sf: ts.SourceFile,
  file: string,
  fromCall: ts.CallExpression,
): Site {
  const line = lineOf(sf, fromCall);
  const op = chainOp(fromCall);
  if (!op) {
    throw new Error(
      `${file}:${line}: a from("${TABLE}") chain has no recognisable ` +
        `select/upsert/update/insert/delete, so this guard cannot tell ` +
        `whether it reads the entitlement columns. Make the chain legible ` +
        `or this guard is a comment.`,
    );
  }
  if (op.name !== "select") return { file, line, kind: "write", columns: null };
  const columns = literalText(op.call.arguments[0]);
  if (columns === null) {
    throw new Error(
      `${file}:${line}: a from("${TABLE}").select(...) does not pass a ` +
        `plain string literal, so its column list cannot be read from ` +
        `source. A template substitution or a computed list hides the very ` +
        `column whose absence grants perpetual Pro. Found: ` +
        `${JSON.stringify(
          op.call.arguments[0]?.getText(sf).slice(0, 80) ?? "<no argument>",
        )}`,
    );
  }
  return { file, line, kind: "read", columns };
}

/**
 * Every subscriptions query in src/**, classified.
 *
 * THROWS, at module load, on anything it cannot read with confidence. A
 * vacuous pass here is worse than having no test: this file is the only thing
 * standing between a shortened select and perpetual free Pro, so when it stops
 * being able to see the column names it has to take the suite down with it
 * rather than quietly skip the site it could not parse. That now includes the
 * TABLE name -- a from() whose table is a const is not "some other table",
 * it is an unreadable one, and reading it as "not a subject" is how an
 * entitlement read disappears.
 */
function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const sf = parse(file, read(file));
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const { name, receiver } = callee(node);
        const builtin =
          receiver !== null &&
          ts.isIdentifier(receiver) &&
          NOT_A_QUERY_BUILDER.has(receiver.text);
        if (name === "from" && !builtin) {
          const arg = node.arguments[0];
          const table = literalText(arg);
          if (table === null) {
            throw new Error(
              `${file}:${lineOf(sf, node)}: a .from(...) does not name its ` +
                `table with a plain string literal, so this guard cannot ` +
                `tell whether it reads the subscriptions row. A const or a ` +
                `template substitution here makes an entitlement read ` +
                `INVISIBLE to this walk, which is how a status-only select ` +
                `hands out perpetual Pro. Found: ` +
                `${JSON.stringify(
                  arg?.getText(sf).slice(0, 80) ?? "<no argument>",
                )}. Name the table inline, or add the receiver to ` +
                `NOT_A_QUERY_BUILDER if it is not a database client.`,
            );
          }
          if (table === TABLE) sites.push(classify(sf, file, node));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

/** An import that pulls a RUNTIME value, with the specifier it names. */
type ValueImport = { readonly spec: string; readonly line: number };

/**
 * True for an import the compiler ERASES.
 *
 * `import type { EntitlementRow }` cannot decide anything at runtime, so it
 * is not a path to the predicate and an exempt file may name the row's type
 * without being made to over-fetch columns it never uses. A bare side-effect
 * import runs module code, so it counts.
 */
function isErasedImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    return (
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  }
  return false;
}

/** True for a re-export the compiler erases. */
function isErasedExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return (
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly)
    );
  }
  return false;
}

/** Every specifier a file pulls a runtime value from, however it asks. */
function valueImports(file: string, source: string): ValueImport[] {
  const sf = parse(file, source);
  const out: ValueImport[] = [];
  const add = (spec: ts.Expression | undefined, at: ts.Node): void => {
    const text = literalText(spec);
    if (text !== null) out.push({ spec: text, line: lineOf(sf, at) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isErasedImport(node)) add(node.moduleSpecifier, node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!isErasedExport(node)) add(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression, node);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], node);
      } else if (callee(node).name === "require") {
        add(node.arguments[0], node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Path aliases as the project ACTUALLY declares them.
 *
 * Read from tsconfig rather than hardcoded as "@/": an alias added to the
 * project would otherwise be a brand new blind spot in the resolver below,
 * and a specifier the resolver cannot follow is an import-graph edge that
 * does not exist -- which is the same fail-open shape as a regex that does
 * not match.
 */
const PATH_ALIASES: ReadonlyArray<{
  readonly prefix: string;
  readonly targets: readonly string[];
}> = (() => {
  const parsed = ts.readConfigFile(
    path.join(repoRoot, "tsconfig.json"),
    ts.sys.readFile,
  );
  const paths = (parsed.config?.compilerOptions?.paths ?? {}) as Record<
    string,
    string[]
  >;
  return Object.entries(paths)
    .filter(([pattern]) => pattern.endsWith("/*"))
    .map(([pattern, targets]) => ({
      prefix: pattern.slice(0, -1),
      targets: targets.map((target) => target.replace(/\*$/, "")),
    }));
})();

/** Resolve an import specifier to a repo-relative file under src/, or null. */
function resolveSpecifier(from: string, spec: string): string | null {
  const bases: string[] = [];
  if (spec.startsWith(".")) {
    bases.push(path.resolve(path.dirname(path.join(repoRoot, from)), spec));
  } else {
    for (const alias of PATH_ALIASES) {
      if (!spec.startsWith(alias.prefix)) continue;
      const rest = spec.slice(alias.prefix.length);
      for (const target of alias.targets) {
        bases.push(path.join(repoRoot, target, rest));
      }
    }
  }
  for (const base of bases) {
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return path.relative(repoRoot, candidate).split(path.sep).join("/");
      }
    }
  }
  return null;
}

type Edge = {
  readonly to: string;
  readonly spec: string;
  readonly line: number;
};

const VALUE_EDGES: Map<string, Edge[]> = new Map(
  sourceFiles(SRC_DIR).map((file) => [
    file,
    valueImports(file, read(file))
      .map((imported) => ({
        to: resolveSpecifier(file, imported.spec),
        spec: imported.spec,
        line: imported.line,
      }))
      .filter((edge): edge is Edge => edge.to !== null),
  ]),
);

/**
 * Every module from which a runtime value can reach the entitlement rule,
 * mapped to the chain that gets there.
 *
 * Importers of the predicate modules are tainted, and importers of THOSE are
 * tainted, transitively -- which is exactly what an alias is: a module that
 * imported the rule and re-exposes it under another name. Reachability is a
 * property of the dependency, not of the spelling, so there is nothing left
 * to rename past.
 */
function predicateReach(): Map<string, string> {
  const chain = new Map<string, string>();
  const queue: string[] = [];
  for (const seed of PREDICATE_MODULES) {
    chain.set(seed, seed);
    queue.push(seed);
  }
  while (queue.length > 0) {
    const target = queue.shift()!;
    for (const [file, edges] of VALUE_EDGES) {
      if (chain.has(file)) continue;
      if (edges.some((edge) => edge.to === target)) {
        chain.set(file, `${file} -> ${chain.get(target)}`);
        queue.push(file);
      }
    }
  }
  return chain;
}

const SITES = collectSites();
const READS = SITES.filter((s) => s.kind === "read");
const EXEMPT = new Set(NON_ENTITLEMENT.map((e) => e.file));
const ENTITLEMENT_READS = READS.filter((s) => !EXEMPT.has(s.file));
const PREDICATE_REACH = predicateReach();

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
    "$file:$line selects the columns the Pro rule reads",
    ({ columns, file, line }) => {
      for (const column of REQUIRED_COLUMNS) {
        expect(
          columns!.includes(column),
          `${file}:${line} selects "${columns}" -- missing ${column}. ` +
            `Without it the Pro rule sees undefined, reads that as a ` +
            `lifetime grant, and hands out perpetual Pro to an expired ` +
            `comp. If this read decides no entitlement, add it to ` +
            `NON_ENTITLEMENT with a reason -- do not shorten the rule to ` +
            `fit the select.`,
        ).toBe(true);
      }
    },
  );
});

describe("the non-entitlement exemption cannot be abused", () => {
  // THE POSITIVE CONTROL FOR THE IMPORT GRAPH. The exemption check below
  // asserts a set is EMPTY, which a broken specifier resolver would satisfy
  // by knowing nothing at all. So first prove the graph can see what it is
  // supposed to see: the predicate modules exist, and every known
  // entitlement read is reachable to them.
  it("tracks the predicate through the import graph", () => {
    for (const module of PREDICATE_MODULES) {
      expect(
        existsSync(path.join(repoRoot, module)),
        `${module} no longer exists, so the import-graph check below is ` +
          `rooted at nothing and would pass for any file. Point ` +
          `PREDICATE_MODULES at wherever the rule now lives.`,
      ).toBe(true);
    }
    for (const known of KNOWN_ENTITLEMENT_READS) {
      expect(
        PREDICATE_REACH.has(known),
        `${known} decides entitlement, yet the import graph cannot see it ` +
          `reaching ${PREDICATE_MODULES.join(" or ")}. The resolver is ` +
          `blind -- a changed path alias, a moved module -- and the ` +
          `exemption check is passing vacuously.`,
      ).toBe(true);
    }
  });

  // AN ALLOWLIST IS ONLY AS GOOD AS WHAT IT CANNOT EXCUSE. Exempting a file
  // from the column requirement is safe exactly while that file decides no
  // access. The moment it can call the predicate, its short select is the
  // original bug again -- and "can call" is a question about imports, because
  // `export const isEntitled = hasProAccess` renames the call but not the
  // dependency.
  it.each(NON_ENTITLEMENT)(
    "$file cannot reach the entitlement rule",
    ({ file, reason }) => {
      const paths = (VALUE_EDGES.get(file) ?? [])
        .filter((edge) => PREDICATE_REACH.has(edge.to))
        .map(
          (edge) =>
            `line ${edge.line}: "${edge.spec}" -> ${PREDICATE_REACH.get(edge.to)}`,
        );
      expect(
        paths,
        `${file} is exempt from the entitlement-column requirement ` +
          `because: ${reason} -- but it imports a runtime value from a ` +
          `module that reaches the Pro rule, so it CAN decide entitlement ` +
          `from this row, under any name it likes. Either drop the import, ` +
          `or remove the exemption and select the entitlement columns.`,
      ).toEqual([]);
    },
  );

  // The cheap half, kept for the naive case: the predicate called under its
  // own name, including from somewhere this file does not import.
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

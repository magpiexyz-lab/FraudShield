// ONE CLOCK PER QUOTA DECISION.
//
// A quota read answers two questions at once: WHICH WINDOW do we count scans
// over (scanWindowStart) and HOW BIG is the allowance (computeQuota). Both
// derive from the same predicate, hasProAccess, and both need an instant.
//
// They used to read the clock separately, with an awaited Supabase count query
// sitting between them:
//
//   const windowStart = scanWindowStart(sub, new Date());   // clock read 1
//   const { count } = await scanQuery;                      // tens of ms
//   const quota = computeQuota({ scans_used: count ?? 0, subscription: sub });
//                                                           // clock read 2
//
// So the two reads are tens to hundreds of milliseconds apart, not a hair. If
// a comped grant expires inside that gap, read 1 still sees Pro and picks the
// MONTHLY window, then read 2 sees it expired and hands out the FREE
// allowance: scans counted from this month only, against FREE_SCAN_QUOTA +
// scan_credits. That is the exact window-versus-allowance disagreement this
// branch just fixed -- resurfacing for one request, once per comp lifetime.
//
// WHY THIS IS A SOURCE TEST. No fixed-instant unit test can see it. At any
// single instant the two functions agree; a sweep of 1200 subscription-shape
// combinations found zero disagreements. The defect lives BETWEEN two clock
// reads, so the thing to pin is the CALL SITE, not the functions. (vitest runs
// environment "node" with no jsdom here, so two of the three sites cannot be
// rendered in a test anyway.)
//
// WHY IT PARSES INSTEAD OF GREPPING. The invariant is structural -- the same
// binding has to reach both calls -- and a regex cannot tell the identifier
// "now" from the word "now" in a comment, nor see that computeQuota was handed
// an object literal with no `now` field at all. It also DISCOVERS its subjects
// by walking src/, so a fourth quota read site is guarded the day it is
// written rather than the day someone remembers to add it to a list here.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(__dirname, "..");
const SRC_DIR = path.join(repoRoot, "src");

/**
 * src/lib/quota.ts DEFINES the rule and owns the default clock that callers may
 * fall back to, so it is the one file allowed to construct its own instant.
 */
const DEFINING_MODULE = "src/lib/quota.ts";

/**
 * Calls that take an instant and must therefore share one.
 *
 * entitlementTier joined the list with b-13. It is a layer on hasProAccess
 * that adds the scan-pack tier, and /scan-result now asks it -- rather than
 * the predicate -- which of three views to render. That makes it a FOURTH
 * reader of the same instant inside the same decision: a second clock read
 * there could put the rendered tier on one side of a comp expiry and the
 * allowance on the other, in one render. Listing it here is what makes the
 * assertions below see the call at all.
 */
const SECOND_ARG_CLOCK = new Set([
  "scanWindowStart",
  "hasProAccess",
  "entitlementTier",
]);

type ClockSite = {
  fn: string;
  line: number;
  /** The expression supplying the instant, or undefined when omitted. */
  arg: ts.Expression | undefined;
};

type Analysis = {
  /** Entitlement calls inside the quota decision scope. */
  sites: ClockSite[];
  /** Zero-argument new Date() constructions inside that scope, by line. */
  bareClockReads: number[];
  /** Names bound to a zero-argument new Date() inside that scope. */
  clockBindings: string[];
};

function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const repoRelative = (full: string): string =>
  path.relative(repoRoot, full).split(path.sep).join("/");

/** new Date() with no arguments -- i.e. a read of the wall clock. */
function isBareClockRead(node: ts.Node): boolean {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    (node.arguments === undefined || node.arguments.length === 0)
  );
}

/** computeQuota takes its instant as the `now` field of an object literal. */
function nowField(arg: ts.Expression | undefined): ts.Expression | undefined {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const prop of arg.properties) {
    if (!prop.name || !ts.isIdentifier(prop.name) || prop.name.text !== "now") {
      continue;
    }
    if (ts.isPropertyAssignment(prop)) return prop.initializer;
    if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
  }
  return undefined;
}

function clockSiteOf(
  node: ts.CallExpression,
  sf: ts.SourceFile,
): ClockSite | null {
  if (!ts.isIdentifier(node.expression)) return null;
  const fn = node.expression.text;
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  if (fn === "computeQuota") {
    return { fn, line, arg: nowField(node.arguments[0]) };
  }
  if (SECOND_ARG_CLOCK.has(fn)) return { fn, line, arg: node.arguments[1] };
  return null;
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function allClockSites(sf: ts.SourceFile): ClockSite[] {
  const sites: ClockSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const site = clockSiteOf(node, sf);
      if (site) sites.push(site);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/**
 * The function body that holds the quota decision.
 *
 * Scoping to it rather than to the whole file keeps the guard honest: these are
 * 300-900 line files, and an unrelated new Date() elsewhere in one of them is
 * not this guards concern. Within the decision, one clock read is the rule.
 */
function decisionScope(sf: ts.SourceFile): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      if (fn === "scanWindowStart" || fn === "computeQuota") {
        let cursor: ts.Node | undefined = node.parent;
        while (cursor && !ts.isFunctionLike(cursor)) cursor = cursor.parent;
        found = cursor ?? sf;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function analyze(source: string, fileName: string): Analysis | null {
  const sf = parse(source, fileName);
  const scope = decisionScope(sf);
  if (!scope) return null;

  const sites: ClockSite[] = [];
  const bareClockReads: number[] = [];
  const clockBindings: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const site = clockSiteOf(node, sf);
      if (site) sites.push(site);
    }
    if (isBareClockRead(node)) {
      bareClockReads.push(
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isBareClockRead(node.initializer)
    ) {
      clockBindings.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);

  return { sites, bareClockReads, clockBindings };
}

/** Human-readable shape of one call site, for failure output. */
function describeArg(arg: ts.Expression | undefined): string {
  if (!arg) return "OMITTED (falls back to its own clock read)";
  if (ts.isIdentifier(arg)) return `identifier ${arg.text}`;
  if (isBareClockRead(arg)) return "INLINE new Date()";
  return `OTHER (${ts.SyntaxKind[arg.kind]})`;
}

const describeSite = (s: ClockSite): string =>
  `${s.fn} at line ${s.line} <- ${describeArg(s.arg)}`;

/**
 * Every quota read site in src/, found by walking the tree: a file is a subject
 * if it calls scanWindowStart or computeQuota.
 */
const SUBJECTS = tsSourceFiles(SRC_DIR)
  .map((full) => ({
    file: repoRelative(full),
    source: readFileSync(full, "utf8"),
  }))
  .filter(({ file }) => file !== DEFINING_MODULE)
  .filter(({ file, source }) =>
    allClockSites(parse(source, file)).some(
      (s) => s.fn === "scanWindowStart" || s.fn === "computeQuota",
    ),
  )
  .map(({ file, source }) => ({ file, analysis: analyze(source, file)! }));

describe("quota read sites -- discovery", () => {
  it("finds the three known quota read sites", () => {
    // Guards against the walk going blind (a rename, a moved file, a broken
    // parse) and leaving every assertion below vacuously green.
    expect(SUBJECTS.map((s) => s.file).sort()).toEqual(
      expect.arrayContaining([
        "src/app/api/scan/route.ts",
        "src/app/dashboard/page.tsx",
        "src/app/scan-result/scan-result-client.tsx",
      ]),
    );
  });
});

for (const { file, analysis } of SUBJECTS) {
  describe(`one clock per quota decision -- ${file}`, () => {
    it("hands every entitlement call an explicit instant, never an inline one", () => {
      // OMITTED is the subtle half: computeQuota defaults now internally, so
      // leaving it off is a second clock read that does not look like one.
      const offenders = analysis.sites
        .filter((s) => !s.arg || !ts.isIdentifier(s.arg))
        .map(describeSite);
      expect(offenders).toEqual([]);
    });

    it("threads the SAME binding through the window and the allowance", () => {
      const names = [
        ...new Set(
          analysis.sites
            .map((s) => s.arg)
            .filter(
              (arg): arg is ts.Identifier => !!arg && ts.isIdentifier(arg),
            )
            .map((arg) => arg.text),
        ),
      ];
      expect({
        distinctClocks: names,
        sites: analysis.sites.map(describeSite),
      }).toEqual({
        distinctClocks: [expect.any(String)],
        sites: analysis.sites.map(describeSite),
      });
    });

    it("reads the wall clock once in the decision, into that binding", () => {
      expect({
        bareClockReadLines: analysis.bareClockReads,
        clockBindings: analysis.clockBindings,
      }).toEqual({
        bareClockReadLines: [expect.any(Number)],
        clockBindings: [expect.any(String)],
      });
      const threaded = analysis.sites
        .map((s) => s.arg)
        .filter((arg): arg is ts.Identifier => !!arg && ts.isIdentifier(arg))
        .map((arg) => arg.text);
      for (const name of threaded) {
        expect(analysis.clockBindings).toContain(name);
      }
    });
  });
}

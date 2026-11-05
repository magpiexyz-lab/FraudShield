// lib/scan-limits.ts — the four intake limits, and NOTHING ELSE.
//
// WHY THE FILE EXISTS AT ALL. The limits used to live in lib/scan-intake.ts,
// which does a top-level `import exifr from "exifr"` for extractImageMetadata.
// The free-scan panel is a client component on the LANDING PAGE — the cold
// paid-ad entry point and the one bundle in this product whose size is paid
// for per click — and it imports two of those limits. Webpack drops unused
// exports, but it only drops the `exifr` import itself if that package
// declares `sideEffects: false`, which could not be verified. So the limits
// moved to a module with no dependencies whatsoever, and the panel imports
// them from here.
//
// THE RULE IS "ZERO IMPORTS", and a comment saying so is not enforceable. This
// suite is the enforcement: it parses the module and fails if any import,
// re-export-from, dynamic import or require appears in it. That is the only
// form "dependency-free" can take that survives the next person tidying the
// file by pulling a type in from @/lib/fraud/score.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  ACCEPTED_MIME,
  ANON_ACCEPTED_MIME,
  MAX_ANON_BYTES,
  MAX_BYTES,
} from "@/lib/scan-limits";
import * as intake from "@/lib/scan-intake";

const LIMITS_PATH = path.resolve(__dirname, "..", "src/lib/scan-limits.ts");
const source = readFileSync(LIMITS_PATH, "utf8");

const sourceFile = ts.createSourceFile(
  "scan-limits.ts",
  source,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TS,
);

/**
 * Every node in the module that reaches outside it.
 *
 * Parsed, not grepped, for the reason tests/free-scan-route.test.ts parses: a
 * text match cannot tell code from prose, and this file's whole job is to
 * carry a comment explaining why it has no imports. A regex banning the word
 * would fail on that comment; one skipping comment lines would be fooled by a
 * block comment. The AST sees only code.
 */
function externalReferences(): string[] {
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      found.push(`import from ${node.moduleSpecifier.getText(sourceFile)}`);
    } else if (ts.isImportEqualsDeclaration(node)) {
      found.push("import = require");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      found.push(`export from ${node.moduleSpecifier.getText(sourceFile)}`);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      found.push(`call ${node.expression.getText(sourceFile)}()`);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return found;
}

describe("lib/scan-limits.ts stays dependency-free", () => {
  // POSITIVE CONTROL, first. A parse failure or an unreadable file yields an
  // empty reference list, and the assertion below would then pass on a module
  // importing the entire product.
  it("parses, so the no-imports assertion cannot pass vacuously", () => {
    const identifiers = new Set<string>();
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
    expect(identifiers).toContain("ACCEPTED_MIME");
    expect(identifiers).toContain("ANON_ACCEPTED_MIME");
    expect(identifiers).toContain("MAX_BYTES");
    expect(identifiers).toContain("MAX_ANON_BYTES");
  });

  it("contains no import, re-export-from, dynamic import or require", () => {
    expect(
      externalReferences(),
      "lib/scan-limits.ts must have NO dependencies — it is imported by the landing-page bundle precisely so that bundle pulls nothing else in",
    ).toEqual([]);
  });

  // The cheap, literal form of the same rule, kept alongside the AST one: it
  // is the version a reader will try first, and it reads the file the way a
  // bundler's dependency scan does.
  it("has no line that begins an import statement", () => {
    const NL = String.fromCharCode(10);
    const offenders = source
      .split(NL)
      .filter((l) => /^\s*import\b/.test(l) || /^\s*export\s[^=]*\sfrom\b/.test(l));
    expect(offenders).toEqual([]);
  });
});

describe("the limits themselves did not change in the move", () => {
  it("still caps the authenticated path at 10 MB and the anonymous one at 4 MB", () => {
    expect(MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_ANON_BYTES).toBe(4 * 1024 * 1024);
  });

  it("still accepts PDFs on the authenticated path", () => {
    expect(ACCEPTED_MIME.has("application/pdf")).toBe(true);
  });

  // DERIVED, NEVER RETYPED. A move is exactly the moment a filter turns into a
  // second hand-written list, and from then on adding a format to one surface
  // silently fails to reach the other.
  it("derives the anonymous accept-list by filtering the authenticated one", () => {
    const derived = [...ACCEPTED_MIME].filter((m) => m.startsWith("image/"));
    expect([...ANON_ACCEPTED_MIME].sort()).toEqual(derived.sort());
    expect(source).toMatch(/\[\s*\.\.\.ACCEPTED_MIME\s*\]\s*\.filter/);
  });
});

describe("lib/scan-intake re-exports the limits rather than copying them", () => {
  // THE SAME OBJECTS, not equal ones. Every existing import path
  // (@/lib/scan-intake) keeps working and /api/scan is untouched — but only if
  // this is a re-export. Two Sets with the same contents would satisfy a
  // deep-equality check and still drift apart on the next edit.
  it("hands out the identical ACCEPTED_MIME set", () => {
    expect(intake.ACCEPTED_MIME).toBe(ACCEPTED_MIME);
  });

  it("hands out the identical ANON_ACCEPTED_MIME set", () => {
    expect(intake.ANON_ACCEPTED_MIME).toBe(ANON_ACCEPTED_MIME);
  });

  it("hands out the same two size caps", () => {
    expect(intake.MAX_BYTES).toBe(MAX_BYTES);
    expect(intake.MAX_ANON_BYTES).toBe(MAX_ANON_BYTES);
  });
});

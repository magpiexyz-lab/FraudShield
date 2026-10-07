// Claims the product does not deliver.
//
// "Cross-document checks" was advertised in TWELVE places -- the pricing page
// as an included Pro feature, the login page as "Names, totals, and dates
// reconciled", the dashboard, the result page, the landing page as a feature
// section with its own illustration, an ad variant's proof line, and a live
// progress message shown DURING a scan that narrated work the product was not
// doing. The scoring engine has only ever received one document.
//
// It survived because no one thing was obviously wrong; the claim had simply
// never been checked against the code. This test is that check, run every time.
//
// Adding the capability is the right way to make this pass. Editing the list
// below is the other way, and should take a conversation.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

/** Everything a user can read: pages, components, copy modules. */
function userFacingFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      userFacingFiles(full, acc);
    } else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Phrases that assert a capability the product does not have.
 *
 * `reason` is required: a bare banned-words list invites the next person to
 * delete an entry to get green, where a stated reason makes them argue with it.
 */
const UNBUILT_CLAIMS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bcross[- ]document/i,
    // \b matters: "across documents" contains the substring "cross document",
    // so an unanchored pattern rejects a perfectly honest sentence. Found by
    // running this against copy that says the product does NOT do it.
    reason:
      "The scoring engine receives one document (ScoringInput = metadata + doc_type). " +
      "Nothing compares across documents. Measured: identity swaps caught 0 of 4 (#49).",
  },
  {
    pattern: /reconcile[sd]?\s+(?:across|between)\s+documents/i,
    reason: "Same capability, worded as reconciliation.",
  },
];

describe("the product does not advertise what it cannot do", () => {
  const files = userFacingFiles(path.join(repoRoot, "src"));

  it("finds the source tree to scan", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(UNBUILT_CLAIMS)("never claims: $pattern", ({ pattern, reason }) => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        // A comment explaining why the claim was removed is not a claim,
        // and neither is an import path or an identifier. Only what a user
        // can read counts.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/^\s*import\s/.test(line)) return;
        if (pattern.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      offenders.length ? `\n${reason}\nFound at:\n  ${offenders.join("\n  ")}\n` : "",
    ).toEqual([]);
  });
});

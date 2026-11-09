import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKS_DO_NOT_UNLOCK,
  PACKS_HEADING_AFTER_LOCK,
} from "@/lib/billing-copy";

// Why this exists.
//
// On 6 Nov 2026 a FraudShield customer with two scans still unused bought two
// $7 scan packs from the locked-signals panel on /scan-result, expecting them
// to reveal the signal detail, and found the same result still locked. They
// were not short of scans. They were trying to unlock.
//
// The packs sat INSIDE the centred unlock stack, one `gap-3` below the button
// reading "Unlock all N forensic signals", under the heading "Or just buy the
// scans you need". Stacked centred buttons read as one menu, and "Or" named
// the packs as the cheaper item on it. Packs buy scans; only Pro reveals what
// a scan found — a distinction that is obvious from the inside and invisible
// from the outside.
//
// vitest runs environment "node" with no jsdom, so the panel cannot be
// rendered here. These are source assertions over the ordering and structure
// that caused the misread, plus behavioural assertions on the copy constants.

const CLIENT = readFileSync(
  join(__dirname, "..", "src", "app", "scan-result", "scan-result-client.tsx"),
  "utf-8",
);

const PACKS = readFileSync(
  join(__dirname, "..", "src", "components", "scan-pack-options.tsx"),
  "utf-8",
);

/** Source with comments stripped, so prose explaining the bug cannot satisfy
 *  an assertion about the code that fixes it. */
function codeOnly(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

const CLIENT_CODE = codeOnly(CLIENT);

describe("scan packs are not offered as an unlock", () => {
  // Positive control. Every assertion below is a substring or index check over
  // files read from disk; if a path or the comment strip were wrong they would
  // pass or fail for the wrong reason.
  it("is reading the real sources", () => {
    expect(CLIENT.length).toBeGreaterThan(10_000);
    expect(CLIENT_CODE.length).toBeGreaterThan(CLIENT.length * 0.3);
    expect(CLIENT_CODE).toContain("function LockedSignals");
    expect(CLIENT_CODE).toContain("ScanPackOptions");
    expect(PACKS).toContain("export function ScanPackOptions");
  });

  it("states plainly what a pack is, in the vocabulary of the panel", () => {
    // The sentence is the backstop, not the fix — but it has to say the two
    // things the customer could not infer: what a pack buys, and that Pro is
    // what the rest needs.
    //
    // THESE THREE REGEXES ARE KEPT AS A POSITIVE CONTROL, NOT AS THE GUARD.
    // All three were green against the sentence this replaced on 2026-11-09,
    // and all three are green against the new one; that is exactly what makes
    // them useless on their own, and it is why the test below exists.
    expect(PACKS_DO_NOT_UNLOCK).toMatch(/scan/i);
    expect(PACKS_DO_NOT_UNLOCK).toMatch(/\bPro\b/);
    expect(PACKS_DO_NOT_UNLOCK).toMatch(/not|only/i);
    expect(CLIENT_CODE).toContain("PACKS_DO_NOT_UNLOCK");
  });

  // THE GUARD WITH TEETH, and the reason the three regexes above are not it.
  //
  // The sentence was reworded on 2026-11-09 on the manager's instruction:
  // packs now show a buyer two named reasons, so "they do not reveal the
  // signal detail" had become a false thing to tell a reader at the buy
  // button. What may NEVER be reworded away is the reason the sentence was
  // written -- on 6 Nov 2026 a customer bought two 7 dollar packs from this
  // panel expecting the full per-signal breakdown, and was refunded 14
  // dollars.
  //
  // /scan/i, /\bPro\b/ and /not|only/i cannot hold that. Every one of them
  // passes against "Scan packs show why each result was flagged. Pro is not
  // required." -- a sentence that gives away precisely what the refund was
  // for. Proven by mutation rather than argued. So this asserts the CLAIM
  // instead of the vocabulary: whatever words are used, the full breakdown
  // has to be the part that takes Pro, in one clause, not two sentences that
  // merely both exist.
  it("still says the full breakdown is the part that takes Pro", () => {
    expect(
      PACKS_DO_NOT_UNLOCK,
      "this sentence no longer ties the FULL BREAKDOWN to Pro. That clause is what prevents the 6 Nov 2026 refund (two packs bought for a breakdown they did not buy) and it cannot be reworded away: say that the full breakdown is what Pro shows.",
    ).toMatch(
      /only Pro[^.]*\bfull\b[^.]*\bbreakdown\b|\bfull\b[^.]*\bbreakdown\b[^.]*only Pro/i,
    );
  });

  it("does not head the packs with 'Or' on the locked panel", () => {
    // "Or just buy the scans you need" is correct on the dashboard, where
    // running out of scans is the only thing being refused. Beneath an unlock
    // CTA it offers a cheaper route to something packs cannot do.
    expect(PACKS_HEADING_AFTER_LOCK).not.toMatch(/^or\b/i);
    expect(CLIENT_CODE).toContain("PACKS_HEADING_AFTER_LOCK");
  });

  it("keeps the default heading for the other surfaces", () => {
    // The dashboard and pricing call sites pass no heading and must keep the
    // wording that is right for them.
    expect(PACKS).toContain('heading = "Or just buy the scans you need"');
    const dashboard = readFileSync(
      join(__dirname, "..", "src", "app", "dashboard", "upload-zone.tsx"),
      "utf-8",
    );
    expect(dashboard).toContain('surface="dashboard_quota"');
    expect(dashboard).not.toContain("PACKS_HEADING_AFTER_LOCK");
  });

  it("renders the packs outside the centred unlock stack", () => {
    // This is the actual fix. The unlock CTA lives in a centred flex column;
    // the packs must not be a sibling inside it, because stacked centred
    // buttons read as one menu of options for one outcome.
    const stackStart = CLIENT_CODE.indexOf("flex flex-col items-center gap-3");
    const packs = CLIENT_CODE.indexOf("<ScanPackOptions");
    expect(stackStart).toBeGreaterThan(-1);
    expect(packs).toBeGreaterThan(stackStart);

    // Everything between the stack's opening and the packs must contain the
    // div that closes that stack. Slicing is crude but it is the only
    // structural check available without a DOM.
    const between = CLIENT_CODE.slice(stackStart, packs);
    expect(
      between,
      "ScanPackOptions still appears to sit inside the centred unlock stack",
    ).toContain("</div>");
  });

  it("separates the packs with a rule rather than only whitespace", () => {
    // A gap alone reads as grouping. A border is what makes it a region.
    const packs = CLIENT_CODE.indexOf("<ScanPackOptions");
    const before = CLIENT_CODE.slice(Math.max(0, packs - 400), packs);
    expect(before).toMatch(/border-t/);
  });

  it("still offers the packs on the results page", () => {
    // The manager asked to keep them: this is where intent is highest. The fix
    // is separation and a sentence, not removal.
    expect(CLIENT_CODE).toContain('surface="scan_result"');
  });

  it("still gates the packs on a signed-in user", () => {
    // Checkout needs a user to attach the purchase to. A signed-out visitor is
    // sent to sign up by the CTA above instead.
    const packs = CLIENT_CODE.indexOf("<ScanPackOptions");
    const before = CLIENT_CODE.slice(Math.max(0, packs - 400), packs);
    expect(before).toMatch(/\{user \?/);
  });
});

// The accuracy gate's harness (fraud-eval/), pinned where it can go wrong
// quietly.
//
// Two classes of failure are worth a test here, and neither shows up as a
// crash:
//
//   1. A forged document reaching the public repository. There are twenty in
//      this set and three of them carry a metadata-evasion technique, so the
//      ignore rules are a safety control, not housekeeping.
//
//   2. The score bands drifting. run.mjs is plain .mjs with no TS pipeline, so
//      it MIRRORS the thresholds from src/lib/fraud/score.ts rather than
//      importing them. A copy that silently disagrees with the product would
//      produce a confusion matrix that looks authoritative and measures a cut
//      the product does not use -- which is the one way this gate could pass
//      while telling us nothing.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { scoreSeverity } from "@/lib/fraud/score";

const repoRoot = path.resolve(__dirname, "..");
const evalDir = path.join(repoRoot, "fraud-eval");
const runnerSource = () =>
  readFileSync(path.join(evalDir, "run.mjs"), "utf8");
const ignoreRules = () =>
  readFileSync(path.join(evalDir, ".gitignore"), "utf8");

/** The thresholds run.mjs mirrors, read back out of its source. */
function mirroredBands() {
  const source = runnerSource();
  const suspect = source.match(/const SUSPECT_MIN = (\d+);/);
  const fraud = source.match(/const FRAUD_MIN = (\d+);/);
  expect(suspect, "SUSPECT_MIN not found in run.mjs").not.toBeNull();
  expect(fraud, "FRAUD_MIN not found in run.mjs").not.toBeNull();
  return { suspect: Number(suspect![1]), fraud: Number(fraud![1]) };
}

describe("fraud-eval harness exists", () => {
  it.each(["run.mjs", "labels.csv", "README.md", ".gitignore"])(
    "ships %s",
    (file) => {
      expect(existsSync(path.join(evalDir, file))).toBe(true);
    },
  );

  // The columns the runner reads. A manifest missing `sha256` would disable the
  // integrity check silently, since the runner skips verification when the
  // field is empty.
  it("declares the manifest columns the runner depends on", () => {
    const header = readFileSync(path.join(evalDir, "labels.csv"), "utf8")
      .split(/\r?\n/)[0]
      .split(",")
      .map((c) => c.trim());
    expect(header).toEqual(["file", "label", "change", "source", "sha256"]);
  });
});

describe("the score bands cannot drift from the product", () => {
  // The real contract, asserted against the real function: whatever run.mjs
  // believes the cut points are, scoreSeverity must agree at the boundary and
  // one below it. Change score.ts without changing run.mjs and this fails.
  it("agrees with scoreSeverity at every boundary", () => {
    const { suspect, fraud } = mirroredBands();

    expect(scoreSeverity(suspect - 1)).toBe("clear");
    expect(scoreSeverity(suspect)).toBe("suspect");
    expect(scoreSeverity(fraud - 1)).toBe("suspect");
    expect(scoreSeverity(fraud)).toBe("fraud");
  });

  it("keeps the bands ordered and inside the 0-100 scale", () => {
    const { suspect, fraud } = mirroredBands();
    expect(suspect).toBeGreaterThan(0);
    expect(suspect).toBeLessThan(fraud);
    expect(fraud).toBeLessThanOrEqual(100);
  });

  // The matrix is only honest if the cut is the product's. A literal threshold
  // written inline at the comparison site would bypass the constants above and
  // therefore bypass the drift check.
  it("derives its verdict from the named constants, not inline numbers", () => {
    const verdictFn = runnerSource().slice(
      runnerSource().indexOf("function verdictFor"),
    ).slice(0, 300);
    expect(verdictFn).toContain("FRAUD_MIN");
    expect(verdictFn).toContain("SUSPECT_MIN");
    expect(verdictFn).not.toMatch(/>=\s*\d+/);
  });
});

describe("no forged document can reach the public repository", () => {
  // Deny-all then re-allow. A denylist of extensions is one unfamiliar format
  // away from leaking, and the thing leaking here is a forgery template set.
  it("denies everything by default", () => {
    expect(ignoreRules().split(/\r?\n/).map((l) => l.trim())).toContain("*");
  });

  it.each(["README.md", "labels.csv", "run.mjs", ".gitignore"])(
    "re-allows %s",
    (file) => {
      expect(ignoreRules()).toContain("!" + file);
    },
  );

  // Only named text artefacts are re-allowed under results/.
  //
  // `!results/` itself is REQUIRED and is not a hole: with `*` ignoring
  // everything, git does not descend into an ignored directory, so without it
  // the file rules beneath would never be evaluated at all. What would be a
  // hole is a wildcard like `!results/*`, which re-admits any document dropped
  // in the folder -- and that folder is exactly where a careless run would put
  // one.
  it("re-allows only named text artefacts under results/", () => {
    const allows = ignoreRules()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("!results"));

    expect(allows).toContain("!results/");

    for (const rule of allows.filter((r) => r !== "!results/")) {
      expect(rule).toMatch(/\.(md|csv)$|\.gitkeep$/);
      // A bare extension wildcard is fine; a bare `*` is not.
      expect(rule).not.toBe("!results/*");
    }
  });

  // The ignore file is the backstop. The mechanism is that documents are
  // written to a temp directory outside the working tree and removed after
  // each scan, so a forged document is never in the repo to be committed.
  it("streams documents outside the repository and deletes them", () => {
    const source = runnerSource();
    expect(source).toContain("mkdtemp");
    expect(source).toContain("tmpdir()");
    expect(source).toMatch(/finally\s*\{\s*await rm\(local, \{ force: true \}\)/);
  });
});

describe("the runner agrees with the scan route it calls", () => {
  const scanSource = () =>
    readFileSync(
      path.join(repoRoot, "src", "app", "api", "scan", "route.ts"),
      "utf8",
    );

  // THE CONTRACT THAT ALREADY BROKE ONCE. /api/scan answers 201 Created; the
  // runner was written against 200 and would have recorded every successful
  // scan as a failure -- excluding all forty documents and producing an empty
  // matrix that still rendered and still looked like a result. The two numbers
  // have to be read from the two files and compared, because nothing else
  // connects them.
  it("expects the status the scan route actually returns", () => {
    const returned = scanSource().match(
      /NextResponse\.json\(response,\s*\{\s*status:\s*(\d+)\s*\}\)/,
    );
    expect(returned, "success response status not found in the scan route").not.toBeNull();

    const expected = runnerSource().match(/result\.status !== (\d+)/);
    expect(expected, "status check not found in run.mjs").not.toBeNull();

    expect(expected![1]).toBe(returned![1]);
  });

  // The score field is named fraud_score on the wire. The runner accepts
  // either spelling, so this pins that the route's actual name is one it reads.
  it("reads the field name the scan route sends", () => {
    expect(scanSource()).toContain("fraud_score");
    expect(runnerSource()).toContain("fraud_score");
  });

  // EVERY MIME THE RUNNER SENDS MUST BE ONE THE ROUTE ACCEPTS. Sending a type
  // outside ACCEPTED_MIME is a 415 and the document is excluded; sending no
  // type at all is worse, because the route only runs extractPdfMetadata when
  // the type is exactly application/pdf. A set scanned without a content type
  // would be measured with metadata forensics silently skipped -- a matrix
  // about an analysis the product does not perform that way.
  it("sends only MIME types the scan route accepts", () => {
    const accepted = scanSource()
      .slice(scanSource().indexOf("const ACCEPTED_MIME"))
      .slice(0, 300)
      .match(/"[a-z]+\/[a-z0-9.+-]+"/g)
      ?.map((s) => s.replace(/"/g, ""));
    expect(accepted, "ACCEPTED_MIME not found in the scan route").toBeDefined();

    const sent = runnerSource()
      .slice(runnerSource().indexOf("const MIME_BY_EXT"))
      .slice(0, 300)
      .match(/"[a-z]+\/[a-z0-9.+-]+"/g)
      ?.map((s) => s.replace(/"/g, ""));
    expect(sent, "MIME_BY_EXT not found in the runner").toBeDefined();
    expect(sent!.length).toBeGreaterThan(0);

    for (const mime of sent!) {
      expect(accepted, `route rejects ${mime}`).toContain(mime);
    }
  });

  // Guessing would reintroduce the empty-type bug for any format added later.
  it("refuses to scan an extension it has no MIME type for", () => {
    expect(runnerSource()).toContain("refusing to guess");
  });

  // Pacing has to come from the route's own limiter, not a guess. If the
  // route's budget is lowered, a hardcoded gap silently starts failing again.
  it("paces itself under the scan route's rate limit", () => {
    const limit = scanSource().match(
      /rateLimit\(`scan:[^`]*`,\s*(\d+),\s*(\d+)\)/,
    );
    expect(limit, "rate limit not found in the scan route").not.toBeNull();

    const perWindow = Number(limit![1]);
    const windowSeconds = Number(limit![2]);
    const gapMs = Number(runnerSource().match(/const SCAN_GAP_MS = (\d+)/)![1]);

    // The gap must be at least the window divided by the allowance.
    expect(gapMs).toBeGreaterThanOrEqual((windowSeconds / perWindow) * 1000);
  });

  // A 429 means "not yet", not "never". Treating it as a scan failure drops
  // the document from the matrix and shrinks the set the result rests on --
  // which is exactly what the first real run did to 31 of 40 documents.
  it("retries a rate-limited scan instead of recording a failure", () => {
    const source = runnerSource();
    expect(source).toContain("result.status === 429");
    expect(source).toContain("rateLimited");
    expect(source).toMatch(/RATE_LIMIT_RETRIES/);
  });
});

describe("the matrix cannot be flattered", () => {
  // A document that failed to download or scan must not land in the "correct"
  // cells. Counting an unscored document as a pass would raise the caught rate
  // by doing less work.
  it("excludes unscored documents from the matrix", () => {
    const source = runnerSource();
    expect(source).toContain('rows.filter((r) => !r.error && r.verdict !== "no-score")');
  });

  // An image returns no score by design (the limited-analysis state). Treating
  // that as "clear" would convert a refusal to judge into a verdict, and on a
  // tampered document it would read as a miss we never actually made.
  it("treats a missing score as its own outcome, not as clear", () => {
    expect(runnerSource()).toContain('if (score === null) return "no-score"');
  });

  // Below the bar is a RESULT, not a crash: #49 specifies what happens then
  // (change the copy, re-run). Exiting non-zero on it would push someone to
  // "fix" the script.
  it("exits non-zero only when something could not be measured", () => {
    const source = runnerSource();
    expect(source).toContain("if (failures.length > 0) process.exitCode = 1");
    expect(source).not.toMatch(/caughtRate\s*<\s*BAR\.caught.*process\.exit/s);
  });
});

// fraud-eval/run.mjs — the detection accuracy gate.
//
// Reads labels.csv, pulls each document from the PRIVATE Supabase Storage
// bucket, scans it through the product exactly as a customer's upload is
// scanned, and writes one confusion matrix.
//
// THREE DESIGN DECISIONS, all of them load-bearing:
//
// 1. DOCUMENTS NEVER TOUCH THE REPOSITORY. This repo is public and twenty of
//    the forty documents are forged financial records. Each one is streamed to
//    a temp directory OUTSIDE the working tree, scanned, and deleted in a
//    finally block. fraud-eval/.gitignore is a backstop for when that goes
//    wrong, not the mechanism that keeps them out.
//
// 2. SCANS GO THROUGH A REAL AUTHENTICATED SESSION. /api/scan resolves identity
//    from the Supabase cookie (createServerSupabaseClient), so a bearer token
//    would not work. Playwright logs in once and POSTs from inside the page
//    context -- the same path e2e/behaviors.spec.ts already uses, and the same
//    one a customer's upload takes. An eval that bypassed auth would be
//    measuring a code path no customer uses.
//
// 3. THE VERDICT COMES FROM THE PRODUCT, NOT FROM HERE. scoreSeverity() owns
//    the bands; this script reads the score and applies the product's own cut.
//    Both cuts are reported because the choice changes the answer -- see the
//    README. Inventing a threshold here would let the eval pass by picking a
//    number, which is the one failure mode that would make the whole exercise
//    worthless.

import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABELS = path.join(HERE, "labels.csv");
const RESULTS_DIR = path.join(HERE, "results");

const BUCKET = "fraud-eval";

// The product's own bands, mirrored from src/lib/fraud/score.ts. Mirrored and
// not imported because this is a plain .mjs script with no TS pipeline; the
// test at the bottom of this file's PR pins them against the real module so the
// copy cannot drift silently.
const SUSPECT_MIN = 34;
const FRAUD_MIN = 67;

const BAR = { caught: 0.8, falseAlarm: 0.1 };

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(`Missing required env var: ${name}`);
    console.error("See fraud-eval/README.md for the full list.");
    process.exit(1);
  }
  return value;
}

/**
 * Minimal CSV reader: splits on commas outside double quotes and unescapes ""
 * pairs. Deliberately not a dependency -- the manifest is written by us, and a
 * parser generous enough for arbitrary CSV would also silently accept a
 * malformed manifest.
 */
function parseCsv(text) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (quoted) {
        if (ch === '"' && rawLine[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cell); cell = ""; }
      else cell += ch;
    }
    cells.push(cell);
    rows.push(cells.map((c) => c.trim()));
  }
  const [header, ...body] = rows;
  return body.map((cells) =>
    Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])),
  );
}

async function loadManifest() {
  if (!existsSync(LABELS)) {
    console.error(`No manifest at ${LABELS}`);
    process.exit(1);
  }
  const entries = parseCsv(await readFile(LABELS, "utf8"));
  if (entries.length === 0) {
    console.error(
      "labels.csv has no rows yet. Add the documents to the private bucket and\n" +
      "list them here first -- see fraud-eval/README.md.",
    );
    process.exit(1);
  }
  for (const e of entries) {
    if (e.label !== "genuine" && e.label !== "tampered") {
      console.error(`Row "${e.file}" has label "${e.label}"; expected genuine or tampered.`);
      process.exit(1);
    }
  }
  return entries;
}

/** Log in once and hand back a browser context carrying the session. */
async function authenticate(browser, baseUrl, email, password) {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  await page.close();
  return context;
}

/**
 * Scan one document and return { score, verdict } as the PRODUCT reports them.
 *
 * Posts from inside the page so the request carries the session cookie, which
 * is the only credential /api/scan accepts.
 */
async function scanOne(page, filePath, fileName) {
  const bytes = await readFile(filePath);
  const result = await page.evaluate(
    async ({ name, b64 }) => {
      const binary = atob(b64);
      const buf = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
      const form = new FormData();
      form.append("file", new File([buf], name));
      const res = await fetch("/api/scan", { method: "POST", body: form });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
      return { status: res.status, body, text: text.slice(0, 400) };
    },
    { name: fileName, b64: bytes.toString("base64") },
  );

  // 201, not 200. /api/scan returns Created with the new scan id -- checking
  // for 200 recorded every successful scan as a failure, which would have
  // excluded all forty documents and produced an empty matrix that still
  // rendered and still looked like a result.
  if (result.status !== 201 || !result.body) {
    return { error: `HTTP ${result.status}: ${result.text}` };
  }
  // The route returns the scan id and the score. An image upload legitimately
  // has no score (the limited-analysis state), which is NOT an error and must
  // not be silently counted as "clear" -- it is reported as its own outcome.
  const score = result.body.score ?? result.body.fraud_score ?? null;
  return { score: typeof score === "number" ? score : null, raw: result.body };
}

function verdictFor(score) {
  if (score === null) return "no-score";
  if (score >= FRAUD_MIN) return "fraud";
  if (score >= SUSPECT_MIN) return "suspect";
  return "clear";
}

/** Confusion matrix at one cut. `flagged` decides what counts as a flag. */
function matrix(rows, flagged) {
  const tampered = rows.filter((r) => r.label === "tampered");
  const genuine = rows.filter((r) => r.label === "genuine");
  const caught = tampered.filter((r) => flagged(r)).length;
  const falseAlarms = genuine.filter((r) => flagged(r)).length;
  return {
    tampered: tampered.length,
    genuine: genuine.length,
    caught,
    missed: tampered.length - caught,
    falseAlarms,
    correct: genuine.length - falseAlarms,
    caughtRate: tampered.length ? caught / tampered.length : 0,
    falseAlarmRate: genuine.length ? falseAlarms / genuine.length : 0,
  };
}

const pct = (n) => (n * 100).toFixed(1) + "%";

function renderMatrix(title, m) {
  const pass = m.caughtRate >= BAR.caught && m.falseAlarmRate <= BAR.falseAlarm;
  return [
    `### ${title}`,
    "",
    "| | flagged | not flagged |",
    "|---|---|---|",
    `| tampered (${m.tampered}) | ${m.caught} | ${m.missed} |`,
    `| genuine (${m.genuine}) | ${m.falseAlarms} | ${m.correct} |`,
    "",
    `- caught rate: **${pct(m.caughtRate)}** (bar: ≥ ${pct(BAR.caught)}) — ${m.caughtRate >= BAR.caught ? "PASS" : "MISS"}`,
    `- false alarms: **${pct(m.falseAlarmRate)}** (bar: ≤ ${pct(BAR.falseAlarm)}) — ${m.falseAlarmRate <= BAR.falseAlarm ? "PASS" : "MISS"}`,
    "",
    `**${pass ? "PASS" : "BELOW BAR"}**`,
    "",
  ].join("\n");
}

/** Fail fast, and say which of the three things is wrong. */
async function preflight(supabaseUrl, serviceKey) {
  let res;
  try {
    res = await fetch(`${supabaseUrl}/storage/v1/bucket/${BUCKET}`, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    });
  } catch (err) {
    console.error(`\nCannot reach ${supabaseUrl}`);
    console.error(`  ${err.message}`);
    console.error("\nNEXT_PUBLIC_SUPABASE_URL should be the Project URL from");
    console.error("Supabase > Settings > API. It looks like");
    console.error("  https://<project-ref>.supabase.co");
    console.error("and the ref is a random string, not your project's name.");
    process.exit(1);
  }

  if (res.status === 401 || res.status === 403) {
    console.error("\nRejected by Supabase (HTTP " + res.status + ").");
    console.error("SUPABASE_SERVICE_ROLE_KEY is wrong, or was rotated since you copied it.");
    console.error("Supabase > Settings > API > service_role.");
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(`\nNo bucket named "${BUCKET}" in this project.`);
    console.error("Create it under Storage, private, with exactly that name.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\nStorage returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`Bucket "${BUCKET}" reachable.`);
}

async function main() {
  const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const email = env("FRAUD_EVAL_EMAIL");
  const password = env("FRAUD_EVAL_PASSWORD");
  const baseUrl = env("FRAUD_EVAL_BASE_URL", "http://localhost:3000");

  const manifest = await loadManifest();
  console.log(`Manifest: ${manifest.length} documents.`);

  // PREFLIGHT. Check the bucket is reachable BEFORE launching a browser,
  // logging in and starting forty scans. A wrong project URL or a stale key
  // otherwise surfaces as a wall of download failures several minutes in, and
  // the obvious reading of that is "the documents are missing" rather than
  // "the credentials are wrong". Two seconds here saves that.
  await preflight(supabaseUrl, serviceKey);

  const browser = await chromium.launch();
  // OUTSIDE the repository, deliberately. See decision 1 in the header.
  const scratch = await mkdtemp(path.join(tmpdir(), "fraud-eval-"));
  const rows = [];

  try {
    const context = await authenticate(browser, baseUrl, email, password);
    const page = await context.newPage();
    await page.goto("/dashboard");

    for (const [i, entry] of manifest.entries()) {
      const label = `[${i + 1}/${manifest.length}] ${entry.file}`;
      const local = path.join(scratch, path.basename(entry.file));
      try {
        // Plain fetch against the Storage REST API rather than supabase-js.
        // The client constructs a Realtime connection on creation, which needs
        // a global WebSocket that Node 20 does not have -- it aborted the whole
        // run before a single document was read. Nothing here needs realtime,
        // auth refresh or query building, so the dependency bought us only its
        // failure mode.
        const res = await fetch(
          `${supabaseUrl}/storage/v1/object/${BUCKET}/${entry.file
            .split("/").map(encodeURIComponent).join("/")}`,
          { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } },
        );
        if (!res.ok) {
          const detail = res.status === 400 || res.status === 404
            ? "not found in the bucket — check the filename matches the manifest"
            : res.status === 401 || res.status === 403
              ? "unauthorised — check SUPABASE_SERVICE_ROLE_KEY and the bucket name"
              : (await res.text()).slice(0, 160);
          rows.push({ ...entry, error: `download failed (HTTP ${res.status}): ${detail}` });
          console.log(`${label} — DOWNLOAD FAILED (${res.status})`);
          continue;
        }
        const bytes = Buffer.from(await res.arrayBuffer());

        // INTEGRITY. A document quietly replaced in the bucket would otherwise
        // produce a confusion matrix about a set nobody can reconstruct, and
        // the number would look just as authoritative.
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (entry.sha256 && digest !== entry.sha256.toLowerCase()) {
          rows.push({ ...entry, error: `sha256 mismatch (bucket ${digest.slice(0, 12)}…)` });
          console.log(`${label} — SHA MISMATCH, not scored`);
          continue;
        }

        await writeFile(local, bytes);
        const result = await scanOne(page, local, path.basename(entry.file));
        if (result.error) {
          rows.push({ ...entry, error: result.error });
          console.log(`${label} — SCAN FAILED: ${result.error}`);
          continue;
        }
        const verdict = verdictFor(result.score);
        rows.push({ ...entry, score: result.score, verdict });
        console.log(`${label} — ${result.score ?? "no score"} (${verdict})`);
      } finally {
        await rm(local, { force: true });
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await browser.close();
  }

  const scored = rows.filter((r) => !r.error && r.verdict !== "no-score");
  const failures = rows.filter((r) => r.error);
  const noScore = rows.filter((r) => !r.error && r.verdict === "no-score");

  const suspectPlus = matrix(scored, (r) => r.verdict === "suspect" || r.verdict === "fraud");
  const fraudOnly = matrix(scored, (r) => r.verdict === "fraud");

  const stamp = new Date().toISOString();
  const report = [
    "# Detection accuracy — confusion matrix",
    "",
    `Run: ${stamp}`,
    `Target: ${baseUrl}`,
    `Scored: ${scored.length} of ${manifest.length}`,
    "",
    failures.length
      ? `**${failures.length} document(s) could not be scored** — listed below. They are EXCLUDED from the matrix rather than counted as correct, which would flatter the result.`
      : "All documents scored.",
    "",
    noScore.length
      ? `**${noScore.length} returned no score** (the limited-analysis state for images). Also excluded — counting them as "clear" would turn a refusal to judge into a verdict.`
      : "",
    "",
    renderMatrix("Primary — flagged = suspect or fraud (score ≥ 34)", suspectPlus),
    renderMatrix("Strict — flagged = fraud only (score ≥ 67)", fraudOnly),
    "## Missed tampered documents",
    "",
    ...(() => {
      const missed = scored.filter(
        (r) => r.label === "tampered" && r.verdict === "clear",
      );
      if (missed.length === 0) return ["None.", ""];
      return [
        "| file | change | source | score |",
        "|---|---|---|---|",
        ...missed.map((r) => `| ${r.file} | ${r.change} | ${r.source} | ${r.score} |`),
        "",
      ];
    })(),
    "## False alarms",
    "",
    ...(() => {
      const fa = scored.filter(
        (r) => r.label === "genuine" && r.verdict !== "clear",
      );
      if (fa.length === 0) return ["None.", ""];
      return [
        "| file | source | score | verdict |",
        "|---|---|---|---|",
        ...fa.map((r) => `| ${r.file} | ${r.source} | ${r.score} | ${r.verdict} |`),
        "",
      ];
    })(),
    ...(failures.length
      ? [
          "## Not scored",
          "",
          "| file | reason |",
          "|---|---|",
          ...failures.map((r) => `| ${r.file} | ${r.error} |`),
          "",
        ]
      : []),
    "## Per-file results",
    "",
    "| file | label | change | source | score | verdict |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.file} | ${r.label} | ${r.change} | ${r.source} | ${r.error ? "—" : r.score ?? "—"} | ${r.error ? "not scored" : r.verdict} |`,
    ),
    "",
  ].join("\n");

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(path.join(RESULTS_DIR, "confusion-matrix.md"), report, "utf8");
  await writeFile(
    path.join(RESULTS_DIR, "per-file.csv"),
    [
      "file,label,change,source,score,verdict,error",
      ...rows.map((r) =>
        [r.file, r.label, r.change, r.source, r.error ? "" : r.score ?? "", r.error ? "" : r.verdict, r.error ?? ""]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n"),
    "utf8",
  );

  console.log("\n" + renderMatrix("Primary (suspect+)", suspectPlus));
  console.log(`Written to ${path.relative(process.cwd(), RESULTS_DIR)}/`);

  // Non-zero only when something could not be measured. Being BELOW THE BAR is
  // a real result the gate is designed to produce, not a script failure -- #49
  // says what happens then, and it is a copy change, not a crash.
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

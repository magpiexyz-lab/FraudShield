// What each scan cost, measured rather than estimated.
//
// WHY IT EXISTS. Cost per scan was arithmetic: roughly five cents for a
// one-page document, so about $10 against $60 of revenue if a Pro subscriber
// used all 200 of their monthly scans. Nobody had measured it, and the API was
// returning exact token counts on every response that we threw away.
//
// vitest runs environment "node" with no database, so the migration and the
// insert are pinned as contracts, in the convention of
// subscription-livemode.test.ts. The capture logic itself is exercised for
// real against the mocked SDK in src/lib/fraud/vision.test.ts.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

const MIGRATION_PATH = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "013_scan_token_usage.sql",
);

const migration = (): string => readFileSync(MIGRATION_PATH, "utf8").toLowerCase();
const scanRoute = (): string => read("src", "app", "api", "scan", "route.ts");

describe("013 migration: token usage on scans", () => {
  it("exists at supabase/migrations/013_scan_token_usage.sql", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it("adds the three columns additively", () => {
    const sql = migration();
    expect(sql).toContain("add column if not exists input_tokens integer");
    expect(sql).toContain("add column if not exists output_tokens integer");
    expect(sql).toContain("add column if not exists model text");
  });

  // NULLABLE, AND NOT DEFAULTED TO ZERO. Zero is a measurement meaning "called
  // and billed nothing", which never happens. A default would make a scan that
  // never reached the model indistinguishable from one that did, and drag
  // every average taken afterwards toward zero.
  it("takes no default, so unmeasured scans stay NULL", () => {
    const lines = migration()
      .split("\n")
      .filter((l) => l.includes("add column if not exists"));
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(line).not.toContain("default");
      expect(line).not.toContain("not null");
    }
  });

  // THE MODEL IS LOAD-BEARING, not decoration. Input and output are billed at
  // per-model rates, so counts without a model cannot be priced at all once
  // the model changes.
  it("explains why the model is stored with the counts", () => {
    expect(migration()).toContain("comment on column public.scans.model");
    expect(migration()).toMatch(/rate|billed/);
  });

  // No dollar column, deliberately: a price written at scan time freezes a
  // rate that can change, and nothing in the row would say so.
  it("stores tokens rather than a computed cost", () => {
    const sql = migration();
    expect(sql).not.toContain("add column if not exists cost");
    expect(sql).not.toContain("cost_usd");
    expect(sql).not.toContain("cost_cents");
  });

  it("does not renumber or restate migrations 001-012", () => {
    const sql = migration();
    expect(sql).not.toContain("create table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("alter column");
  });
});

describe("the scan route records what it was billed", () => {
  it("writes all three values onto the scan row", () => {
    const src = scanRoute();
    expect(src).toContain("input_tokens: vision.usage.input_tokens");
    expect(src).toContain("output_tokens: vision.usage.output_tokens");
    expect(src).toContain("model: vision.usage.model");
  });

  // Spread, so a scan with no billed call omits the keys entirely and the
  // columns stay NULL. Writing zeros would be a lie about what happened.
  it("omits the columns rather than zeroing them when nothing was billed", () => {
    const src = scanRoute();
    expect(src).toContain("...(vision.usage");
    expect(src).not.toMatch(/input_tokens:\s*0/);
    expect(src).not.toMatch(/input_tokens:\s*vision\.usage\?\./);
  });
});

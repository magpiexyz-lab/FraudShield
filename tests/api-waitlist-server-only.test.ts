import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// WHY THIS EXISTS.
//
// api_waitlist's INSERT policy from migration 001 ended in `or user_id is null`,
// and NEXT_PUBLIC_SUPABASE_ANON_KEY ships inside the browser bundle. Anyone
// could therefore POST straight to /rest/v1/api_waitlist and write a row
// without going through /api/waitlist — past the zod schema, past the length
// caps, past the rate limit. Migration 016 drops that policy so writes are
// server-only. Manager approved 2026-11-09.
//
// Two things have to stay true for that fix to hold, and neither is visible
// from reading any single file:
//   1. no policy may grant client INSERT on this table again, and
//   2. nothing in src/ may start inserting from the client, because the fix
//      would then break the feature rather than protect it.

const repoRoot = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), "utf-8");

/** SQL with comment lines removed — the migrations explain themselves at
 *  length, and 016's prose quotes the very policy it drops. */
const sqlCodeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

const MIGRATIONS_DIR = join(repoRoot, "supabase", "migrations");
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const ALL_SQL = MIGRATION_FILES.map((f) =>
  sqlCodeOnly(readFileSync(join(MIGRATIONS_DIR, f), "utf-8")),
).join("\n");

const DROP_MIGRATION = read(
  "supabase",
  "migrations",
  "016_api_waitlist_server_writes_only.sql",
);

describe("api_waitlist accepts writes only from our own server", () => {
  it("is reading the real migrations", () => {
    // Positive control: the negative assertions below would pass vacuously
    // against an empty read.
    expect(MIGRATION_FILES.length).toBeGreaterThan(10);
    expect(ALL_SQL).toContain("create table if not exists api_waitlist");
    expect(DROP_MIGRATION.length).toBeGreaterThan(500);
  });

  it("drops the policy that allowed anonymous direct inserts", () => {
    const code = sqlCodeOnly(DROP_MIGRATION);
    expect(code).toMatch(/drop policy if exists\s+"api_waitlist_insert_authed"/);
    // Dropping the policy only closes the table while RLS is on. With RLS off,
    // Postgres applies no restriction at all and the fix inverts.
    expect(code).toMatch(/alter table api_waitlist enable row level security/);
  });

  it("leaves no INSERT policy standing once every migration has run", () => {
    // NET EFFECT, not any-mention. 001 legitimately creates the policy and 016
    // drops it, so a guard that merely searched for "create policy ... for
    // insert" would fail on that history and tell us nothing useful. Replaying
    // the statements in file order is what actually answers "can a client
    // insert today", and it also catches a future migration re-adding one.
    const live = new Set<string>();
    for (const stmt of ALL_SQL.split(";")) {
      if (!/\bon\s+(public\.)?api_waitlist\b/i.test(stmt)) continue;
      const named = stmt.match(/policy\s+(?:if exists\s+)?"([^"]+)"/i);
      if (!named) continue;
      if (/drop\s+policy/i.test(stmt)) live.delete(named[1]);
      else if (/create\s+policy/i.test(stmt) && /for\s+insert/i.test(stmt))
        live.add(named[1]);
    }
    expect(
      [...live],
      `a client INSERT policy on api_waitlist survives all migrations: ${[...live].join(", ")}`,
    ).toHaveLength(0);
  });

  it("replays a policy history that is actually there", () => {
    // Positive control for the replay above: had the parser matched nothing,
    // the emptiness check would pass while knowing nothing at all.
    expect(ALL_SQL).toMatch(/create policy\s+"api_waitlist_insert_authed"/i);
    expect(ALL_SQL).toMatch(
      /drop policy if exists\s+"api_waitlist_insert_authed"/i,
    );
  });

  it("still has no client SELECT policy, so the list cannot be read either", () => {
    const live = new Set<string>();
    for (const stmt of ALL_SQL.split(";")) {
      if (!/\bon\s+(public\.)?api_waitlist\b/i.test(stmt)) continue;
      const named = stmt.match(/policy\s+(?:if exists\s+)?"([^"]+)"/i);
      if (!named) continue;
      if (/drop\s+policy/i.test(stmt)) live.delete(named[1]);
      else if (/create\s+policy/i.test(stmt) && /for\s+select/i.test(stmt))
        live.add(named[1]);
    }
    expect([...live]).toHaveLength(0);
  });

  it("writes only through the service-role client, never the browser client", () => {
    const route = read("src", "app", "api", "waitlist", "route.ts");
    // The insert must use the service role, which bypasses RLS. An anon or
    // cookie client would now be refused by the policy removal above — the
    // feature would break rather than the hole reopen, but it would break.
    expect(route).toContain("createServiceRoleClient");
    expect(route).toContain('from("api_waitlist")');
  });

  it("keeps the per-IP rate limit that is now the only way in", () => {
    // With the direct PostgREST path closed, this limiter is the cap on the
    // table. The manager asked specifically that it cannot be flooded.
    const route = read("src", "app", "api", "waitlist", "route.ts");
    const call = route.match(
      /rateLimit\(\s*`waitlist:\$\{ip\}`\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/,
    );
    expect(
      call,
      "the waitlist rate limit is gone or no longer keyed on IP",
    ).toBeTruthy();
    expect(Number(call![1])).toBeLessThanOrEqual(10);
    expect(Number(call![2])).toBeGreaterThanOrEqual(30);
    // Keyed on the helper, never the raw header — issue #1361 documents a
    // CVSS-medium bypass via a spoofed X-Forwarded-For.
    expect(route).toContain("clientIpFromHeaders");
  });

  it("has no client-side insert into the table anywhere in src/", () => {
    // If a page ever writes directly, migration 016 turns that write into a
    // silent failure in production. Catch it here instead.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(full, "utf-8");
          if (!src.includes('from("api_waitlist")')) continue;
          if (full.includes(join("api", "waitlist"))) continue; // the one writer
          offenders.push(full.replace(repoRoot, ""));
        }
      }
    };
    walk(join(repoRoot, "src"));
    expect(
      offenders,
      `these files touch api_waitlist outside the server route:\n${offenders.join("\n")}`,
    ).toHaveLength(0);
  });
});

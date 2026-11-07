import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitlistSchema } from "@/app/api/waitlist/route";
import { VOLUME_BANDS, VOLUME_BAND_LABELS } from "@/lib/volume-bands";

// Why this exists.
//
// The "Get API access" button on /scan-result captured an email and nothing
// else, so a click told us a count and never who was behind it. On 6 Nov one
// customer clicked it twice in a day and we could not say what they wanted it
// for. The form now asks for company, role, documents per month and email, and
// every request is stored in api_waitlist with source "scan-result-api-access".
//
// vitest runs environment "node" with no jsdom, so the dialog cannot be
// rendered. The schema is tested behaviourally against the real export; the
// dialog is asserted on source.

const DIALOG = readFileSync(
  join(__dirname, "..", "src", "app", "scan-result", "api-access-dialog.tsx"),
  "utf-8",
);

const MIGRATION = readFileSync(
  join(
    __dirname,
    "..",
    "supabase",
    "migrations",
    "015_api_waitlist_request_fields.sql",
  ),
  "utf-8",
);

const BANDS = readFileSync(
  join(__dirname, "..", "src", "lib", "volume-bands.ts"),
  "utf-8",
);

/** Source with comments stripped, so prose explaining a field cannot satisfy
 *  an assertion that the field is wired. */
function codeOnly(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

const DIALOG_CODE = codeOnly(DIALOG);

describe("the API access request form", () => {
  // Positive control: these are substring checks over files read from disk.
  it("is reading the real sources", () => {
    expect(DIALOG.length).toBeGreaterThan(2_000);
    expect(DIALOG_CODE.length).toBeGreaterThan(DIALOG.length * 0.3);
    expect(DIALOG_CODE).toContain("ApiAccessDialog");
    expect(MIGRATION).toContain("alter table api_waitlist");
  });

  it("accepts all four fields", () => {
    // The whole point of the change: a request that names who is asking.
    const parsed = waitlistSchema.parse({
      email: "ops@northfield.example",
      source: "scan-result-api-access",
      company: "Northfield Lending",
      role: "Head of underwriting",
      monthly_volume: "500-2000",
    });
    expect(parsed.company).toBe("Northfield Lending");
    expect(parsed.role).toBe("Head of underwriting");
    expect(parsed.monthly_volume).toBe("500-2000");
    expect(parsed.email).toBe("ops@northfield.example");
  });

  it("still accepts an email on its own", () => {
    // The pro-upgrade waitlist posts email alone and must keep working. If
    // this breaks, a second intake surface silently stops recording.
    expect(() =>
      waitlistSchema.parse({ email: "a@b.example", source: "pro-upgrade" }),
    ).not.toThrow();
  });

  it("rejects a volume outside the agreed bands", () => {
    expect(() =>
      waitlistSchema.parse({
        email: "a@b.example",
        monthly_volume: "a-few-hundred",
      }),
    ).toThrow();
  });

  it("caps company and role so neither can be used as free storage", () => {
    const long = "x".repeat(121);
    expect(() =>
      waitlistSchema.parse({ email: "a@b.example", company: long }),
    ).toThrow();
    expect(() =>
      waitlistSchema.parse({ email: "a@b.example", role: long }),
    ).toThrow();
  });

  it("asks for every field it stores", () => {
    // Each of the three new inputs must exist and be required, or a request
    // arrives half-filled and the count is no better than a click.
    for (const id of [
      "api-waitlist-company",
      "api-waitlist-role",
      "api-waitlist-volume",
      "api-waitlist-email",
    ]) {
      expect(DIALOG_CODE, `${id} missing from the form`).toContain(id);
    }
    expect(DIALOG_CODE.match(/required/g)?.length ?? 0).toBeGreaterThanOrEqual(
      4,
    );
  });

  it("sends the fields under the names the route reads", () => {
    // A mismatch here stores nulls and nothing fails loudly.
    expect(DIALOG_CODE).toMatch(/monthly_volume:\s*volume/);
    expect(DIALOG_CODE).toContain("company,");
    expect(DIALOG_CODE).toContain("role,");
    expect(DIALOG_CODE).toContain('source: "scan-result-api-access"');
  });

  it("keeps one definition of the volume scale", () => {
    // The dialog is a client component and cannot import the enterprise-lead
    // route without dragging the Supabase server client into the browser
    // bundle — which is why pricing-plans.tsx hardcoded the values instead.
    // This file is the shared, dependency-free home; a third divergent copy is
    // what this assertion exists to prevent.
    expect(DIALOG_CODE).toContain('from "@/lib/volume-bands"');
    expect(DIALOG_CODE).not.toContain("under-100");

    const enterprise = readFileSync(
      join(__dirname, "..", "src", "app", "api", "enterprise-lead", "route.ts"),
      "utf-8",
    );
    expect(enterprise).toContain('from "@/lib/volume-bands"');
  });

  it("keeps the shared bands module dependency-free", () => {
    // Same rule as src/lib/scan-limits.ts: one import here and the module
    // stops being safe for a client component.
    const code = codeOnly(BANDS);
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\(/);
    // Positive control — the strip did not empty the file.
    expect(code).toContain("VOLUME_BANDS");
  });

  it("labels every band", () => {
    // Guards against a band being added without a display name, whose symptom
    // is a raw "over-2000" appearing in the dropdown.
    for (const band of VOLUME_BANDS) {
      expect(VOLUME_BAND_LABELS[band]).toBeTruthy();
    }
    expect(Object.keys(VOLUME_BAND_LABELS)).toHaveLength(VOLUME_BANDS.length);
  });

  it("stores the fields additively, without touching existing rows", () => {
    // api_waitlist already holds pro-upgrade rows and API rows predating the
    // form, so a constraint requiring a value would mean backfilling invented
    // data into a table whose value is being honest about demand.
    //
    // SQL comments are stripped first. The migration's own prose explains why
    // the columns are nullable, and that explanation contains the very phrase
    // the assertion below forbids — the same comment-trap that has caught
    // seven source-text guards in this repo, this one included.
    const sql = MIGRATION.split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");

    // Positive control: stripping must not have emptied the file.
    expect(sql).toContain("alter table api_waitlist");

    // Scoped to the column additions themselves. A blanket search for
    // "not null" also catches `where source is not null` in the partial
    // index, which is ordinary SQL and not a constraint on anyone's data.
    const additions = sql
      .split(";")
      .filter((stmt) => /add column if not exists/i.test(stmt));

    expect(additions).toHaveLength(3);
    for (const col of ["company", "role", "monthly_volume"]) {
      expect(
        additions.some((stmt) => stmt.includes(col)),
        `${col} is not added by this migration`,
      ).toBe(true);
    }
    for (const stmt of additions) {
      expect(
        /\bnot\s+null\b/i.test(stmt.replace(/if\s+not\s+exists/gi, "")),
        `a column is added NOT NULL: ${stmt.trim()}`,
      ).toBe(false);
    }
    expect(sql).not.toMatch(/\bdrop\s+(column|table)\b/i);
  });

  it("indexes what Alan actually wants to count", () => {
    expect(MIGRATION).toMatch(/create index if not exists/);
    expect(MIGRATION).toContain("source");
  });

  // The three columns sit on a table whose INSERT policy from 001 ends in
  // `or user_id is null`, and NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the
  // browser bundle. So PostgREST will accept a direct insert from anyone,
  // bypassing the schema above and the rate limiter with it. The route's caps
  // are therefore not the only thing standing between these columns and
  // arbitrary data — the database has to carry them too.
  describe("the database enforces the same limits as the route", () => {
    const SQL = MIGRATION.split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");

    /** The `add constraint ... check (...)` chunk that mentions a column. */
    function constraintFor(column: string) {
      return SQL.split("add constraint")
        .slice(1)
        .map((chunk) => chunk.slice(0, chunk.indexOf(");") + 1))
        .find((chunk) => chunk.includes("check") && chunk.includes(column));
    }

    const CAPS: Record<string, RegExp> = {
      company: /char_length\(company\)\s*<=\s*(\d+)/,
      role: /char_length\(role\)\s*<=\s*(\d+)/,
    };

    it("constrains every column it adds", () => {
      for (const col of ["company", "role", "monthly_volume"]) {
        expect(
          constraintFor(col),
          `${col} is added with no CHECK constraint, so a direct PostgREST insert can put anything in it`,
        ).toBeTruthy();
      }
    });

    it("admits NULL in each constraint, so existing rows survive", () => {
      // api_waitlist already holds pro-upgrade rows and pre-form API rows. A
      // CHECK that rejects NULL would make this migration fail on contact.
      for (const col of ["company", "role", "monthly_volume"]) {
        expect(constraintFor(col), `${col} CHECK rejects NULL`).toContain(
          col + " is null",
        );
      }
    });

    it("lists exactly the bands TypeScript knows about", () => {
      // This is the assertion that makes the CHECK safe to have. Adding a band
      // to VOLUME_BANDS without extending the constraint means the route
      // accepts a value the database then rejects — an insert failure in
      // production. Pinning the two together turns that into a CI failure.
      const check = constraintFor("monthly_volume");
      expect(check).toBeTruthy();
      const listed = [...check!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(listed.slice().sort()).toEqual([...VOLUME_BANDS].sort());
    });

    it("caps company and role at the number the schema caps them at", () => {
      // Driven FROM the SQL, not from a retyped literal: raise the zod cap and
      // forget the migration, and the reject-at-cap+1 assertion below fails.
      for (const [col, pattern] of Object.entries(CAPS)) {
        const cap = SQL.match(pattern);
        expect(cap, `${col} has no length cap in the migration`).toBeTruthy();
        const limit = Number(cap![1]);
        expect(limit).toBeGreaterThan(0);

        expect(() =>
          waitlistSchema.parse({
            email: "a@b.example",
            [col]: "x".repeat(limit),
          }),
        ).not.toThrow();
        expect(
          () =>
            waitlistSchema.parse({
              email: "a@b.example",
              [col]: "x".repeat(limit + 1),
            }),
          `the schema accepts a longer ${col} than the database will store`,
        ).toThrow();
      }
    });
  });
});

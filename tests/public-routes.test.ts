import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PLAN_PRICES } from "@/lib/types";

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const proxySource = read("src/proxy.ts");
const layoutSource = read("src/app/layout.tsx");

describe("b-11: /terms is publicly reachable", () => {
  it("lists /terms in the proxy publicPaths array", () => {
    const match = proxySource.match(/const publicPaths\s*=\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("\"/terms\"");
  });
});

describe("b-11: structured-data price is derived, not hardcoded", () => {
  it("does not hardcode the stale $49 price in JSON-LD", () => {
    expect(layoutSource).not.toContain("price: \"49\"");
    expect(layoutSource).not.toContain("price: '49'");
  });

  it("imports PLAN_PRICES from @/lib/types", () => {
    expect(layoutSource).toMatch(
      /import\s*\{[^}]*\bPLAN_PRICES\b[^}]*\}\s*from\s*["']@\/lib\/types["']/
    );
  });

  it("derives the advertised price from PLAN_PRICES.pro", () => {
    expect(Math.round(PLAN_PRICES.pro / 100)).toBe(60);
  });
});

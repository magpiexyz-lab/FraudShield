import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { EVENT_FUNNEL_MAP } from "./events";

// experiment/EVENTS.yaml is the canonical event list (CLAUDE.md Rule 2). An
// event that exists in code but not in EVENTS.yaml is "implemented but
// undeclared" and fails an /ads-ready check, so the two must not drift.
function declaredEvents(): Set<string> {
  const file = path.join(process.cwd(), "experiment", "EVENTS.yaml");
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "events:");
  const names = new Set<string>();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // A non-indented key ends the events block.
    if (/^[A-Za-z_]/.test(line)) break;
    const match = /^ {2}([a-z_]+):/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

describe("events.ts stays in sync with experiment/EVENTS.yaml", () => {
  it("parses the declared event list", () => {
    const declared = declaredEvents();
    expect(declared.size).toBeGreaterThan(5);
    expect(declared.has("checkout_start")).toBe(true);
  });

  it("declares every event in EVENT_FUNNEL_MAP", () => {
    const declared = declaredEvents();
    const undeclared = Object.keys(EVENT_FUNNEL_MAP).filter(
      (name) => !declared.has(name),
    );
    expect(undeclared).toEqual([]);
  });

  it("ships no wrapper for an undeclared event", () => {
    const declared = declaredEvents();
    const source = readFileSync(
      path.join(process.cwd(), "src", "lib", "events.ts"),
      "utf8",
    );
    const tracked = [...source.matchAll(/track\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(tracked.length).toBeGreaterThan(5);
    expect(tracked.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("no longer exposes the retired pay_intent wrapper", async () => {
    const mod = await import("./events");
    expect("trackPayIntent" in mod).toBe(false);
  });
});

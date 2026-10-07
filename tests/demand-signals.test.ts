// Two cheap measurements that replace building cross-document checks.
//
// The claim was advertised in twelve places and the capability never existed.
// Rather than build it on a hunch, Monday's decision is made from two numbers:
// how many people ASK for it, and why the ones who leave are leaving.
//
// What these tests protect is the honesty of the first one. A demand probe that
// reads like a feature is just the removed claim wearing a different hat, and it
// would poison the number it exists to collect -- a click meaning "I thought
// this did something" is not a vote for building it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

const probe = () => read("src", "app", "scan-result", "cross-document-interest.tsx");
const events = () => read("experiment", "EVENTS.yaml");
const webhook = () => read("src", "app", "api", "webhooks", "stripe", "route.ts");

describe("the demand probe does not promise anything", () => {
  /** Only what a user reads: JSX text and string literals, not comments. */
  function visibleCopy(): string {
    return probe()
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  }

  // THE LOAD-BEARING ONE. "Coming soon" is a promise, and this product has
  // just deleted a dozen sentences that implied capability it did not have.
  // Nothing has been committed to: Monday decides, from this very number.
  it("never says coming soon, or any other commitment", () => {
    const copy = visibleCopy();
    for (const promise of [
      /coming soon/i,
      /\bsoon\b/i,
      /we('|’)ll be/i,
      /will be (?:added|available|built)/i,
      /\bnext (?:month|release|version)\b/i,
      /\broadmap\b/i,
    ]) {
      expect(copy, `promises: ${promise}`).not.toMatch(promise);
    }
  });

  // It has to say plainly that the product does NOT do this. A control that is
  // merely vague leaves the reader to assume the capability exists.
  it("states that the product does not do this today", () => {
    const copy = visibleCopy();
    expect(copy).toMatch(/does not compare|not checked|one document at a time/i);
  });

  it("records the click as a demand signal", () => {
    const source = probe();
    expect(source).toContain("trackFeatureInterestClick");
    expect(source).toContain('feature: "cross_document"');
  });

  // Fires once. A button that re-reports on every press turns one interested
  // person into a trend.
  it("reports once per visitor, not once per click", () => {
    const source = probe();
    expect(source).toMatch(/if \(asked\) return;/);
  });

  // The acknowledgement must describe what actually happened -- interest was
  // recorded -- and not imply the check was run or scheduled.
  it("acknowledges the click without implying the feature ran", () => {
    const copy = visibleCopy();
    expect(copy).toMatch(/recorded/i);
    expect(copy).not.toMatch(/checking|running|analys|we will|scheduled/i);
  });
});

describe("the event is declared before it is sent", () => {
  it("declares feature_interest_click in EVENTS.yaml", () => {
    const yaml = events();
    expect(yaml).toContain("feature_interest_click:");
    // `feature` is required: an unlabelled demand signal cannot be attributed
    // to anything once a second probe exists.
    const block = yaml.slice(yaml.indexOf("feature_interest_click:"));
    expect(block.slice(0, 700)).toMatch(/feature:[\s\S]{0,120}required: true/);
  });

  it("has a typed wrapper, as the analytics contract requires", () => {
    expect(read("src", "lib", "events.ts")).toContain("trackFeatureInterestClick");
  });
});

describe("why a customer cancelled is captured, not re-asked", () => {
  // Customers cancel in STRIPE'S billing portal, not ours -- "Manage billing or
  // cancel" sends them there. A prompt of our own would sit on a screen they
  // never see. Stripe's own cancel survey already collects the reason and ships
  // it in the webhook payload; we were discarding it.
  it("reads the reason from the Stripe payload", () => {
    const source = webhook();
    expect(source).toContain("cancellation_details?.feedback");
    expect(source).toContain("cancellation_details?.comment");
  });

  it("sends it on the cancellation event", () => {
    const source = webhook();
    const start = source.indexOf('trackServerEvent("subscription_canceled"');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 600);
    expect(block).toContain("cancel_feedback");
    expect(block).toContain("cancel_comment");
  });

  it("declares both properties in EVENTS.yaml", () => {
    const yaml = events();
    expect(yaml).toContain("cancel_feedback:");
    expect(yaml).toContain("cancel_comment:");
  });

  // Stripe's survey is skippable, so both fields are frequently absent. They go
  // through the same ""-is-not-a-value normalisation gclid gets, so "no answer"
  // never becomes an empty-string answer that queries count as a response.
  it("normalises an absent answer rather than sending an empty string", () => {
    const source = webhook();
    const start = source.indexOf("cancel_feedback:");
    expect(source.slice(start, start + 200)).toContain("nullableAttributionValue");
  });
});

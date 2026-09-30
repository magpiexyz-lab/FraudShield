// The stored value is a join key for Google Ads conversion uploads, so the two
// properties that matter are (a) the same person always hashes to the same
// string, whatever casing or whitespace they typed, and (b) "no email" never
// becomes a value that joins.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { hashEmailForMatching, EMAIL_SHA256_HEX_LENGTH } from "./email-hash";

// Computed independently of the implementation rather than pasted from its
// output: a test that asserts whatever the code produced would pass just as
// happily against a hash of the RAW string, which is the bug most likely here.
const sha256Hex = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

const ADDRESS = "bhavin@example.com";
const EXPECTED = sha256Hex(ADDRESS);

describe("hashEmailForMatching", () => {
  it("hashes the normalised address", () => {
    expect(hashEmailForMatching(ADDRESS)).toBe(EXPECTED);
  });

  it("produces a 64-character hex digest", () => {
    const digest = hashEmailForMatching(ADDRESS)!;
    expect(digest).toHaveLength(EMAIL_SHA256_HEX_LENGTH);
    expect(digest).toMatch(/^[0-9a-f]+$/);
  });

  // The whole point of normalising. Each of these is the same customer, and a
  // join that treats them as different people silently under-reports the sale.
  it.each([
    ["upper case", "BHAVIN@EXAMPLE.COM"],
    ["mixed case", "Bhavin@Example.Com"],
    ["leading and trailing spaces", "  bhavin@example.com  "],
    ["a trailing newline", "bhavin@example.com\n"],
    ["a tab", "\tbhavin@example.com"],
    ["all of the above", "  BHAVIN@Example.COM\n"],
  ])("matches the same address written with %s", (_label, variant) => {
    expect(hashEmailForMatching(variant)).toBe(EXPECTED);
  });

  // Normalisation must not reach further than case and whitespace. Two
  // genuinely different addresses staying distinct is the other half of a
  // correct join.
  it("keeps different addresses distinct", () => {
    expect(hashEmailForMatching("a@example.com")).not.toBe(
      hashEmailForMatching("b@example.com"),
    );
  });

  // Gmail dot-stripping is a Google-side matching rule, not a property of the
  // address, and is deliberately NOT applied here -- doing so would make the
  // column unjoinable against anything but Google. Pinned so the omission reads
  // as a decision rather than an oversight.
  it("does not strip gmail dots or plus-suffixes", () => {
    expect(hashEmailForMatching("first.last@gmail.com")).not.toBe(
      hashEmailForMatching("firstlast@gmail.com"),
    );
    expect(hashEmailForMatching("user+ads@gmail.com")).not.toBe(
      hashEmailForMatching("user@gmail.com"),
    );
  });

  // THE LOAD-BEARING ONE. sha256("") is a real digest, so hashing an absent
  // email would write one constant value to every row that lacked one -- and
  // then join all of those customers to each other. A wrong answer that looks
  // right is worse than a missing one.
  it.each([
    ["an empty string", ""],
    ["only whitespace", "   \t\n "],
    ["null", null],
    ["undefined", undefined],
    ["a number", 12345],
    ["an object", { email: "a@b.com" }],
  ])("returns null for %s", (_label, input) => {
    expect(hashEmailForMatching(input)).toBeNull();
  });

  it("never returns the digest of the empty string", () => {
    const emptyDigest = sha256Hex("");
    for (const input of ["", "   ", null, undefined]) {
      expect(hashEmailForMatching(input)).not.toBe(emptyDigest);
    }
  });
});

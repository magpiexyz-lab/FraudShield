// Why someone who reached Stripe Checkout did not pay.
//
// WHY IT EXISTS. We could see who opened Checkout and who paid, and nothing at
// all about the gap between -- the single largest and darkest drop in the
// funnel. subscription_canceled explains why a PAYING customer left; this
// explains why someone never became one. At $60/month unchanged, it separates
// a no-pay that is about price from one about trust or process, which are
// three different problems with three different fixes.
//
// vitest runs environment "node" with no jsdom, so the component cannot be
// rendered. The event contract is checked against EVENTS.yaml -- which Rule 2
// makes canonical -- and the rest are source contracts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

const EVENTS_YAML = read("experiment", "EVENTS.yaml");

/**
 * The checkout_abandon_reason block, as raw text.
 *
 * Read as text rather than parsed: js-yaml is not a declared dependency of
 * this project, only a transitive one, so importing it would make the suite
 * break on a clean install the day that transitive dep changes. Every other
 * schema test here reads its source as text for the same reason.
 */
function eventBlock(): string {
  // NO ESCAPE SEQUENCES IN HERE, deliberately. An earlier version split on a
  // regex and was written through a shell heredoc, which collapsed the
  // backslash and left a literal newline inside the pattern -- a syntax error
  // that read as "no tests found". Building the newline from its character
  // code cannot be mangled that way.
  const NL = String.fromCharCode(10);
  const lines = EVENTS_YAML.split(NL);

  const start = lines.findIndex((l) =>
    l.startsWith("  checkout_abandon_reason:"),
  );
  if (start === -1) return "";

  // Ends at the next key indented exactly two spaces — the next event, not a
  // property of this one.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const twoSpaceKey =
      l.length > 2 && l[0] === " " && l[1] === " " && l[2] !== " " &&
      l.trimEnd().endsWith(":");
    if (twoSpaceKey) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join(NL);
}
const PROMPT = read("src", "app", "pricing", "abandon-reason-prompt.tsx");
const PAGE = read("src", "app", "pricing", "page.tsx");
const EVENTS_TS = read("src", "lib", "events.ts");
const CHECKOUT_ROUTE = read("src", "app", "api", "checkout", "route.ts");

describe("the event is declared where the fleet reads it", () => {
  it("is in EVENTS.yaml", () => {
    expect(eventBlock()).not.toBe("");
  });

  it("sits in the monetize stage, beside the rest of the paid funnel", () => {
    expect(eventBlock()).toContain("funnel_stage: monetize");
  });

  it("requires a reason and leaves the free text optional", () => {
    const block = eventBlock();
    const reason = block.slice(block.indexOf("      reason:"));
    expect(reason.slice(0, 120)).toContain("required: true");
    const text = block.slice(block.indexOf("      reason_text:"));
    expect(text.slice(0, 120)).toContain("required: false");
  });

  // Rule 2: every event in EVENTS.yaml gets a typed wrapper, and nothing calls
  // the provider directly.
  it("has a typed wrapper", () => {
    expect(EVENTS_TS).toContain("export function trackCheckoutAbandonReason");
    expect(PROMPT).toContain("trackCheckoutAbandonReason");
    expect(PROMPT).not.toMatch(/from\s+"posthog-js"/);
  });
});

describe("all five answers can be given", () => {
  it("offers the four choices the question was designed around", () => {
    for (const value of ["price", "unsure_fit", "need_team_invoice", "just_looking"]) {
      expect(PROMPT).toContain(value);
    }
  });

  // A dismissal is a real answer about how willing abandoners are to explain
  // themselves. Swallowing it would make the four substantive reasons look
  // more representative than they are.
  it("records a skip rather than swallowing it", () => {
    expect(PROMPT).toContain('send("skipped")');
  });
});

describe("it is asked once, of the right person, at the right moment", () => {
  // The trigger is a fact about what they just did, not a guess: Stripe's back
  // button lands here. Someone browsing /pricing normally must never see it.
  it("only appears on a return from cancelled checkout", () => {
    expect(PROMPT).toContain('searchParams.get("checkout") === "cancelled"');
  });

  // That return URL is what makes the trigger work. If it ever changes, this
  // prompt silently stops appearing and nothing else breaks to tell us.
  it("matches the cancel_url the checkout route actually sends", () => {
    expect(CHECKOUT_ROUTE).toContain("/pricing?checkout=cancelled");
  });

  it("does not ask again once answered", () => {
    expect(PROMPT).toContain("fs_abandon_prompt_seen");
    expect(PROMPT).toContain("markAsked()");
  });

  // Blocked or unavailable storage must not take the page down, and must not
  // suppress the prompt either — asking is the safer failure.
  it("survives storage being unavailable", () => {
    const start = PROMPT.indexOf("function alreadyAsked");
    const body = PROMPT.slice(start, PROMPT.indexOf("export function", start));
    expect(body).toContain("try {");
    expect(body).toContain("catch");
    expect(body).toContain("return false");
  });

  // localStorage does not exist on the server; reading it during render makes
  // the server and client markup disagree.
  it("reads storage in an effect, not during render", () => {
    expect(PROMPT).toMatch(/useEffect\(\(\) => \{\s*if \(cancelled && !alreadyAsked\(\)\)/);
  });
});

describe("the free text is treated as untrusted input", () => {
  // Typed on a public page and forwarded to an analytics provider. An
  // unbounded string has no business making that trip.
  it("is trimmed and capped before it is sent", () => {
    expect(PROMPT).toContain("text.trim().slice(0, MAX_TEXT)");
    expect(PROMPT).toMatch(/maxLength=\{MAX_TEXT\}/);
  });

  // Absent rather than empty: an empty string in the payload is noise that
  // every later query has to filter out.
  it("omits the field entirely when left blank", () => {
    expect(PROMPT).toContain("...(trimmed ? { reason_text: trimmed } : {})");
  });
});

describe("the page wires it correctly", () => {
  // useSearchParams needs a boundary on a statically rendered page.
  it("wraps the prompt in Suspense", () => {
    const start = PAGE.indexOf("<Suspense");
    expect(start).toBeGreaterThan(-1);
    expect(PAGE.slice(start, start + 200)).toContain("<AbandonReasonPrompt />");
  });
});

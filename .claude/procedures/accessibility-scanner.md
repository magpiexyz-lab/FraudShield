# Accessibility Scanner Procedure

> Executed by the accessibility-scanner agent. See `.claude/agents/accessibility-scanner.md` for identity and output contract.

## Archetype Gate

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
>
> State-specific logic below takes precedence.

Read `experiment/experiment.yaml` to determine the archetype (`type` field, default: `web-app`).

If archetype is **not** `web-app`, skip all checks and report:

> N/A — not a web-app. Accessibility scanning only applies to web-app archetype.

## Method Selection

Check prerequisites in order:

1. Run `npx playwright --version`. If it fails → use **Static Fallback** (Section B).
2. Run `node -e "require('@axe-core/playwright')"`. If it fails → use **Static Fallback** (Section B).
3. Both available → use **Runtime Analysis** (Section A).

## Section A: Runtime Analysis (axe-core + Playwright)

### A1. Start Server

```bash
DEMO_MODE=true NEXT_PUBLIC_DEMO_MODE=true npm run start -- -p 3096 &
```

Poll `http://localhost:3096` until it responds (max 15 seconds, then abort).

### R1. axe-core Violations

Read `experiment/experiment.yaml` to get the list of pages from `golden_path`.

For each page, write an inline Node.js script using Playwright + `@axe-core/playwright`:

```javascript
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');

// For each golden_path page:
// 1. Navigate to the page
// 2. Run: const results = await new AxeBuilder({ page }).analyze()
// 3. Collect results.violations (each has: id, impact, description, nodes[].html, nodes[].target)
```

axe-core auto-detects 50+ WCAG 2.1 AA rules including: alt text, form labels, color contrast, ARIA attributes, heading hierarchy, lang attribute, and more.

### R2. Tab Order Test

For each golden_path page, write a Playwright script that:

1. Focus the page body
2. Press Tab up to 50 times, recording `document.activeElement` tag, text, and bounding box after each press
3. Flag issues:
   - **Focus jumps out of visual order** — element position regresses significantly (bounding box Y decreases by >200px)
   - **Focus trapped** — same element appears 3 consecutive times
   - **Focus skips visible interactive element** — a button/link/input visible in the viewport was never focused

### Cleanup

```bash
kill %1 2>/dev/null || true
```

## Section B: Static Fallback (grep-based)

> Used when Playwright or @axe-core/playwright is not installed.

Scan all `page.tsx`, `layout.tsx`, and component files under `src/`.

### A1. Images Without Alt Text (WCAG 1.1.1)

Search for `<img` and Next.js `<Image` components missing the `alt` attribute, or with `alt=""` on non-decorative images. Decorative images (`alt=""`) are acceptable only if the image is purely presentational.

**Severity:** High

### A2. Buttons Without Accessible Labels (WCAG 4.1.2)

Search for `<button` and `<Button` elements that have:
- No text content AND no `aria-label` / `aria-labelledby`
- Only an icon child with no screen reader text

Icon-only buttons must have `aria-label` or visually hidden text.

**Severity:** High

### A3. Form Inputs Without Labels (WCAG 1.3.1)

Search for `<input`, `<select`, `<textarea` elements that lack:
- An associated `<label>` (via `htmlFor` / wrapping)
- An `aria-label` or `aria-labelledby` attribute
- A `placeholder` alone does NOT count as a label

**Severity:** High

### A4. Color Contrast Heuristic (WCAG 1.4.3)

Search for inline styles and Tailwind classes that suggest low contrast:
- `text-gray-300` or lighter on white/light backgrounds
- `text-white` on light background classes (e.g., `bg-gray-100`)
- Inline `color` styles with light values (#ccc, #ddd, etc.) without dark backgrounds

This is a heuristic — flag as Medium since runtime rendering may differ.

**Severity:** Medium

### A5. Missing Heading Hierarchy (WCAG 1.3.1)

Within each page file, check heading levels. Flag if:
- A page jumps from `<h1>` to `<h3>` (skipping `<h2>`)
- A page jumps from `<h2>` to `<h4>` (skipping `<h3>`)
- Multiple `<h1>` elements exist in a single page

**Severity:** Medium

### A6. Missing Lang Attribute (WCAG 3.1.1)

Check the root `layout.tsx` file for `<html lang="...">`. The `lang` attribute must be present and non-empty. Missing `lang` is a violation.

**Severity:** High

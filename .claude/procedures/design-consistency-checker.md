# Design Consistency Checker Procedure

> Read-only cross-page visual consistency verification.
> Invoked by `.claude/agents/design-consistency-checker.md`.

## Step 0: Read Context

Read all `design-critic-*.json` traces from `.runs/agent-traces/`:

```bash
ls .runs/agent-traces/design-critic-*.json
```

Parse each trace for: page name, verdict, min_score, fixes_applied.

- If a page trace has `verdict: "unresolved"`, note it but still include the page in consistency checks
- If no per-page traces exist, log a warning and proceed with source-only analysis (skip C5)

## Step 1: Discover Pages

Build the full page list from:
1. Per-page design-critic trace filenames (authoritative — each `design-critic-<page>.json` maps to a page)
2. `base_url` routes from the spawn prompt (for screenshot navigation)

## Step 2: Static Analysis (C1-C4)

C1-C4 are **CODE-LEVEL** checks — deterministic, root-cause-focused. These analyze source code directly, not screenshots.

### C1: Color Consistency

Grep all page source files for Tailwind color classes:

```bash
grep -rn 'bg-\|text-\|border-\|from-\|to-\|via-\|ring-' src/app/*/page.tsx
```

Build a color class frequency map per page. Flag:
- A page uses a color family (e.g., `gray-*`) that NO other page uses
- A page is MISSING a color family that appears on 2+ other pages

Severity: `major` if brand primary/secondary differs, `minor` if accent/neutral drifts.

### C2: Typography Consistency

Grep for font-family declarations and Tailwind text-size classes:

```bash
grep -rn 'font-\|text-xs\|text-sm\|text-base\|text-lg\|text-xl\|text-2xl\|text-3xl\|text-4xl' src/app/*/page.tsx
```

Flag:
- A page uses a different font stack than others
- Heading size hierarchy differs (e.g., page A uses `text-3xl` for h1, page B uses `text-4xl`)

Severity: `major` if font-family differs, `minor` if size scale shifts.

### C3: Spacing Consistency

Analyze Tailwind spacing classes across pages:

```bash
grep -rn 'p-\|px-\|py-\|m-\|mx-\|my-\|gap-\|space-' src/app/*/page.tsx
```

Flag:
- A page uses a spacing token as primary content spacer (section padding, card gaps) that NO other page uses in the same structural role

Severity: `major` if section-level spacing diverges, `minor` if component-level.

### C4: Component Consistency

Check shared components usage across pages:

```bash
grep -rn 'Button\|Card\|Nav\|Footer\|Header' src/app/*/page.tsx
```

Flag:
- Same component rendered with different variant props across pages
- A shared component present on some pages but missing on others (e.g., footer on 3/5 pages)

Severity: `major` if nav/footer inconsistent, `minor` if button variants differ.

## Step 3: Visual Analysis (C5)

C5 is **SCREENSHOT-BASED** — catches visual symptoms that code analysis might miss (e.g., CSS inheritance effects, dynamic styling).

Using the `base_url` from the spawn prompt:

1. Launch Chromium (headless) via Playwright
2. Visit each page route at **1280x800** viewport
3. Wait for network idle + 1s settle time
4. Take full-page screenshots to `/tmp/consistency-check/<page-name>.png`
5. If Playwright fails (not installed, base_url unreachable), skip C5 and note `"C5_skipped": true` in trace

### C5: Layout Consistency

Compare screenshots for structural elements:
- Header/nav bar presence and position
- Footer presence and position
- Content width and alignment
- Sidebar presence consistency

Flag pages missing expected structural elements present on 2+ other pages.

Severity: `major` if structural element missing, `minor` if positioning differs.

## Step 4: Cleanup

```bash
rm -rf /tmp/consistency-check
```

## Step 5: Compute Trace Metrics

Before writing the trace file, compute these metrics from your checks:

- **`pages_reviewed`**: total pages checked
- **`passed_count`**: checks C1-C5 that returned pass (0-5)
- **`failed_count`**: checks C1-C5 that returned fail (0-5)
- **`severity`**: highest severity across all inconsistencies (`"none"` if all pass, `"minor"` or `"major"` otherwise)
- **`inconsistencies_found`**: total count of distinct inconsistencies across all checks
- **`inconsistencies`**: array of structured findings, each with: `check` (C1-C5), `severity`, `pages` (affected page names), `detail` (specific class names or values)

Write the final trace per the agent definition's Trace Output section.

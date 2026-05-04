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

## Step 2.5: Budget Self-Monitoring (added per #1257)

C5 (screenshot-based) is the most expensive step — each page requires a
Playwright screenshot + analysis. On projects with > 8 pages, naive iteration
can exhaust the agent's `maxTurns` budget mid-loop, leaving zero substantive
cross-page review. The Tier 2 Exhaustion Protocol then writes a
`verdict: incomplete` recovery trace (WARN, not BLOCK), but no real findings
emerge.

This soft-exit primitive prevents that outcome by letting the agent emit a
**partial trace with verdict from the pages it DID complete**, rather than
failing closed.

### Setup (run once at agent start, before C5)

Read `expected_pages: <N>` from the spawn prompt (passed by state-3b
Stage 2). Compute:

```
per_page_budget = floor(maxTurns / expected_pages)
```

Track `consumed_turns` as a counter — increment it once per Bash invocation,
file read, or tool call. (Claude Code does not expose a `turns_remaining`
introspection API; the agent-side counter is the deterministic substrate.)

### Boundary check (run AFTER each page's C5 screenshot + analysis completes)

After completing C5 for page index `i` (1-indexed), compute:

```
expected_consumed = floor((i / expected_pages) * maxTurns)
threshold = 50  # slack for setup + per-page overhead

if consumed_turns > expected_consumed + threshold:
    # Soft-exit: emit partial trace and exit cleanly.
    emit_soft_exit()
    return
```

### Soft-exit invocation

When the budget threshold is crossed, write a partial trace via
`write-degraded-trace.py`:

```bash
python3 .claude/scripts/write-degraded-trace.py design-consistency-checker \
  --reason "budget-soft-exit" \
  --verdict "$( [ "$INCONSISTENT_COUNT" -gt 0 ] && echo fail || echo pass )" \
  --checks-performed "C1-color,C2-typography,C3-spacing,C4-component,C5-layout" \
  --extra-json '{
    "inconsistent_count": <N>,
    "pages_reviewed": <M>,
    "pages_remaining": ["<page-slug-1>", ...],
    "inconsistencies": [...]
  }'
```

**NOTE**: `write-degraded-trace.py` automatically sets `partial: true` and
`provenance: self-degraded` (line 192). Do NOT pass a `--partial` flag —
it does not exist; the field is set unconditionally for self-degraded
traces.

**Verdict semantics**: the verdict reflects findings from the COMPLETED
pages only. If 10/18 pages reviewed and 0 inconsistencies → `verdict=pass`
with `partial=true` (clear coverage signal in `pages_remaining`). If 10/18
reviewed and 3 inconsistencies → `verdict=fail` with `inconsistent_count=3`
and `partial=true`. This preserves the invariant `verdict==fail iff
inconsistent_count > 0`.

State-3b VERIFY accepts `partial: true` as valid completion (not retry
trigger); state-7a verify-report displays `pages_reviewed` and
`pages_remaining` so the user can judge coverage.

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

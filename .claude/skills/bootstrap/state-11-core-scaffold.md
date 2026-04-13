# STATE 11: CORE_SCAFFOLD

**PRECONDITIONS:**
- Design done (STATE 10 POSTCONDITIONS met)
- `.runs/current-visual-brief.md` exists
- Theme tokens available

**ACTIONS:**

#### Phase A (serial, before fan-out, web-app only)

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, row "Phase A (core scaffold)".
>
> web-app: run Phase A (layout, 404, error, favicon, OG, sitemap, robots, llms.txt) | service: skip | cli: skip

Service and cli archetypes skip Phase A entirely — proceed to STATE TRACKING to advance state immediately.

The lead (not a subagent) creates:
- Root layout (`src/app/layout.tsx`) with font imports and globals.css
- 404 page (`src/app/not-found.tsx`)
- Error boundary (`src/app/error.tsx`)
- Favicon (`src/app/icon.tsx`) -- monogram of project name initial in primary color, 128x128, using `ImageResponse` from `next/og`. Uses a system font (sans-serif) -- do NOT fetch Google Fonts in Satori context. Read primary color from `globals.css` `--primary` token or hardcode the derived value.
- OG image (`src/app/opengraph-image.tsx`) -- 1200x630 branded card with project name centered on primary-color gradient background. Uses `ImageResponse` from `next/og` with system font.
- Sitemap (`src/app/sitemap.ts`) -- Next.js built-in sitemap generation from golden_path pages
- Robots (`src/app/robots.ts`) -- Next.js built-in robots.txt, allow all crawlers for MVP
- llms.txt (`public/llms.txt`) -- static AI-readable product summary per messaging.md Section E
- Variant routing files (if `variants` in experiment.yaml): `src/lib/variants.ts`, `src/app/page.tsx`, `src/app/v/[variant]/page.tsx`

Phase A runs AFTER scaffold-init completes (STATE 10) to ensure design tokens exist.

After creating all Phase A files, write the Phase A sentinel. Include variant files in the list when `variants` is present in experiment.yaml:
```bash
mkdir -p .runs/gate-verdicts
bash .claude/scripts/archive-gate-verdict.sh phase-a-sentinel
CORE_FILES='["src/app/layout.tsx","src/app/not-found.tsx","src/app/error.tsx","src/app/icon.tsx","src/app/opengraph-image.tsx","src/app/sitemap.ts","src/app/robots.ts","public/llms.txt"'
if grep -q '^variants:' experiment/experiment.yaml 2>/dev/null; then
  CORE_FILES+=',"src/lib/variants.ts","src/app/page.tsx","src/app/v/[variant]/page.tsx"'
fi
CORE_FILES+=']'
cat > .runs/gate-verdicts/phase-a-sentinel.json << PAEOF
{"phase_a_complete": true, "timestamp": "<ISO 8601>", "files": ${CORE_FILES}}
PAEOF
```

VERIFY Phase A before proceeding (**web-app only** — service and cli archetypes skip this entire block since they skip Phase A):
- `test -f src/app/layout.tsx`
- `test -f src/app/not-found.tsx`
- `test -f src/app/error.tsx`
- `test -f src/app/icon.tsx`
- `test -f src/app/opengraph-image.tsx`
- `test -f src/app/sitemap.ts`
- `test -f src/app/robots.ts`
- `test -f public/llms.txt`
- `test -f .runs/gate-verdicts/phase-a-sentinel.json`
- If `variants` is present in experiment.yaml: `test -f src/lib/variants.ts && test -f src/app/page.tsx && test -f "src/app/v/[variant]/page.tsx"`

**POSTCONDITIONS:**
- Phase A sentinel written (web-app) or skipped (service/cli)
- Core files created (web-app only)

**VERIFY:**
```bash
python3 -c "import json,os; a=json.load(open('.runs/bootstrap-context.json')).get('archetype','web-app'); assert a!='web-app' or os.path.isfile('.runs/gate-verdicts/phase-a-sentinel.json'), 'phase-a-sentinel missing'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 11
```

**NEXT:** Read [state-11a-lib-scaffold.md](state-11a-lib-scaffold.md) to continue.

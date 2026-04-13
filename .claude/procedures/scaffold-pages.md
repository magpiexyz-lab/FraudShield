# Scaffold: App Shell & Pages

## Prerequisites
- Packages installed and UI setup complete (Step 1 finished)
- Stack files and archetype file on disk
- `.runs/current-plan.md` exists
- `design.md` choices recorded in globals.css and tailwind config
- `.runs/current-visual-brief.md` exists (visual language brief from init)

## Dependency note

Pages import from `src/lib/events.ts` (created by scaffold-libs in Phase B1).
scaffold-libs completes and writes its manifest before scaffold-pages launches in Phase B2.
The `src/lib/events.ts` file exists when this agent runs — import typed wrappers directly.

## Instructions by archetype

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.

### web-app

#### App shell (Step 3)
- Follow the framework stack file's file structure and page conventions
- **Root layout**: metadata from experiment.yaml `title`, import globals.css. Set up the display font per the UI stack file's "Theme Setup" section (chosen font via `next/font/google`, apply variable to `<html>`). Also implement `retain_return` tracking following the framework stack file's `retain_return` section and experiment/EVENTS.yaml
- **404 page**: simple not-found page with link back to `/`
- **Error boundary**: user-friendly message and retry button

#### SEO baseline (Step 3b, web-app only)
- Generate `src/app/sitemap.ts` — export a default function returning `MetadataRoute.Sitemap` with URLs derived from golden_path pages (each page entry maps to a URL path)
- Generate `src/app/robots.ts` — export a default function returning `MetadataRoute.Robots` allowing all crawlers (`{ rules: { userAgent: '*', allow: '/' } }`)
- Generate `public/llms.txt` — content per messaging.md Section E (display name, meta description, behaviors list)
- Ensure layout.tsx `metadata` export uses messaging.md Section E derivation: `title` = meta title, `description` = meta description, `openGraph` = `{ title, description }`

#### Pages (Step 4)
For each page derived from experiment.yaml `golden_path`:
- If `name` is `landing` → create the root page
- Otherwise → create a page at the appropriate route
- Every page file must:
  - Follow page conventions from the framework stack file
  - If `stack.analytics` is present: import tracking functions per the analytics stack file conventions and fire the appropriate experiment/EVENTS.yaml event(s) on the correct trigger
  - Follow `.claude/patterns/design.md` quality invariants (form input sizing). Aim for a distinctive, polished look that matches the product domain.
  - For empty states (empty tables, lists, dashboards): use the empty-state image from `.runs/image-manifest.json` (e.g., `<img src="/images/empty-state.svg" alt="No items yet" />`). This file is generated during Phase B1.
  - If an event from the experiment/EVENTS.yaml events map has no matching page in experiment.yaml (e.g., no signup page for signup_start/signup_complete), omit that event — do not create a page just to fire it
- **Landing page**: Do NOT generate the landing page content here — it is
  created by the landing-page subagent (see `scaffold-landing.md`). If
  experiment.yaml has `variants`, create only the structural routing files here:
  - `src/lib/variants.ts` — typed `VARIANTS` array (slug, headline,
    subheadline, cta, pain_points, isDefault) and `getVariant(slug)` helper
  - Root `src/app/page.tsx` — imports and renders `LandingContent` with the
    default variant's props. Fires `visit_landing` with `variant` property.
  - `src/app/v/[variant]/page.tsx` — dynamic route, imports `LandingContent`,
    fires `visit_landing` with `variant` property. `generateStaticParams()`
    for all variant routes. Returns `notFound()` for unknown slugs.
  If no `variants`, skip entirely — the landing-page subagent creates `src/app/page.tsx`.
- **Auth pages (if listed in golden_path)**: signup/login form pages using auth provider UI templates from the auth stack file. Create only the page files (`signup/page.tsx`, `login/page.tsx`) — auth infrastructure (callback, reset-password, nav-bar) is created by scaffold-wire.
  Fire the corresponding experiment/EVENTS.yaml events at their specified triggers.
  If `stack.auth_providers` is present in experiment.yaml: add OAuth login buttons for each
  listed provider below the email/password form, using the OAuth button template and
  `handleOAuthLogin` function from the auth stack file's "OAuth buttons" section.
  Fire `trackSignupStart({ method: "<provider>" })` before the OAuth redirect.
  Update the post-auth redirect in signup and login pages to navigate to the first
  non-auth, non-landing page from experiment.yaml (e.g., `/dashboard`). If no such page
  exists, keep the redirect to `/`.
- If `stack.email` is present: wire the welcome email API call into the auth success callback. After `signup_complete` event fires, call `/api/email/welcome` with the user's email and name. Read the email stack file for the route handler template.
- **All other pages**: For each non-landing, non-auth page, apply the
  preloaded `frontend-design` guidelines (injected via skills) with:
  - The existing theme tokens (from `src/app/globals.css` and tailwind config)
  - The page's `purpose` from experiment.yaml
  - The visual language brief from `.runs/current-visual-brief.md` (palette,
    typography, animation, spacing, component style, and texture decisions)
  - Instruction: "Design a top-tier SaaS product screen (think Linear, Vercel,
    Raycast). Follow the visual language brief for palette, typography,
    animation, spacing, and component styling. Optimized for utility: clear
    information hierarchy, appropriate data density, loading states, empty
    states, micro-interactions. Not a marketing page — a professional tool
    interface."
  If `frontend-design` guidelines are not available: use your own judgment —
  consume the theme tokens, match the product's visual identity, and follow
  the inner page utility criteria from design.md.
  Each page must have heading, description matching purpose, and a clear
  next-action CTA

#### Feature→UI cross-reference (after page creation)

For each experiment.yaml `behavior` that has a corresponding API route:
1. Check if the behavior describes a **user-facing interaction** (chat, wizard, form, file upload, etc.) — not just a background process or data query
2. If yes, check if a page in experiment.yaml already provides the UI for this interaction
3. If no page exists: create a reusable component at `src/components/<feature>-widget.tsx` that calls the API route and provides the interactive UI
4. Ensure any landing page CTA referencing this feature opens or navigates to the component — not an unrelated page

This step only applies to the **web-app** archetype. Skip for service and cli.

> **STOP** — verify analytics per `patterns/analytics-verification.md` before finishing (skip if `stack.analytics` is absent).

> **Note:** Visual rendering review (screenshots, layout breaks, mobile responsiveness)
> is performed by the design-critic agent in `/verify` (web-app only). Scaffold agents
> are responsible for code-level quality via the Utility Self-Check above.

### service

Skip shell and pages. Create API directory structure only:
- `src/app/api/` directory with placeholder route folders for each endpoint in experiment.yaml
- Follow the framework stack file's route handler conventions

### cli

Skip shell and pages. Create CLI entry point and command modules:
- `src/index.ts` — CLI entry point with bin config
- `src/commands/` — one module per experiment.yaml command
- Follow the framework stack file's conventions


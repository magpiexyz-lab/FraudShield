---
assumes: []
packages:
  runtime: [next, react, react-dom]
  dev: [typescript, "@types/react", "@types/node", "eslint@9", "@eslint/js", typescript-eslint, eslint-plugin-react-hooks, "@next/eslint-plugin-next"]
files:
  - .nvmrc
  - eslint.config.mjs
  - src/app/layout.tsx
  - src/app/page.tsx              # conditional: web-app
  - src/app/route.ts              # conditional: service with co-located surface
  - src/app/not-found.tsx         # conditional: web-app
  - src/app/error.tsx             # conditional: web-app
  - src/app/icon.tsx              # conditional: web-app
  - src/app/opengraph-image.tsx   # conditional: web-app
  - src/app/sitemap.ts            # conditional: web-app
  - src/app/robots.ts             # conditional: web-app
  - src/components/RetainTracker.tsx  # conditional: web-app
env:
  server: []
  client: []
ci_placeholders: {}
clean:
  files: [.nvmrc, package.json, package-lock.json, tsconfig.json, next.config.ts, next-env.d.ts, eslint.config.mjs]
  dirs: [node_modules, .next, out]
gitignore: [.next/, out/]
---
# Framework: Next.js (App Router)
> Used when experiment.yaml has `stack.services[].runtime: nextjs`

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.

> **Conditional files**: Files marked `# conditional` in the frontmatter `files` list are only created when the condition matches. Bootstrap skips conditional files whose archetype or surface type does not apply. The archetype file (`.claude/archetypes/<type>.md`) and the resolved surface type determine which conditionals are included.

## Packages
```bash
npm install next react react-dom
npm install -D typescript @types/react @types/node eslint@9 @eslint/js typescript-eslint eslint-plugin-react-hooks @next/eslint-plugin-next
# Pin eslint@9 — eslint-plugin-react-hooks requires flat config (eslint 9); update all 4 framework stack files when eslint 10 ships
```

## Project Setup
- `.nvmrc`: containing `20` (used by CI and local version managers)
- `package.json`: `scripts` with `dev`, `build`, `start`, `lint` (`eslint src/`); `engines: { "node": ">=20" }`. Stack-specific scripts (e.g., `prebuild` for database auto-migrate) are added by the owning scaffold-libs stage together with the target file it invokes — scaffold-setup must NOT write such script entries ahead of the helper file's creation, which would leave a fragile window where any intermediate `npm run build` fails at an unresolvable `prebuild`.
- `tsconfig.json`: enable `strict: true` and `@/` path alias mapping to `src/`
- `next.config.ts`: minimal, no custom config

### `eslint.config.mjs`
```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { "react-hooks": reactHooks }, rules: { ...reactHooks.configs.recommended.rules, "react-hooks/set-state-in-effect": "off" } },
  { plugins: { "@next/next": nextPlugin }, rules: nextPlugin.configs.recommended.rules },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  { ignores: [".next/", "out/", "node_modules/", "src/components/ui/", "src/components/magicui/"] }
);
```
> **Underscore-prefix convention:** The `^_` ignore pattern lets you mark intentionally unused params as `_userId`, `_brandId`, etc. without tripping `no-unused-vars` — standard TS/ESLint convention. Without it, any project with an unused underscore-prefixed callback param (common in API handlers, test stubs, typed wrappers) fails `npm run lint`.

> **Known Issue — `eslint-disable` comments:** When generating `eslint-disable-next-line` comments, use the generic form (`// eslint-disable-next-line`) without a rule name. Rule-specific forms like `// eslint-disable-next-line react/no-danger` cause errors if the corresponding plugin (e.g., `eslint-plugin-react`) is not installed. Only specify rule names for rules known to be configured in the eslint config above.

## File Structure

**web-app archetype:**
```
src/
  app/              # App Router pages and API routes
    layout.tsx      # Root layout — <html>, <body>, metadata, globals.css import
    page.tsx        # Landing page (/)
    not-found.tsx   # 404 page with link back to / — MUST export a `metadata` object
    error.tsx       # Error boundary with "use client", user-friendly message, retry + home link
    icon.tsx        # Dynamic favicon -- monogram in primary color (Next.js Metadata File API)
    opengraph-image.tsx  # Dynamic OG image -- branded card (Next.js Metadata File API)
    api/            # API route handlers (all mutations go here)
      <resource>/
        route.ts    # Route handler
    <page-name>/    # One folder per experiment.yaml page
      page.tsx      # Page component
  components/       # Reusable UI components
    ui/             # UI library components (auto-generated)
  lib/              # Utilities (analytics, database clients, types, etc.)
```

**service archetype:** No page folders, no UI components, no `src/components/` directory.
```
src/
  app/              # App Router — API routes only
    layout.tsx      # Root layout (minimal — required by Next.js App Router)
    route.ts        # Root route handler (GET /) — co-located surface HTML page
    api/            # API route handlers
      <endpoint>/
        route.ts    # Endpoint handler
  lib/              # Utilities (analytics, database clients, types, etc.)
```
The root `route.ts` is created only when surface is `co-located` (the default for services). It returns a complete HTML marketing page — see `surface/co-located.md` for content guidance.

## Page Conventions
- Default to `"use client"` for all page and component files
- Exception: `layout.tsx` MUST remain a server component (required for `metadata` export). Do NOT add "use client" to layout.tsx.
- One `page.tsx` per route folder
- `layout.tsx` for root layout only
- Import analytics tracking functions in every page that fires events (see analytics stack file for exports)
- Exception: when a page needs both `generateStaticParams()` (server export) and client-side hooks (`useEffect`, analytics tracking), split into two files:
  - `page.tsx` — server component, exports `generateStaticParams`, imports and renders the client component with props
  - `<name>-client.tsx` — `"use client"`, receives props, handles interactivity and analytics
  Next.js does not allow `generateStaticParams` in `"use client"` components.

### SEO Metadata Conventions
- `layout.tsx` MUST export a `metadata` object (Next.js Metadata API) with `title`, `description`, and `openGraph` fields — derived per messaging.md Section E
- Variant pages export `generateMetadata()` to override layout defaults with variant-specific title/description
- JSON-LD structured data — archetype-specific injection:
  - **web-app** (React): use `next/script` with the JSON passed as children. This avoids the React prop that takes a `{ __html: ... }` payload (which trips security-review hooks and forces an `eslint-disable` that then fails as an unused-disable). `next/script` renders inline `<script>` safely from the children string.

    ```tsx
    import Script from "next/script";
    // ...
    <Script id="ld-app" type="application/ld+json" strategy="beforeInteractive">
      {JSON.stringify(jsonLd)}
    </Script>
    ```

  - **service / cli** (plain HTML): write `<script type="application/ld+json">...</script>` directly in the inline HTML `<head>` — no React, so the prop concern does not apply (see `procedures/scaffold-landing.md` per-archetype JSON-LD embedding).

  Schema.org type per archetype: `WebApplication` (web-app), `WebAPI` (service), `SoftwareApplication` (cli).
- `src/app/sitemap.ts`: export a default function returning `MetadataRoute.Sitemap` — URLs derived from `derive_scope_pages(experiment)` (call `python3 .claude/scripts/lib/derive_pages.py scope < experiment/experiment.yaml`); see `.claude/procedures/scaffold-pages.md` Step 3b for the contract
- `src/app/robots.ts`: export a default function returning `MetadataRoute.Robots` — allow all crawlers for MVP (`{ rules: { userAgent: '*', allow: '/' } }`)

## React 19 Patterns
- Use ref as a regular prop -- do NOT use `React.forwardRef`. React 19 passes ref as a standard prop.
- Use `useActionState` instead of `useFormState` (renamed in React 19).

## Suspense Requirements
- Any component using `useSearchParams()` MUST be wrapped in a `<Suspense>` boundary (Next.js 15 requirement)
- Pattern: create a client component that uses the hook, wrap it in Suspense in the parent page

## API Route Conventions
- Route handlers in `src/app/api/<resource>/route.ts`
- Validate all input with zod — always include `.max()` bounds on all string and array fields. Suggested defaults: short text fields `.max(200)`, long text fields `.max(5000)`, array fields `.max(50)`. Adjust per business logic. Without bounds, a single oversized request can exhaust memory or run up large inference costs.
- Dynamic route segment params (e.g., `[id]` in `src/app/api/projects/[id]/route.ts`) must be validated before use. Parse `params` with zod: `z.object({ id: z.uuid() }).parse(await params)`. Reject non-UUID values with 400 before they reach database queries. This prevents malformed inputs (SQL-injection-style strings, excessively long values) from reaching the database layer.
- Return `{ error: string }` with appropriate HTTP status codes on failure
- Use try/catch, return user-friendly error messages
- When catching `ZodError`, return generic `{ error: "Invalid request" }` with status 400 — never forward `error.issues` or `error.message` which expose schema structure to attackers (OWASP A4-InfoLeakage)

## CORS Policy

API routes use same-origin by default (no CORS headers needed for same-domain requests). When cross-origin access is required:

- Set `ALLOWED_ORIGIN` env var to the specific origin (e.g., `https://app.example.com`)
- Never use `Access-Control-Allow-Origin: *` on routes that require authentication
- Apply CORS headers in the route handler:
```typescript
const allowedOrigin = process.env.ALLOWED_ORIGIN;

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin ?? "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
```
- For MVP experiments, same-origin is almost always sufficient — add CORS only when a separate frontend or mobile app calls the API

## Data Fetching
- Client-side: `fetch` in useEffect or SWR
- Server-side (API routes): direct database calls via server client

## Restrictions
- No Server Actions — use API routes for all mutations
- No caching configuration (`revalidate`, `cache`, etc.)
- No parallel routes or intercepting routes
- No `@apply` with custom class names in CSS -- Tailwind v4 only supports `@apply` with utility classes. Use inline utility classes or `@theme` for custom values.

### `src/app/error.tsx` — Error boundary (web-app only)

```tsx
"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <h2 className="text-2xl font-bold">Something went wrong</h2>
      <p className="text-muted-foreground max-w-md">
        An unexpected error occurred. You can try again or go back to the home page.
      </p>
      <div className="flex gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>Back to Home</Link>
      </div>
    </div>
  );
}
```

Notes:
- Always include both a retry button (`reset()`) and a navigation link — if the error is persistent, the user needs an escape route
- The `Link` import is from `next/link`; the `Button` import assumes shadcn/ui is present (when `stack.ui: shadcn`, which is the default)

## Accessibility

> This section is **unconditional** — it applies to every web-app bootstrap regardless of `stack.analytics`, `stack.auth`, or variants.

### Root layout — skip-nav link + `<main id="main-content">` for WCAG 2.4.1 (Bypass Blocks)

The root `<body>` must include a visually-hidden skip-navigation anchor before the first visible navigation block, and the `<main>` wrapper around `{children}` must carry `id="main-content"` so the anchor can target it. Keyboard users tab to the skip link first and jump past every repeated nav item.

```tsx
// In src/app/layout.tsx <body>:
// Added by scaffold-wire Step 5c when stack.auth is present:
import { NavBar } from "@/components/nav-bar";
// Added by scaffold-wire Step 5c when stack.analytics is present:
import { RetainTracker } from "@/components/RetainTracker";

<a
  href="#main-content"
  className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-background focus:text-foreground focus:rounded"
>
  Skip to main content
</a>
{/* Only when stack.auth is present — scaffold-wire Step 5c adds this: */}
<NavBar />
<main id="main-content">{children}</main>
{/* Only when stack.analytics is present — scaffold-wire Step 5c adds this: */}
<RetainTracker />
```

Both additions (the `<a>` skip link and `id="main-content"` on `<main>`) are required for WCAG 2.4.1 to pass. Without the skip link, keyboard-only users must tab through every nav item on every page; without the matching `id`, the skip link has nowhere to jump.

### Multi-nav layouts — unique `aria-label` on each `<nav>`; decorative logos `alt=""`

Pages that render more than one `<nav>` (e.g., top NavBar + landing-page marketing nav, or NavBar + footer) must give each `<nav>` element a unique `aria-label`. Without labels, screen readers announce both as "navigation" with no way for the user to distinguish them.

```tsx
<nav aria-label="Primary">{/* main NavBar */}</nav>
<nav aria-label="Footer">{/* footer nav */}</nav>
```

When a logo `<img>` or `<Image>` is placed directly next to visible brand text, set `alt=""` and `aria-hidden="true"` on the image so the brand name is not announced twice.

```tsx
import Image from "next/image";
import Link from "next/link";

<Link href="/" className="flex items-center gap-2">
  <Image src="/images/logo.svg" alt="" aria-hidden width={32} height={32} />
  <span>APP_NAME</span>
</Link>
```

If the logo is standalone (no adjacent brand text), keep `alt="APP_NAME"` — only decorate with `alt=""` when the text is already announced.

## retain_return Tracking

When `stack.analytics` is absent: skip this entire section — the RetainTracker component exists solely to fire analytics events.

Create a client component for retain_return tracking and render it in the root layout. **Created by scaffold-wire (Step 5c)** — not by scaffold-pages (which is barred from `src/components/`). This keeps the root layout as a server component (required for `metadata` export) while running client-side localStorage logic in a separate component.

### `src/components/RetainTracker.tsx` — Client component
```tsx
"use client";

import { useEffect } from "react";
import { trackRetainReturn } from "@/lib/events";

export function RetainTracker() {
  useEffect(() => {
    try {
      const lastVisit = localStorage.getItem("last_visit_ts");
      if (lastVisit) {
        const days = Math.floor((Date.now() - Number(lastVisit)) / 86_400_000);
        if (days >= 1) {
          trackRetainReturn({ days_since_last: days });
        }
      }
      localStorage.setItem("last_visit_ts", String(Date.now()));
    } catch {
      // localStorage unavailable — skip silently
    }
  }, []);

  return null;
}
```

In the root layout (a server component — do NOT add "use client" to layout.tsx).
These imports are added by **scaffold-wire (Step 5c)** after creating the components:
```tsx
// Added by scaffold-wire Step 5c when stack.analytics is present:
import { RetainTracker } from "@/components/RetainTracker";
// Added by scaffold-wire Step 5c when stack.auth is present:
import { NavBar } from "@/components/nav-bar";

// Inside the <body> tag — see the Accessibility section above for the full
// skip-nav link + <main id="main-content"> pattern that applies unconditionally:
<NavBar />           {/* Only when stack.auth is present — scaffold-wire Step 5c */}
<main id="main-content">{children}</main>
<RetainTracker />    {/* Only when stack.analytics is present — scaffold-wire Step 5c */}
```

## Security
- All `"use client"` components run in the browser — never import server-only secrets or database admin clients in client components
- API route handlers (`src/app/api/`) run server-side — use them for all mutations and sensitive operations
- Validate all API route inputs with zod before processing
- Return generic error messages to the client — do not leak stack traces or internal details

## Stack Knowledge

### When verifying shared secrets in API routes (cron triggers, webhooks)
Use `crypto.timingSafeEqual` instead of `===` or `!==`. String equality is vulnerable to timing side-channels — an attacker can infer secret characters by measuring response-time differences.

```typescript
import { timingSafeEqual } from "crypto";

function verifySecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### When a page fails the checkNoHorizontalOverflow smoke test on Mobile Chrome
Add `overflow-x-hidden` to the outermost wrapper `<div>` of the page component. Wide flex rows, animated elements, and shadcn Card grids are the most common cause of horizontal overflow on mobile viewports. This is the standard first fix; if overflow persists, audit for elements with fixed pixel widths or negative margins.

**If `overflow-x-hidden` on the outer wrapper does not fix the overflow:** check for `position: absolute` decorative elements (radial glows, blobs, geometric shapes — commonly 600–900px wide) inside child containers that lack `position: relative`. The absolute element's containing block falls through to the nearest positioned ancestor, which may be the `<body>` or viewport — NOT the wrapper you added `overflow-x-hidden` to. The element therefore escapes the clipping region and keeps causing horizontal scroll.

Fix: add `relative` to the nearest ancestor wrapper of the absolute-positioned decoration so it establishes the containing block. The scope stays local:

```tsx
// WRONG — glow escapes clipping because inner div is not positioned
<div className="overflow-x-hidden">
  <div>
    <div className="absolute w-[820px] h-[820px] bg-gradient-radial ..." />
    {children}
  </div>
</div>

// CORRECT — inner div is position:relative, glow is clipped by the ancestor
<div className="overflow-x-hidden">
  <div className="relative">
    <div className="absolute w-[820px] h-[820px] bg-gradient-radial ..." />
    {children}
  </div>
</div>
```

### Place rate limiting after auth and API key checks in AI routes
In API routes that call external AI services (Anthropic, OpenAI, etc.), run authentication and API key validation *before* `rateLimit()`. If rate limiting runs first:
1. An unconfigured deployment (missing API key) returns 429 instead of the correct 503, hiding the real problem
2. Unauthenticated requests consume rate-limit budget, returning 429 instead of 401 and masking the auth failure

Correct order: `verifyAuth()` → `checkApiKey()` → `rateLimit()` → business logic.

### When handling file uploads, sanitize filenames before storage key interpolation
User-supplied filenames can contain path traversal sequences (`../`, `..\`), null bytes, or special characters that break storage key construction. Always sanitize before interpolating into a storage path:

```typescript
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, "-")       // path separators
    .replace(/\.\./g, "")          // traversal sequences
    .replace(/[^a-zA-Z0-9._-]/g, "-") // non-safe chars
    .replace(/-+/g, "-")           // collapse consecutive hyphens
    .slice(0, 255);                // filesystem limit
}

// Usage: prepend a UUID to prevent collisions and predictable paths
const key = `uploads/${crypto.randomUUID()}/${sanitizeFilename(file.name)}`;
```

### Zod v4: use top-level string-format validators (`z.uuid()`, `z.url()`, `z.email()`)
Zod v4 promoted all string-format validators to top-level factories: `z.string().uuid()` → `z.uuid()`, `z.string().url()` → `z.url()`, `z.string().email()` → `z.email()`, `z.string().cuid()` → `z.cuid()`, `z.string().nanoid()` → `z.nanoid()`. The old `.string().<format>()` forms are deprecated (console warning) but still functional. Use the top-level forms in all new code. If a project pins Zod v3 in `package-lock.json`, the top-level forms cause compile errors — revert to `z.string().<format>()`.

### Next.js 16: `src/middleware.ts` → `src/proxy.ts`
Next.js 16 deprecated the `middleware.ts` filename in favour of `proxy.ts`. The exported function and `config` are unchanged — only the filename moves. New projects on Next.js 16+ should scaffold `src/proxy.ts` directly. Existing projects on Next.js 16 emit a console warning on every `npm run dev` / `npm run build` until renamed. When migrating, do one `git mv src/middleware.ts src/proxy.ts` — no code changes required. Update `package-lock.json`-pinned projects on Next.js 15 or earlier stay on `middleware.ts`.

### React 19: use `React.SyntheticEvent<HTMLFormElement>` for onSubmit handler types
`React.FormEvent<HTMLFormElement>` is deprecated in React 19 types — it emits a TypeScript deprecation warning during `npm run build`. The correct replacement is `React.SyntheticEvent<HTMLFormElement>`, which covers the same surface and does not trigger the warning. Write the handler signature as `async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) { ... }` (never `React.FormEvent<...>`).

This applies to every form handler in auth pages (signup, login, password reset), settings forms, and any custom form UI.

### When accessibility scanner reports duplicate `<nav>` landmark regions or duplicate brand announcement
See the "Multi-nav layouts" entry under `## Accessibility` above. Two `<nav>` elements on the same page require unique `aria-label` values; a logo image adjacent to visible brand text requires `alt=""` + `aria-hidden` so the brand name is not announced twice.

### When keyboard accessibility scan reports missing skip-navigation link (WCAG 2.4.1)
See the "Root layout — skip-nav link" entry under `## Accessibility` above. The layout must include a visually-hidden `<a href="#main-content">` anchor before the first visible navigation block, and `<main>` must carry `id="main-content"`. Both are required — the anchor alone without the matching id fails.

### `src/app/not-found.tsx` must export a `metadata` object
The 404 page has no `<title>` without an explicit `metadata` export, which fails a11y / SEO audits. Add a static `metadata` export at the top of `src/app/not-found.tsx`:

```tsx
// src/app/not-found.tsx
import Link from "next/link";

export const metadata = { title: "Page Not Found" };

export default function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-muted-foreground">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link href="/" className="underline">Back to home</Link>
    </div>
  );
}
```

`generateMetadata()` is NOT needed — `not-found.tsx` is a static route so the object export is sufficient.

### When a let variable is always overwritten in the try block (no-useless-assignment)
Declare the variable with a type annotation and no initial value: `let x: string;` instead of `let x = "placeholder";`. The `@typescript-eslint/no-useless-assignment` lint rule (from `tseslint.configs.recommended`) fires when the initial value is never read because every branch (try + catch) reassigns the variable before use. An initial value suggests a fallback that isn't actually used.

### When accessibility scanner reports all pages missing `<main>` landmark
Wrap `{children}` in a `<main>` element in `src/app/layout.tsx`. The root layout template emits `{children}` directly inside `<body>`, which causes every page to fail WCAG landmark checks. A `<main>` in the root layout applies the fix to all pages simultaneously.

### When npm install fails with eslint-plugin-react-hooks peer dependency error
`eslint-plugin-react-hooks` does not support eslint v10+. When `npm install` resolves the latest eslint major version and the peer dependency check fails, re-run with a pinned version: `npm install -D eslint@9`. This is a temporary compatibility workaround until `eslint-plugin-react-hooks` supports eslint v10. Other framework stacks (Hono, Commander) do not use `eslint-plugin-react-hooks` and are unaffected.

### When a custom hook returns a useRef and react-hooks/refs lint fires
A custom hook that returns a `useRef` object triggers the `react-hooks/refs` ESLint rule when consumers access properties on the returned ref during render (e.g., `hook().current`). The error is "Cannot access refs during render." Convert `useRef` to a `useState` + callback ref pattern, or restructure so the hook returns derived values instead of the raw ref object. This commonly occurs with scroll-tracking or intersection-observer hooks.

### When `react-hooks/purity` flags `Date.now()` or `Math.random()` in a Server Component helper
The `react-hooks/purity` rule fires on helper functions that use impure expressions (`Date.now()`, `Math.random()`, etc.) when those helpers are defined inside a component-scope file. Server Components render server-side once and are serialized to HTML — they are NOT bound by React's purity rules for hooks. In a Server Component file, calling `Date.now()` in a helper is valid and a false positive. Suppress with an inline comment that both disables the rule and documents the reason:

```tsx
// eslint-disable-next-line react-hooks/purity -- Server Component: purity rule does not apply
const now = Date.now();
```

**Only suppress in files that do NOT contain the `"use client"` directive.** In Client Components the rule IS applicable — `Date.now()` inside a component-scope helper can cause hydration mismatches and should be wrapped in `useEffect` or moved out of render, not suppressed.

### When a page component wraps its content in `<main>` causing `landmark-no-duplicate-main`
When `src/app/layout.tsx` already wraps `{children}` in a `<main>` element (see the paired "missing `<main>` landmark" entry above), individual page components MUST NOT add their own `<main>`. Two `<main>` elements on the same page fail the axe-core `landmark-no-duplicate-main` check (WCAG 4.1.2). Scaffold-generated `page.tsx` templates should use `<div>` as the outermost wrapper — only `layout.tsx` owns the `<main>` landmark.

This pairs with the missing-`<main>` entry to form the full rule: **exactly one `<main>` per rendered page, owned by `layout.tsx`, never duplicated by a page component.**

### When openGraph metadata is missing images array, og:image is absent
When the `openGraph` config object in `layout.tsx` is written without an `images` property, the `og:image` meta tag is entirely absent from the rendered HTML. Social sharing previews and link unfurls show no image. Always include the `images` array in the openGraph config:

```typescript
openGraph: {
  title: "...",
  description: "...",
  images: [{ url: "/images/og-photo.png", width: 1200, height: 640 }],
},
```

### When API route accepts total + line-items breakdown, validate with .refine()
API routes that accept both a `total` field (e.g., `total_cents`) and a breakdown array (e.g., `line_items`) must validate that the sum matches. Without cross-field validation, a client can pass an arbitrary total that does not match the line items. Use Zod's `.refine()` for cross-field validation:

```typescript
const schema = z.object({
  total_cents: z.number().int().positive(),
  line_items: z.array(z.object({ amount_cents: z.number().int() })),
}).refine(
  (data) => data.total_cents === data.line_items.reduce((sum, i) => sum + i.amount_cents, 0),
  { message: "total_cents must equal sum of line_items" }
);
```

### When API routes performing expensive operations lack rate limiting
CLAUDE.md Rule 6 specifies rate limiting for auth and payment routes, but any API route performing expensive operations (AI calls, email sends, database writes from anonymous users, quote generation) is equally vulnerable to abuse. Add rate limiting to all write routes and routes that call external services, not just auth and payment.

### When a project emits schema.org `Offer` objects in JSON-LD structured data
Derive `price` values from the same constant that drives the visible pricing UI (`PLAN_PRICES` when `stack.payment: stripe` is present — see `.claude/stacks/payment/stripe.md`; otherwise whichever pricing source the project uses). **Never** hard-code price strings inside the LD+JSON block. When prices change, stale JSON-LD is invisible to visual QA but crawlers and LLM agents see the contradiction and may surface wrong prices in search results or AI summaries.

For enterprise / custom tiers that have no fixed price, use a `PriceSpecification` object with a `description` field instead of a numeric `price`:

```json
{
  "@type": "Offer",
  "name": "Enterprise",
  "priceCurrency": "USD",
  "priceSpecification": {
    "@type": "PriceSpecification",
    "description": "Custom pricing — contact sales"
  }
}
```

When a unit test / build-time assertion is easy to add, compare `JSON.parse(ldJson).offers[*].price` against `PLAN_PRICES[tier].priceUsd` to catch drift during future refactors. Skip the assertion for single-page MVPs where the Offer list is inline — the static-source derivation is the primary guard.

### When rendering non-text Unicode glyphs (∞, ×, ©, →, etc.) as visible UI values
Screen readers announce the Unicode name verbatim — NVDA/JAWS/VoiceOver say "mathematical infinity sign", "multiplication sign", "right-pointing arrow" — which fails WCAG 1.1.1 non-text content when the glyph carries semantic meaning (e.g., `∞` meaning "unlimited"). Wrap the glyph in `aria-hidden="true"` and add a `<span className="sr-only">` sibling with a descriptive word:

```tsx
<span aria-hidden="true">∞</span>
<span className="sr-only">unlimited</span>
```

The `sr-only` utility (Tailwind v4 ships this by default) clips the text visually but keeps it in the accessibility tree. Do NOT substitute `visibility: hidden` or `display: none` — those remove the text from both visual AND accessibility trees, breaking the screen-reader announcement.

Apply to quota displays (`∞` → "unlimited"), close buttons (`×` → "close dialog"), copyright footers (`©` → "copyright"), and arrow indicators (`→` → "leads to"). For purely decorative arrows between cards where no meaning is carried, `aria-hidden="true"` alone without the sr-only sibling is sufficient.

## PR Instructions
- No additional framework setup needed after merging — `npm install && npm run dev` is sufficient

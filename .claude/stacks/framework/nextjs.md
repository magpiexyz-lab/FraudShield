---
assumes: []
packages:
  runtime: [next, react, react-dom]
  dev: [typescript, "@types/react", "@types/node", eslint, "@eslint/js", typescript-eslint]
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
npm install -D typescript @types/react @types/node eslint @eslint/js typescript-eslint
```

## Project Setup
- `.nvmrc`: containing `20` (used by CI and local version managers)
- `package.json`: `scripts` with `dev`, `build`, `start`, `lint` (`eslint src/`), and (when `stack.database` is present) `prebuild` (auto-migrate, see database stack file); `engines: { "node": ">=20" }`
- `tsconfig.json`: enable `strict: true` and `@/` path alias mapping to `src/`
- `next.config.ts`: minimal, no custom config

### `eslint.config.mjs`
```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: [".next/", "out/", "node_modules/"] }
);
```

## File Structure

**web-app archetype:**
```
src/
  app/              # App Router pages and API routes
    layout.tsx      # Root layout — <html>, <body>, metadata, globals.css import
    page.tsx        # Landing page (/)
    not-found.tsx   # 404 page with link back to /
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
- JSON-LD structured data: include a `<script type="application/ld+json">` tag in layout.tsx body with Schema.org type per archetype: `WebApplication` (web-app), `WebAPI` (service), `SoftwareApplication` (cli)
- `src/app/sitemap.ts`: export a default function returning `MetadataRoute.Sitemap` — URLs derived from golden_path pages
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
- Dynamic route segment params (e.g., `[id]` in `src/app/api/projects/[id]/route.ts`) must be validated before use. Parse `params` with zod: `z.object({ id: z.string().uuid() }).parse(await params)`. Reject non-UUID values with 400 before they reach database queries. This prevents malformed inputs (SQL-injection-style strings, excessively long values) from reaching the database layer.
- Return `{ error: string }` with appropriate HTTP status codes on failure
- Use try/catch, return user-friendly error messages

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

## retain_return Tracking

When `stack.analytics` is absent: skip this entire section — the RetainTracker component exists solely to fire analytics events.

Create a client component for retain_return tracking and render it in the root layout. This keeps the root layout as a server component (required for `metadata` export) while running client-side localStorage logic in a separate component.

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

In the root layout (a server component — do NOT add "use client" to layout.tsx):
```tsx
import { RetainTracker } from "@/components/RetainTracker";
// When stack.auth is present:
import { NavBar } from "@/components/nav-bar";

// Inside the <body> tag:
<NavBar />    {/* Only when stack.auth is present */}
<RetainTracker />
```

## Security
- All `"use client"` components run in the browser — never import server-only secrets or database admin clients in client components
- API route handlers (`src/app/api/`) run server-side — use them for all mutations and sensitive operations
- Validate all API route inputs with zod before processing
- Return generic error messages to the client — do not leak stack traces or internal details

## Known Issues

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

### Place rate limiting after auth and API key checks in AI routes
In API routes that call external AI services (Anthropic, OpenAI, etc.), run authentication and API key validation *before* `rateLimit()`. If rate limiting runs first:
1. An unconfigured deployment (missing API key) returns 429 instead of the correct 503, hiding the real problem
2. Unauthenticated requests consume rate-limit budget, returning 429 instead of 401 and masking the auth failure

Correct order: `verifyAuth()` → `checkApiKey()` → `rateLimit()` → business logic.

### When a let variable is always overwritten in the try block (no-useless-assignment)
Declare the variable with a type annotation and no initial value: `let x: string;` instead of `let x = "placeholder";`. The `@typescript-eslint/no-useless-assignment` lint rule (from `tseslint.configs.recommended`) fires when the initial value is never read because every branch (try + catch) reassigns the variable before use. An initial value suggests a fallback that isn't actually used.

## PR Instructions
- No additional framework setup needed after merging — `npm install && npm run dev` is sufficient

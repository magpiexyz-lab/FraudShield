---
assumes: [framework/nextjs]
packages:
  runtime: ["@supabase/supabase-js", "@supabase/ssr"]
  dev: []
files:
  # --- scaffold-wire creates (auth infrastructure, STATE 14) ---
  - src/app/auth/callback/route.ts          # always; scaffold-wire
  - src/app/auth/reset-password/page.tsx     # always; scaffold-wire
  - src/components/nav-bar.tsx               # always; scaffold-wire
  # --- scaffold-pages creates (user-facing pages, STATE 11b) ---
  - src/app/signup/page.tsx                  # only if "signup" in golden_path; scaffold-pages
  - src/app/login/page.tsx                   # only if "login" in golden_path; scaffold-pages
  # --- scaffold-libs creates (library + middleware, STATE 11a) ---
  - src/middleware.ts                        # always; scaffold-libs
  - src/lib/supabase-auth.ts                 # only when stack.database is NOT supabase; scaffold-libs
  - src/lib/supabase-auth-server.ts          # only when stack.database is NOT supabase; scaffold-libs
env:
  server: []
  client: [NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY]
ci_placeholders:
  NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co"
  NEXT_PUBLIC_SUPABASE_ANON_KEY: placeholder-anon-key
clean:
  files: []
  dirs: []
gitignore: []
---
# Auth: Supabase Auth
> Used when experiment.yaml has `stack.auth: supabase`
> Assumes: `framework/nextjs` (server-side auth check uses `NextResponse`)

## Packages
Shares the same packages as `database/supabase` — no additional installs needed when `stack.database` is also `supabase`.

If `stack.database` is NOT supabase, install:
```bash
npm install @supabase/supabase-js @supabase/ssr
```

## Signup/Login UI
- Use Supabase Auth UI or simple email/password forms
- Signup page: email + password fields, submit button
- Login page: email + password fields, submit button, link to signup
- Enforce a minimum password length of 8 characters on the signup form
- Recommend enabling email verification in Supabase Dashboard (Authentication → Settings → Email Auth → "Confirm email")

## Files to Create

### `src/app/auth/callback/route.ts` — Auth callback handler (always created)

Exchanges PKCE authorization codes for sessions. Required for email confirmation auto-login, OAuth/social login, password reset, and magic link flows.

#### When `stack.database` is also `supabase` (shared client):
```ts
import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") return NextResponse.redirect(`${origin}/`);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
```

#### When `stack.database` is NOT supabase (standalone client):
Replace the import on line 2:
```ts
// Instead of: import { createServerSupabaseClient } from "@/lib/supabase-server";
import { createServerAuthClient as createServerSupabaseClient } from "@/lib/supabase-auth-server";
```
This aliasing keeps the rest of the route handler code identical — only the import changes.

### `src/app/auth/reset-password/page.tsx` — Reset password page (always created)

Lets the user set a new password after clicking the reset link from their email. The callback route exchanges the PKCE code and redirects here with an active session.

#### When `stack.database` is also `supabase` (shared client):
```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) { setError(updateError.message); return; }
    router.push("/");
  }

  return (
    <form onSubmit={handleReset} className="space-y-4">
      <div>
        <Label htmlFor="password">New Password</Label>
        <Input id="password" type="password" placeholder="Min 8 characters"
          value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />
      </div>
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <Button type="submit" disabled={loading}>
        {loading ? "Updating..." : "Set new password"}
      </Button>
    </form>
  );
}
```

#### When `stack.database` is NOT supabase (standalone client):
Replace the import on line 5:
```tsx
// Instead of: import { createClient } from "@/lib/supabase";
import { createAuthClient as createClient } from "@/lib/supabase-auth";
```
The rest of the component code remains identical — only the import changes.

### `src/app/signup/page.tsx` — Signup page (if `signup` is in golden_path)

When `stack.analytics` is absent: remove the `@/lib/events` import and all `trackSignupStart()`/`trackSignupComplete()` calls from the template below. The signup flow works without analytics.

#### When `stack.database` is also `supabase` (shared client):
```tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { trackSignupStart, trackSignupComplete } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => { trackSignupStart({ method: "email" }); }, []);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setLoading(false);
    if (authError) { setError(authError.message); return; }
    if (data.user?.identities?.length === 0) {
      setError("An account with this email already exists. Please log in.");
      setLoading(false);
      return;
    }
    if (!data.session) {
      setSuccess("Check your email for a confirmation link to complete signup.");
      return;
    }
    trackSignupComplete({ method: "email" });
    router.push("/"); // Redirect to landing — bootstrap will update to the first non-auth page from experiment.yaml
  }

  return success ? (
    <div className="space-y-4 text-center">
      <p className="text-green-600 font-medium">{success}</p>
      <p className="text-sm text-muted-foreground">
        Already confirmed? <Link href="/login" className="underline">Log in</Link>
      </p>
    </div>
  ) : (
    <form onSubmit={handleSignup} className="space-y-4">
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="you@example.com" value={email}
          onChange={e => setEmail(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" placeholder="Min 8 characters" value={password}
          onChange={e => setPassword(e.target.value)} required minLength={8} />
      </div>
      {error && <p className="text-red-500 text-sm">{error}</p>}
      <Button type="submit" disabled={loading}>
        {loading ? "Creating account..." : "Sign up"}
      </Button>
    </form>
  );
}
```

#### When `stack.database` is NOT supabase (standalone client):
Replace the import on line 4 of the signup page:
```tsx
// Instead of: import { createClient } from "@/lib/supabase";
import { createAuthClient as createClient } from "@/lib/supabase-auth";
```
This aliasing keeps the rest of the component code identical — only the import changes.

- Adapt this pattern for your app — update imports, add fields, and adjust redirects

#### OAuth buttons (conditional: only when `stack.auth_providers` is present)

When generating the signup page and `stack.auth_providers` exists in experiment.yaml,
add these elements below the email/password form:

1. Import the `handleOAuthLogin` function (from the OAuth section below)
2. Add an "Or continue with" separator
3. Add one `<Button variant="outline">` per provider in `auth_providers`

Example (for `auth_providers: [google, github]`):
```tsx
import { Button } from "@/components/ui/button";
{/* Add after the email/password </form> closing tag */}
<div className="relative my-4">
  <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
  <div className="relative flex justify-center text-xs uppercase">
    <span className="bg-background px-2 text-muted-foreground">Or continue with</span>
  </div>
</div>
<div className="flex flex-col gap-2">
  <Button variant="outline" type="button" onClick={() => handleOAuthLogin("google")}>
    Continue with Google
  </Button>
  <Button variant="outline" type="button" onClick={() => handleOAuthLogin("github")}>
    Continue with GitHub
  </Button>
</div>
```

The `handleOAuthLogin` function (in the "OAuth / Social Login" section below) and
`/auth/callback` route (created above) handle the rest — no new routes or packages needed.

When `stack.auth_providers` is absent, do not add OAuth buttons — email/password only.

### `src/app/login/page.tsx` — Login page (if `login` is in golden_path)

Follows the same structure as the signup page above, with these differences:
- Calls `supabase.auth.signInWithPassword()` instead of `signUp()`
- No password minimum-length validation (existing accounts may have any length)
- No analytics events (experiment/EVENTS.yaml defines no login event)

#### When `stack.database` is also `supabase` (shared client):
```tsx
"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirmed = searchParams.get("confirmed") === "true";
  const authError = searchParams.get("error") === "auth";

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (authError) { setError(authError.message); return; }
    router.push("/"); // Redirect to landing — bootstrap will update to the first non-auth page from experiment.yaml
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset-password`,
    });
    setLoading(false);
    if (resetError) { setError(resetError.message); return; }
    setForgotSent(true);
  }

  return (
    <div className="space-y-4">
      {confirmed && (
        <p className="text-green-600 font-medium text-center">
          Email confirmed! Please log in.
        </p>
      )}
      {authError && (
        <p className="text-red-500 font-medium text-center">
          Authentication failed. Please try logging in.
        </p>
      )}
      {forgotMode ? (
        forgotSent ? (
          <div className="space-y-4 text-center">
            <p className="text-green-600 font-medium">Check your email for a reset link.</p>
            <button type="button" className="text-sm underline text-muted-foreground"
              onClick={() => { setForgotMode(false); setForgotSent(false); }}>
              Back to login
            </button>
          </div>
        ) : (
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="you@example.com" value={email}
                onChange={e => setEmail(e.target.value)} required />
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <Button type="submit" disabled={loading}>
              {loading ? "Sending..." : "Send reset link"}
            </Button>
            <button type="button" className="text-sm underline text-muted-foreground block"
              onClick={() => { setForgotMode(false); setError(""); }}>
              Back to login
            </button>
          </form>
        )
      ) : (
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@example.com" value={email}
              onChange={e => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)} required />
          </div>
          <div className="flex justify-end">
            <button type="button" className="text-sm underline text-muted-foreground"
              onClick={() => { setForgotMode(true); setError(""); }}>
              Forgot password?
            </button>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <Button type="submit" disabled={loading}>
            {loading ? "Logging in..." : "Log in"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Don't have an account? <a href="/signup" className="underline">Sign up</a>
          </p>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
```

> **Next.js 16 note:** `useSearchParams()` requires a `<Suspense>` boundary. The default export wraps the inner form component.

#### When `stack.database` is NOT supabase (standalone client):
Replace the import on line 5 of the login page:
```tsx
// Instead of: import { createClient } from "@/lib/supabase";
import { createAuthClient as createClient } from "@/lib/supabase-auth";
```
The rest of the component code (Suspense wrapper, confirmed banner, `createClient()` inside handler) remains identical.

#### OAuth buttons (conditional: only when `stack.auth_providers` is present)

When generating the login page and `stack.auth_providers` exists in experiment.yaml,
add the same OAuth button block used in the signup page (see signup OAuth buttons section above)
below the email/password form. Use the same `handleOAuthLogin` function and separator pattern.
Fire `trackSignupStart({ method: "<provider>" })` before the OAuth redirect — the analytics
event is the same regardless of whether the user is signing up or logging in via OAuth.

### `src/components/nav-bar.tsx` — Auth-aware navigation (always created when `stack.auth: supabase`)

#### When `stack.database` is also `supabase` (shared client):
```tsx
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button, buttonVariants } from "@/components/ui/button";
import type { User } from "@supabase/supabase-js";

export function NavBar() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <nav className="flex items-center justify-between px-6 py-4 border-b">
      <Link href="/" className="text-xl font-bold">
        APP_NAME
      </Link>
      <div className="flex items-center gap-2">
        {/* Bootstrap adds page links here from golden_path */}
        {loading ? (
          <Button variant="outline" disabled className="min-w-[70px]">
            &nbsp;
          </Button>
        ) : user ? (
          <>
            <span className="text-sm text-muted-foreground truncate max-w-[200px]">
              {user.email}
            </span>
            <Button variant="outline" onClick={handleLogout}>
              Log out
            </Button>
          </>
        ) : (
          <Link href="/login" className={buttonVariants({ variant: "outline" })}>
            Log in
          </Link>
        )}
      </div>
    </nav>
  );
}
```

#### When `stack.database` is NOT supabase (standalone client):
Replace the import on line 6:
```tsx
import { createAuthClient as createClient } from "@/lib/supabase-auth";
```

Notes:
- Bootstrap replaces `APP_NAME` with experiment.yaml `name` and adds page-specific navigation links
- `getSession()` on mount sets initial auth state; `onAuthStateChange()` reacts to login/logout
- Loading state prevents flash of "Log in" button before auth state is known
- `router.refresh()` after logout clears server-side cached session data

## Client-Side Auth State
- The `NavBar` component (above) demonstrates the pattern: `getSession()` for initial state + `onAuthStateChange()` for reactive updates
- On login/signup success, redirect to the appropriate page
- Use the same pattern in any component that needs to react to auth changes

## Server-Side Auth Check
In API route handlers, verify the user session before processing the request. The import depends on whether `stack.database` is also `supabase`.

#### When `stack.database` is also `supabase` (shared client):
```ts
import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";

// At the start of your route handler:
const supabase = await createServerSupabaseClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
// Use user.id for database queries and metadata
```

#### When `stack.database` is NOT supabase (standalone client):
```ts
import { NextResponse } from "next/server";
import { createServerAuthClient } from "@/lib/supabase-auth-server";

// At the start of your route handler:
const supabase = await createServerAuthClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
// Use user.id for database queries and metadata
```

## Middleware (Route Protection)

Protect authenticated pages at the routing level so unauthenticated users are redirected before the page renders. Bootstrap creates this file when `stack.auth: supabase` is present.

### `src/middleware.ts` — Route protection middleware (always created)

#### When `stack.database` is also `supabase` (shared client):
```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const publicPaths = ["/", "/login", "/signup", "/auth/callback", "/auth/reset-password", "/api/health"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip public paths, static files, and API routes
  if (
    publicPaths.some((p) => pathname === p) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/v/") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Bypass auth in demo mode (no Supabase credentials available)
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
```

Notes:
- `publicPaths` should be updated by bootstrap to include all non-authenticated pages from golden_path (landing page variants, marketing pages)
- `/v/` variant routes are excluded via `pathname.startsWith("/v/")` — these are A/B test landing pages that must be publicly accessible
- API routes are excluded — they use server-side auth checks in route handlers instead. **Do not add middleware auth for `/api/` routes.** Middleware and API route handlers create separate Supabase clients from the same request cookies. Supabase refresh tokens are single-use: if the access token expires, middleware consumes the refresh token, and the API route handler's subsequent refresh attempt fails silently (returns 401). API routes must handle auth independently via `createServerSupabaseClient()` + `getUser()`.
- The `matcher` config excludes static assets for performance
- Redirects to `/login?next=<path>` so the login page can redirect back after auth
- Uses `getUser()` (not `getSession()`) for security — `getUser()` validates the JWT with the Supabase Auth server

#### When `stack.database` is NOT supabase (standalone client):
Replace the Supabase client creation with:
```ts
import { createServerClient } from "@supabase/ssr";

// Replace the createServerClient block with:
const supabase = createServerClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key",
  { cookies: { /* same cookie handlers as above */ } }
);
```

## Session Token Lifecycle

- **Access token**: Expires after 1 hour (configurable in Supabase Dashboard → Auth → Settings)
- **Refresh token**: Expires after 7 days (configurable)
- **Auto-refresh**: The `supabase-server.ts` client auto-refreshes tokens via cookies on each request. No manual refresh logic needed.
- **Edge case**: If a user is inactive for >7 days, the refresh token expires and they must re-authenticate. The middleware will redirect them to the login page automatically.
- **Monitor**: Watch for `AuthApiError: Invalid Refresh Token` in server logs — a spike indicates users hitting the 7-day expiry window. Consider increasing refresh token lifetime if this is frequent.

## Analytics Integration
- Fire `signup_start` on form render (include `method` property: `"email"`, `"google"`, `"github"`)
- Fire `signup_complete` only when `data.session` exists after `signUp()` — when email confirmation is enabled (the default), `signUp()` returns `session: null` and the user must confirm their email before they're logged in. `signup_complete` should only fire for confirmed, logged-in users.

## OAuth / Social Login

The callback route (`src/app/auth/callback/route.ts`, created above) handles OAuth redirects — no additional route infrastructure is needed to add social login.

### Adding an OAuth provider button

Add this to your signup or login page alongside the existing email/password form:

```ts
async function handleOAuthLogin(provider: "google" | "github") {
  trackSignupStart({ method: provider });
  const supabase = createClient();
  await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
}
```

When the OAuth flow completes, Supabase redirects to `/auth/callback` with an authorization code. The callback route exchanges it for a session and redirects the user into the app.

### Analytics
- Fire `trackSignupStart({ method: "google" })` (or `"github"`) **before** the OAuth call — the redirect leaves the page, so this must fire first
- `signup_complete` fires automatically when the user lands back in the app with an active session (wire this in the destination page or via `onAuthStateChange`)

### Enabling a provider

When `stack.auth_providers` is declared in experiment.yaml:
- `/bootstrap` generates OAuth buttons for each listed provider
- `/deploy` collects credentials and configures providers via Management API

For providers added after initial deploy, update `auth_providers` and re-run `/deploy`.

**Manual alternative:** Supabase Dashboard → Authentication → Providers → enable +
paste Client ID/Secret. Set redirect URI to `https://<ref>.supabase.co/auth/v1/callback`.

### Custom OAuth Security (non-Supabase flows)

Supabase's built-in `signInWithOAuth()` handles CSRF protection via PKCE — no additional state management is needed. However, if the project implements custom OAuth flows outside of Supabase (e.g., GitHub App OAuth for API access, third-party service integrations), the `state` parameter must be HMAC-signed to prevent login CSRF:

1. **Generate state:** `state = nonce + "." + hmac_sha256(nonce + payload, OAUTH_STATE_SECRET)`
2. **Store nonce** in a short-lived httpOnly cookie (TTL: 10 minutes max)
3. **Verify on callback:** extract nonce from cookie, recompute HMAC, compare using `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))` — do NOT use `===` or `!==` string comparison, which is vulnerable to timing side-channel attacks
4. **Reject** if nonce is missing, HMAC mismatches, or TTL expired

Store `OAUTH_STATE_SECRET` in server environment variables (generate with `openssl rand -hex 32`). Without signing, an attacker can craft a callback URL with their own authorization code and trick a victim into linking the attacker's account.

This applies only to custom OAuth implementations — Supabase-managed OAuth (via `signInWithOAuth()` and the auth callback route above) is already protected.

## Shared Client Note
When `stack.auth` matches `stack.database` (both `supabase`), they share the same client files (`supabase.ts` and `supabase-server.ts`). When `stack.database` is absent or a different provider, auth needs its own library file — see "Standalone Client" below.

### Standalone Client (when `stack.database` is not supabase)

If `stack.database` is NOT supabase, the shared client files don't exist. Create auth-specific clients:

#### `src/lib/supabase-auth.ts` — Browser client for auth
```ts
import { createBrowserClient } from "@supabase/ssr";

function createDemoClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chainable = (terminal: unknown): any =>
    new Proxy(() => terminal, {
      get: (_, prop) => {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(terminal);
        if (prop === "single") return () => chainable({ data: null, error: null });
        return chainable(terminal);
      },
      apply: () => chainable(terminal),
    });
  const demoUser = {
    id: "demo-user-id",
    email: "demo@example.com",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: new Date().toISOString(),
  };
  return {
    auth: new Proxy(
      {
        getUser: () =>
          Promise.resolve({ data: { user: demoUser }, error: null }),
        getSession: () =>
          Promise.resolve({
            data: { session: { user: demoUser, access_token: "demo-token", refresh_token: "demo-refresh", expires_at: Date.now() + 3600 } },
            error: null,
          }),
        signUp: () =>
          Promise.resolve({
            data: { user: demoUser, session: { access_token: "demo-token", refresh_token: "demo-refresh" } },
            error: null,
          }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe: () => {} } },
        }),
      },
      {
        get: (target, prop) =>
          prop in target
            ? target[prop as keyof typeof target]
            : () => Promise.resolve({ data: {}, error: null }),
      }
    ),
  } as unknown as ReturnType<typeof createBrowserClient>;
}

export function createAuthClient() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") return createDemoClient();
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key"
  );
}
```

#### `src/lib/supabase-auth-server.ts` — Server client for auth
```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function createDemoClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chainable = (terminal: unknown): any =>
    new Proxy(() => terminal, {
      get: (_, prop) => {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(terminal);
        if (prop === "single") return () => chainable({ data: null, error: null });
        return chainable(terminal);
      },
      apply: () => chainable(terminal),
    });
  const demoUser = {
    id: "demo-user-id",
    email: "demo@example.com",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: new Date().toISOString(),
  };
  return {
    auth: new Proxy(
      {
        getUser: () =>
          Promise.resolve({ data: { user: demoUser }, error: null }),
        getSession: () =>
          Promise.resolve({
            data: { session: { user: demoUser, access_token: "demo-token", refresh_token: "demo-refresh", expires_at: Date.now() + 3600 } },
            error: null,
          }),
        signUp: () =>
          Promise.resolve({
            data: { user: demoUser, session: { access_token: "demo-token", refresh_token: "demo-refresh" } },
            error: null,
          }),
      },
      {
        get: (target, prop) =>
          prop in target
            ? target[prop as keyof typeof target]
            : () => Promise.resolve({ data: {}, error: null }),
      }
    ),
  } as unknown as ReturnType<typeof createServerClient>;
}

export async function createServerAuthClient() {
  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") return createDemoClient();
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key",
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}
```

Update signup/login page imports to use `createAuthClient` from `@/lib/supabase-auth` instead of `@/lib/supabase`.

## Environment Variables
When `stack.database` is also `supabase`, auth shares the database environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`). No additional env vars needed.

When `stack.database` is NOT supabase, add these env vars for auth:
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-publishable-api-key
```

## Production URL Configuration

After deploying to production, the Supabase project's auth settings must include the deployment URL for redirects to work correctly (email confirmations, password resets, OAuth callbacks).

The `/deploy` skill configures this automatically via the Supabase Management API:
```bash
curl -s -X PATCH "https://api.supabase.com/v1/projects/<ref>/config/auth" \
  -H "Authorization: Bearer <supabase-access-token>" \
  -H "Content-Type: application/json" \
  -d '{"site_url": "https://<url>", "uri_allow_list": "https://<url>/**"}'
```

**Manual fallback:** Supabase Dashboard → Authentication → URL Configuration → set Site URL and add Redirect URLs.

> **Note:** The `uri_allow_list` wildcard (`https://<url>/**`) already covers `/auth/callback` — no additional deploy changes are needed when adding OAuth providers.

The `/deploy` skill also configures email subject lines and professional HTML email templates in the same PATCH call, using the app's short title from experiment.yaml (e.g., "Confirm your MyApp account"). Templates include a branded header, responsive layout, and clear CTA button for confirmation, password reset, and magic link emails. When `stack.email: resend`, deploy also configures Supabase to send auth emails through Resend's SMTP (`smtp.resend.com`), so emails come from your domain (e.g., `noreply@draftlabs.org`) instead of Supabase's default sender. To customize further: Supabase Dashboard → Authentication → Email Templates.

The access token is read from `~/.supabase/access-token` (created by `supabase login`). If unavailable, generate one at supabase.com/dashboard/account/tokens.

## OAuth Provider Configuration

When `stack.auth_providers` is declared in experiment.yaml, `/deploy` configures each provider
via the same Management API PATCH call used for redirect URLs and email subjects:

```bash
curl -s -X PATCH "https://api.supabase.com/v1/projects/<ref>/config/auth" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "external_google_enabled": true,
    "external_google_client_id": "<client-id>",
    "external_google_secret": "<client-secret>"
  }'
```

Supported provider slugs (use as `external_<slug>_enabled`): google, github, apple, azure,
bitbucket, discord, facebook, figma, gitlab, kakao, keycloak, linkedin_oidc, notion,
slack_oidc, spotify, twitch, twitter, workos, zoom.

The callback URL for all providers is: `https://<ref>.supabase.co/auth/v1/callback`
(already covered by the `uri_allow_list` wildcard set during deploy).

**Manual fallback:** Supabase Dashboard → Authentication → Providers → enable the provider
→ paste Client ID and Secret from the provider's developer console.

## PR Instructions
- Email confirmation is enabled by default in Supabase. The signup form handles this: when `signUp()` returns `session: null`, it shows a "check your email" message instead of redirecting. Users who confirm their email can then log in normally.
- The signup form passes `emailRedirectTo` pointing to `/auth/callback`, which exchanges the PKCE code for a session and redirects to `/`. This requires the production URL to be in Supabase's redirect allow-list (configured by `/deploy`).
- The signup form detects duplicate emails by checking `data.user.identities` — when Supabase returns a user with zero identities, it means the email already exists. The form shows "An account with this email already exists" instead of the misleading "check your email" message.
- The login page includes a "Forgot password?" link that toggles an inline reset form. It calls `resetPasswordForEmail()` with a redirect to `/auth/callback?next=/auth/reset-password`. After clicking the email link, the callback route exchanges the code and redirects to the reset-password page where the user sets a new password.
- Test the signup flow end-to-end: create an account → see "check your email" message → confirm email → callback route exchanges code → auto-redirected into the app as a logged-in user
- Test duplicate email: sign up with an existing email → see "already exists" error instead of "check your email"
- Test forgot password: click "Forgot password?" on login → enter email → see "check your email for a reset link" → click link → land on reset-password page → set new password → redirected to app
- If the callback fails (expired or invalid code), the user is redirected to `/login?error=auth` and sees an error banner

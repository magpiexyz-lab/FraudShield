import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// publicPaths derived from experiment.yaml via:
// python3 .claude/scripts/lib/derive_pages.py public_paths < experiment/experiment.yaml
// /pricing is public: it is the paywall destination, and gating it behind auth
// bounced signed-out visitors to /login at the exact moment they were deciding
// whether to pay.
// /terms is public: it is linked from the signed-out landing footer, and
// behavior b-11 marks it `anonymous_allowed: true`, so derive_public_paths()
// emits it. Gating it would 404-by-redirect the footer link for anonymous visitors.
const publicPaths = ["/", "/api/health", "/auth/callback", "/auth/reset-password", "/login", "/pricing", "/signup", "/terms"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip public paths, static files, API routes, analytics proxy, and variant routes
  if (
    publicPaths.some((p) => pathname === p) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/ingest/") ||
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
  // Use `||` (falsy check) not `!` (non-null assertion) — non-null assertions
  // pass through empty-string env values ("" is set but empty), causing the SDK
  // to initialize with "" and crash on the first cookie refresh.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
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
    const redirect = NextResponse.redirect(loginUrl);

    // CARRY THE REFRESHED COOKIES ONTO THE REDIRECT. Returning a bare
    // NextResponse.redirect() here threw them away, and that logged people out
    // for good roughly an hour after they signed in.
    //
    // HOW IT PLAYED OUT. Access tokens last about an hour. When someone came
    // back after that, getUser() above spent the refresh token to mint a new
    // pair -- and Supabase ROTATES refresh tokens, so the old one died the
    // moment it was used. setAll() wrote the new pair onto `response`. On the
    // authenticated path `response` is returned and the new cookies stick. On
    // this path they were dropped: old refresh token already spent, new one
    // never saved, session unrecoverable. The user is bounced to /login and
    // signing in again is the only way out.
    //
    // It presents as "I close the tab and have to log in again", which sounds
    // like a cookie-lifetime problem and is not one. The cookies were right;
    // they were written to an object that was discarded.
    //
    // Reported by a signed-in user on 2026-10-17.
    for (const cookie of response.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    return redirect;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};

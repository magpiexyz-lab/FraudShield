"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { createClient } from "@/lib/supabase";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { Session, User } from "@supabase/supabase-js";
import { BrandLogo } from "@/components/brand-logo";

// Routes where the NavBar is intentionally suppressed:
//   - "/" (landing) and "/v/<variant>" — the landing page has its own marketing
//     header; a NavBar on top would be visual noise
//   - /signup, /login, /auth/* — auth pages render their own minimal shell
const SUPPRESSED_PREFIXES = ["/v/", "/auth/"];
const SUPPRESSED_EXACT = new Set(["/", "/signup", "/login"]);

/**
 * The header surface, shared by the signed-in NavBar and the landing header.
 *
 * Defined once here and imported by the landing header so the two cannot drift.
 *
 * OPAQUE on purpose. It was translucent with a backdrop blur, which rendered as
 * two different colours: the landing header sits inside a dark section so it
 * blurred over dark, while this NavBar mounts straight into <body> — which
 * carries the light :root background — so the same class composited 70% dark
 * over white and came out grey. Same code, different result, depending only on
 * what happened to sit behind it.
 *
 * bg-card rather than bg-background: one step lighter than the page beneath it
 * (0.218 vs 0.175 lightness), so the bar reads as its own surface instead of
 * dissolving into the page — and it reads identically on every route.
 *
 * `dark` is deliberate: every route either header renders on is a dark surface,
 * and the global light :root tokens would produce a light nav on a dark page.
 */
export const HEADER_SURFACE =
  "dark sticky top-0 z-40 border-b border-border bg-card text-foreground";

export function NavBar() {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event: string, session: Session | null) => {
        setUser(session?.user ?? null);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  // Suppress on landing + auth surfaces. We compute this AFTER the hooks above
  // so React's hook ordering rules stay intact across renders.
  const suppress =
    SUPPRESSED_EXACT.has(pathname) ||
    SUPPRESSED_PREFIXES.some((p) => pathname.startsWith(p));
  if (suppress) return null;

  // Bootstrap emits these from derive_scope_pages(experiment) — the canonical
  // SET inventory — minus auth/landing routes. Golden_path pages come first in
  // funnel order, then behavior-only pages alphabetically. See wire.md Step 5b.3.
  //
  // Split into gated and public because the derived set describes the SITE MAP,
  // not what THIS visitor may open. /scan-result and /dashboard are absent from
  // publicPaths in src/proxy.ts, so offering them to a signed-out visitor sent
  // them to /login — which the three public /guides/* pages turned from a
  // curiosity into a cost, since those exist to receive strangers from search.
  //
  // KEEP THE href LITERALS. The bg2-wire-nav-reachability gate
  // (.claude/patterns/gate-evidence-rules.json) proves every static scope page
  // is reachable by bare-slug `href=` SUBSTRING matching against this file.
  // Collapsing these into a {href, label} array and mapping over it reads
  // better and deletes the literals, which fails route reachability on the next
  // /change or /bootstrap run. tests/nav-bar.test.ts pins this.
  const gatedNavLinks = (
    <>
      {/* DERIVED-FROM: derive_scope_pages */}
      <Link
        href="/scan-result"
        className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Scan result
      </Link>
      <Link
        href="/dashboard"
        className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Dashboard
      </Link>
    </>
  );

  // /pricing stays visible to everyone: it is a deliberate hand-added entry in
  // proxy.ts publicPaths because it is the paywall destination, and gating it
  // bounced signed-out visitors to /login at the exact moment they were
  // deciding whether to pay.
  const publicNavLinks = (
    <>
      <Link
        href="/pricing"
        className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Pricing
      </Link>
    </>
  );

  // `loading` counts as anonymous, not as signed-in. Rendering the gated links
  // and then retracting them once the session resolves is the defect being
  // fixed; the gated routes are themselves auth-walled, so anyone genuinely on
  // one resolves to signed-in a moment later and the links appear.
  const showGatedLinks = !loading && user !== null;

  const authSection = loading ? (
    <Button variant="outline" disabled className="min-w-[70px]">
      &nbsp;
    </Button>
  ) : user ? (
    <>
      <span className="hidden text-sm text-muted-foreground truncate max-w-[200px] md:inline">
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
  );

  return (
    // Force dark "evidence-lab" tokens — every route the NavBar renders on
    // (dashboard, scan-result, pricing) is a dark product surface; the global
    // light :root tokens would create a light-nav-on-dark-page fracture.
    // Sticky positioning keeps the nav reachable while scrolling long pages
    // (post-launch bug #1). `backdrop-blur` + 85%-alpha bg keeps the surface
    // legible without a hard edge when content scrolls beneath it.
    <nav
      aria-label="Primary"
      className={`${HEADER_SURFACE} flex items-center justify-between px-6 py-4`}
    >
      <BrandLogo wordmark wordmarkSize={20} />
      {/* Desktop nav */}
      <div className="hidden md:flex items-center gap-4">
        {showGatedLinks && gatedNavLinks}
        {publicNavLinks}
        {authSection}
      </div>
      {/* Mobile hamburger menu */}
      <div className="md:hidden">
        <Sheet>
          <SheetTrigger
            aria-label="Open menu"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <Menu className="h-5 w-5" />
          </SheetTrigger>
          <SheetContent side="right" className="w-[280px]">
            <SheetTitle className="sr-only">Site navigation</SheetTitle>
            <div className="flex flex-col gap-4 mt-8">
              {showGatedLinks && gatedNavLinks}
              {publicNavLinks}
              {authSection}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}

"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
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

// Routes where the NavBar is intentionally suppressed:
//   - "/" (landing) and "/v/<variant>" — the landing page has its own marketing
//     header; a NavBar on top would be visual noise
//   - /signup, /login, /auth/* — auth pages render their own minimal shell
const SUPPRESSED_PREFIXES = ["/v/", "/auth/"];
const SUPPRESSED_EXACT = new Set(["/", "/signup", "/login"]);

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
  const navLinks = (
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
      <Link
        href="/pricing"
        className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Pricing
      </Link>
    </>
  );

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
    <nav
      aria-label="Primary"
      className="dark relative z-20 flex items-center justify-between border-b border-border/60 bg-background px-6 py-4 text-foreground"
    >
      <Link href="/" className="flex items-center gap-2">
        {/* Decorative: brand name is announced by the adjacent <span>, so alt="" + aria-hidden prevents double announcement. */}
        {/* unoptimized: next/image rejects SVG by default — see framework/nextjs.md "When loading SVG assets through next/image". */}
        <Image
          src="/images/logo.svg"
          alt=""
          aria-hidden
          width={28}
          height={28}
          unoptimized
        />
        <span className="font-heading text-xl font-bold tracking-tight">FraudShield</span>
      </Link>
      {/* Desktop nav */}
      <div className="hidden md:flex items-center gap-4">
        {navLinks}
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
              {navLinks}
              {authSection}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}

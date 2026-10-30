"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { trackGuideCtaClick } from "@/lib/events";
import type { GuideSlug } from "@/lib/guides-copy";

// The one action in the article: the in-prose link to /signup.
//
// It is a <Link>, not a router.push or a window.location assignment, and the
// event fires in onClick while the navigation is still Next's to make. Manual
// navigation would start tearing the document down before PostHog has flushed
// its queue, and the clicks that matter most — the ones on a slow connection —
// are exactly the ones that would be lost. Same reasoning as handleCtaClick in
// src/components/landing-content.tsx.
//
// Each guide body contains exactly one /signup span, so guide_cta_click per
// slug is a clean rate against guide_view. A second signup link anywhere in a
// guide would make that rate unreadable.
export function GuideCtaLink({
  slug,
  children,
}: {
  slug: GuideSlug;
  children: ReactNode;
}) {
  return (
    <Link
      href="/signup"
      onClick={() => trackGuideCtaClick({ slug })}
      // Carries a shade more weight than a cross-link to another guide: it is
      // the same inline treatment, taking the page's single accent for the
      // text as well as the underline, so it reads as the one thing to do here
      // without becoming a button in the middle of a sentence.
      className="rounded-sm font-medium text-signal underline decoration-signal/60 underline-offset-4 transition-colors hover:decoration-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {children}
    </Link>
  );
}

"use client";

import { Suspense, useEffect } from "react";
import { LandingContent } from "@/components/landing-content";
import type { Variant } from "@/lib/variants";
import { trackVisitLanding } from "@/lib/events";

// Client wrapper for the /v/[variant] route. The server page resolves the
// variant (and 404s on unknown slugs); this component owns the client-side
// analytics tracking and the Suspense boundary required by <LandingContent>,
// which reads useSearchParams() for utm_source. generateStaticParams() lives
// in the server page.tsx because Next.js forbids it in "use client" files.
export function VariantLanding({ variant }: { variant: Variant }) {
  useEffect(() => {
    trackVisitLanding({ variant: variant.slug });
  }, [variant.slug]);

  return (
    <Suspense fallback={null}>
      <LandingContent {...variant} />
    </Suspense>
  );
}

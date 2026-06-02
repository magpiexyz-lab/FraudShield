"use client";

import { Suspense, useEffect } from "react";
import { LandingContent } from "@/components/landing-content";
import { getVariant, DEFAULT_VARIANT } from "@/lib/variants";
import { trackVisitLanding } from "@/lib/events";

export default function Home() {
  // No-arg getVariant() always resolves to the default variant; fall back to
  // DEFAULT_VARIANT so the spread is statically typed as a defined Variant.
  const variant = getVariant() ?? DEFAULT_VARIANT;

  useEffect(() => {
    trackVisitLanding({ variant: variant.slug });
  }, [variant.slug]);

  return (
    <Suspense fallback={null}>
      <LandingContent {...variant} />
    </Suspense>
  );
}

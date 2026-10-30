"use client";

import { useEffect, useRef } from "react";
import { trackGuideView } from "@/lib/events";
import type { GuideSlug } from "@/lib/guides-copy";

// b-12 — the reach half of the guide funnel.
//
// Renders nothing. It exists only so the three guide pages can stay server
// components: metadata and the FAQPage JSON-LD have to be produced on the
// server, and an onMount event cannot be. Mounting a null island is the
// cheaper half of that trade.
//
// guide_view is the denominator for guide_cta_click, so it fires once per
// mount and never again — the useRef guard is the same one /pricing uses for
// paywall_shown. React mounts effects twice in development Strict Mode, and
// without the guard every local read of a guide is counted twice.
//
// visit_landing is deliberately NOT fired here. h-01 and h-02 measure what
// share of landing visitors reach the demo and the signup, and a reader who
// arrived on a guide from a search result has seen neither surface. Counting
// them would quietly inflate the denominator of both hypotheses.
export function GuideViewTracker({ slug }: { slug: GuideSlug }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    trackGuideView({ slug });
  }, [slug]);

  return null;
}

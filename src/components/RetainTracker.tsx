"use client";

import { useEffect } from "react";
import { trackRetainReturn } from "@/lib/events";

// Fires retain_return on every page load AFTER the user has been gone for
// at least 24h (per experiment/EVENTS.yaml). localStorage carries the last
// visit timestamp across sessions; we update it on every mount.
export function RetainTracker() {
  useEffect(() => {
    try {
      const lastVisit = localStorage.getItem("last_visit_ts");
      if (lastVisit) {
        const days = Math.floor(
          (Date.now() - Number(lastVisit)) / 86_400_000,
        );
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

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { trackFeatureInterestClick } from "@/lib/events";

/**
 * Demand probe for cross-document checks, which the product does NOT have.
 *
 * This exists because the claim did. "Cross-document checks" was advertised in
 * twelve places while the scoring engine only ever received one document, and
 * removing it left a real question behind: does anyone actually want it? Monday
 * decides whether it gets built, from this number and how paying users behave --
 * not from anyone's instinct.
 *
 * THE LABEL IS THE WHOLE POINT. It has to read as a question, not a feature.
 * "Coming soon" is a promise and is deliberately not used here: nothing has been
 * committed to, and this product has just finished deleting a dozen sentences
 * that implied capability it did not have. The copy says plainly that we do not
 * do this today, and the button asks rather than announces.
 *
 * After the click it says the interest was recorded -- which is true and is all
 * that happened. No email capture, no waitlist, no date.
 */
export function CrossDocumentInterest({ docType }: { docType: string }) {
  const [asked, setAsked] = useState(false);

  function onAsk() {
    if (asked) return;
    setAsked(true);
    trackFeatureInterestClick({ feature: "cross_document", doc_type: docType });
  }

  return (
    <div className="mt-6 rounded-lg border border-dashed border-border bg-card/40 p-4">
      <p className="text-sm font-medium text-foreground">
        Not checked: consistency across documents
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        FraudShield scores one document at a time. It does not compare the name,
        address or employer on this document against another one in the same
        application. We are deciding whether to build it.
      </p>

      {asked ? (
        <p
          role="status"
          className="mt-3 text-sm font-medium text-[var(--signal)]"
        >
          Noted — thanks. Your interest has been recorded.
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={onAsk}
          className="mt-3 h-10 rounded-full px-5"
        >
          I&rsquo;d want this
        </Button>
      )}
    </div>
  );
}

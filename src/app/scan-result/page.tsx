import { Suspense } from "react";
import { ScanResultClient } from "./scan-result-client";

export const metadata = {
  title: "Scan result | FraudShield",
  description:
    "Your forensic fraud score with a full per-signal breakdown — metadata forensics, cross-document checks, and template matching.",
};

// ScanResultClient calls useSearchParams() to read ?id=<scanId>, so it must be
// wrapped in a Suspense boundary (Next.js requirement).
export default function ScanResultPage() {
  return (
    <Suspense fallback={null}>
      <ScanResultClient />
    </Suspense>
  );
}

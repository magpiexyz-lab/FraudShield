import type { Metadata } from "next";
import { GUIDES } from "@/lib/guides-copy";
import { GuideArticle } from "../guide-article";

// b-12 — the bank-statement guide. Reached from the pay-stub guide and from
// search; its metadata and canonical are its own entry's, never the
// homepage's. See ../guide-article.tsx for the renderer.
const guide = GUIDES.filter((g) => g.slug === "fake-bank-statement")[0];

export const metadata: Metadata = {
  title: guide.title,
  description: guide.description,
  alternates: { canonical: guide.canonical },
  openGraph: {
    title: guide.title,
    description: guide.description,
    type: "website",
    url: guide.canonical,
  },
};

export default function FakeBankStatementGuidePage() {
  return <GuideArticle guide={guide} />;
}

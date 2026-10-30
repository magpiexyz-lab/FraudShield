import type { Metadata } from "next";
import { GUIDES } from "@/lib/guides-copy";
import { GuideArticle } from "../guide-article";

// b-12 — the metadata guide, the broadest of the three: it covers any PDF, and
// the other two link into it for the file-level checks. See
// ../guide-article.tsx for the renderer.
const guide = GUIDES.filter((g) => g.slug === "edited-pdf")[0];

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

export default function EditedPdfGuidePage() {
  return <GuideArticle guide={guide} />;
}

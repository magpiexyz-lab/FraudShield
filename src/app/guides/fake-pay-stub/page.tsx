import type { Metadata } from "next";
import { GUIDES } from "@/lib/guides-copy";
import { GuideArticle } from "../guide-article";

// b-12 — the head-term guide. Everything on the page, including its title,
// description and canonical, comes from this entry; the route's only job is to
// pick the right one. See ../guide-article.tsx for why these are three static
// segments and not one [slug] route.
//
// filter(...)[0] rather than find(...)!: it returns the entry with its slug
// still a literal and no non-null assertion, so the renderer's typed prop
// catches a mismatched slug at compile time.
const guide = GUIDES.filter((g) => g.slug === "fake-pay-stub")[0];

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

export default function FakePayStubGuidePage() {
  return <GuideArticle guide={guide} />;
}

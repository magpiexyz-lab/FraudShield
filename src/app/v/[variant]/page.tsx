import { notFound } from "next/navigation";
import { VARIANTS, getVariant } from "@/lib/variants";
import { VariantLanding } from "./variant-landing";

// Pre-render a static route for every declared variant slug.
export function generateStaticParams() {
  return VARIANTS.map((v) => ({ variant: v.slug }));
}

export default async function VariantPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant: slug } = await params;
  const variant = getVariant(slug);

  // Unknown slug → 404 (also blocks any non-declared param requested at runtime).
  if (!variant) {
    notFound();
  }

  return <VariantLanding variant={variant} />;
}

import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found | FraudShield",
  description: "The page you are looking for does not exist.",
};

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-sm tracking-widest text-muted-foreground">
        404
      </p>
      <h1 className="font-heading text-3xl font-bold tracking-tight">
        This page could not be found
      </h1>
      <p className="max-w-md text-muted-foreground">
        The link may be broken or the page may have moved. Let&apos;s get you
        back to scanning documents.
      </p>
      <Link href="/" className={buttonVariants({ variant: "default" })}>
        Back to Home
      </Link>
    </div>
  );
}

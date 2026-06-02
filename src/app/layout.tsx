import type { Metadata } from "next";
import Script from "next/script";
import { Archivo, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";
import { RetainTracker } from "@/components/RetainTracker";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-heading",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Stop Approving Fake Pay Stubs | FraudShield",
  description:
    "Catch forged pay stubs, bank statements, and invoices in seconds with a forensic fraud score — affordable, self-serve detection built for small operators.",
  openGraph: {
    title: "Stop Approving Fake Pay Stubs | FraudShield",
    description:
      "Catch forged pay stubs, bank statements, and invoices in seconds with a forensic fraud score — affordable, self-serve detection built for small operators.",
    type: "website",
    url: "/",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "FraudShield",
  description:
    "Catch forged pay stubs, bank statements, and invoices in seconds with a forensic fraud score — affordable, self-serve detection built for small operators.",
  url: "/",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "49",
    priceCurrency: "USD",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <body className="min-h-screen antialiased">
        {/* Paid-attribution capture — runs BEFORE React hydration so ?gclid= and
            ?utm_* are captured into sessionStorage even if Next.js router strips
            them via replaceState during client navigation. The PostHog `loaded`
            callback in src/lib/analytics.ts reads these and registers them as
            super-properties. See .claude/stacks/framework/nextjs.md
            "Paid-attribution capture". `strategy="beforeInteractive"` hoists this
            script into <head> automatically — JSX placement here is for readability. */}
        <Script id="capture-paid-attribution" strategy="beforeInteractive">
          {`
            try {
              var p = new URLSearchParams(window.location.search);
              var g = p.get('gclid');
              if (g && g.length > 40 && /^(Cj|EAI|CIa)/.test(g)) {
                sessionStorage.setItem('__ph_gclid', g);
              }
              ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(function(k){
                var v = p.get(k);
                if (v) sessionStorage.setItem('__ph_' + k, v);
              });
            } catch (e) {
              // sessionStorage unavailable (private mode, sandboxed iframe); skip
            }
          `}
        </Script>
        <Script
          id="ld-json-webapplication"
          type="application/ld+json"
          strategy="beforeInteractive"
        >
          {JSON.stringify(jsonLd)}
        </Script>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-foreground"
        >
          Skip to main content
        </a>
        <NavBar />
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
        <RetainTracker />
      </body>
    </html>
  );
}

/**
 * Single source of truth for the FraudShield brand mark.
 *
 * Renders the shield-with-scan-lines silhouette in cyan-on-ink — used by the
 * global NavBar, landing header/footer, and auth shell. Replaces the divergent
 * implementations (/images/logo.svg, an inline FraudShieldMark in landing,
 * and a shield-with-plus glyph in auth-shell) so the brand reads identically
 * on every surface (see post-launch bug #2).
 *
 * Two layout variants:
 *   <BrandLogo />              → 28×28 shield only (default — same as NavBar)
 *   <BrandLogo wordmark />     → shield + "FraudShield" wordmark inline
 */

import Link from "next/link";

type BrandLogoProps = {
  /** Render the wordmark alongside the shield. */
  wordmark?: boolean;
  /** Wrap in a <Link href="/">. Default true; pass false to embed inside an existing link. */
  link?: boolean;
  /** Extra classes applied to the outer wrapper. */
  className?: string;
  /** Shield size in px (default 28). The wordmark scales independently. */
  size?: number;
  /** Wordmark font-size in px. Default 18. */
  wordmarkSize?: number;
};

export function BrandLogo({
  wordmark = false,
  link = true,
  className = "",
  size = 28,
  wordmarkSize = 18,
}: BrandLogoProps) {
  const content = (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <BrandMark size={size} />
      {wordmark && (
        <span
          className="font-heading font-bold tracking-tight text-foreground"
          style={{ fontSize: `${wordmarkSize}px`, lineHeight: 1 }}
        >
          FraudShield
        </span>
      )}
    </span>
  );

  if (!link) return content;
  return (
    <Link href="/" className="inline-flex items-center" aria-label="FraudShield home">
      {content}
    </Link>
  );
}

/**
 * The bare SVG mark — exported separately for cases that need the glyph
 * without a wrapper (e.g. inside an existing Link/icon-only contexts).
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M16 2.5 4.5 7v8.2C4.5 22.4 9.4 28 16 30c6.6-2 11.5-7.6 11.5-14.8V7L16 2.5Z"
        fill="oklch(0.218 0.024 252)"
        stroke="oklch(0.74 0.130 213)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 16.5h14M9 13h14M9 20h9"
        stroke="oklch(0.74 0.130 213)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

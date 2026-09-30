// SHA-256 of a normalised email, for matching a sale back to an ad click when
// the click id did not survive the journey.
//
// WHY A HASH AND NOT THE EMAIL. The subscriptions row already carries `gclid`,
// which is the precise link between a sale and the ad that bought it. It is
// also fragile: an ad blocker, a stripped query string, a copy-pasted URL or a
// purchase made days later in a different browser all lose it. The email is the
// one identifier the customer supplies on both sides, so its hash is the
// fallback join key -- and a hash rather than the address itself because a
// conversion upload does not need to carry a readable customer list.
//
// NORMALISATION. Trim, then lower-case. That is exactly what was asked for, and
// it matters: the same address typed as " Bhavin@Example.com " and
// "bhavin@example.com" must produce one hash or the join silently misses.
//
// NOT DONE HERE, deliberately: Google's enhanced-conversions spec additionally
// strips dots and +suffixes from gmail.com / googlemail.com addresses before
// hashing. That is a Google-side matching rule, not a property of the email,
// and applying it would mean this column could no longer be joined against
// anything else. If the Ads upload needs that form, normalise it in the
// uploader where the rule belongs, not in the stored value.

import { createHash } from "node:crypto";

/** Length of a hex-encoded SHA-256 digest. Exported so the schema and the
 *  tests agree on the column's shape without restating the number. */
export const EMAIL_SHA256_HEX_LENGTH = 64;

/**
 * Hex SHA-256 of the trimmed, lower-cased email.
 *
 * Returns `null` rather than a hash of the empty string when there is no usable
 * address. A hash of "" is a real, constant digest
 * (e3b0c442...) which would be written to every row that lacked an email and
 * would then join them all to each other -- a silent, plausible-looking wrong
 * answer, which is worse than an absent one. NULL means "not known", and
 * `where email_sha256 is null` can find them.
 */
export function hashEmailForMatching(email: unknown): string | null {
  if (typeof email !== "string") return null;

  const normalised = email.trim().toLowerCase();
  if (normalised.length === 0) return null;

  // Not a validator. An address Stripe and Supabase both accepted is an address
  // we hash; rejecting anything here would only drop rows the uploader could
  // otherwise have matched. The one case worth refusing is "nothing at all",
  // handled above.
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

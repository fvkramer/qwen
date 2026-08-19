/**
 * Deciding whether an inbound email really came from the subscriber it claims.
 *
 * A `From:` header is trivially forged, and the webhook signature only proves
 * the message reached us through Resend — not who wrote it. Without a check
 * here, anyone who knows a subscriber's address can poison their profile,
 * unsubscribe them, or spend model budget in their name.
 *
 * Two independent signals, either of which is sufficient:
 *
 *  1. The reply threads onto a message we sent *that same subscriber*. Our
 *     Message-IDs are random UUIDs, so quoting one back is evidence the sender
 *     received the email.
 *  2. The receiving MTA authenticated the sender domain (SPF or DKIM pass).
 */

export type InboundTrust = {
  trusted: boolean;
  reason: "thread" | "dkim" | "spf" | "unverified" | "auth_failed";
};

/** Parse an RFC 8601 Authentication-Results header. */
export function checkAuthenticationResults(
  header: string | null,
): "pass" | "fail" | "absent" {
  if (!header) return "absent";
  const value = header.toLowerCase();
  if (/\bdkim\s*=\s*pass\b/.test(value)) return "pass";
  if (/\bspf\s*=\s*pass\b/.test(value)) return "pass";
  if (/\b(dkim|spf|dmarc)\s*=\s*(fail|softfail|permerror|temperror)\b/.test(value)) {
    return "fail";
  }
  return "absent";
}

export function assessInboundTrust({
  threadMatches,
  authenticationResults,
  allowUnverified,
}: {
  threadMatches: boolean;
  authenticationResults: string | null;
  allowUnverified: boolean;
}): InboundTrust {
  if (threadMatches) return { trusted: true, reason: "thread" };

  const auth = checkAuthenticationResults(authenticationResults);
  if (auth === "pass") return { trusted: true, reason: "dkim" };
  if (auth === "fail") return { trusted: false, reason: "auth_failed" };

  // No thread match and no authentication verdict at all. Closed by default;
  // INBOUND_ALLOW_UNVERIFIED exists for providers that strip the header.
  return { trusted: allowUnverified, reason: "unverified" };
}

/**
 * Replies are human email, not documents. Anything past this is either a
 * quoting accident or an attempt to run up a token bill, and truncating costs
 * nothing a coach needs.
 */
export const MAX_REPLY_CHARS = 4000;

export function truncateReply(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= MAX_REPLY_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_REPLY_CHARS), truncated: true };
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Constant-time comparison that tolerates unequal lengths by comparing
 * digests rather than the raw strings.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Check a `Bearer <secret>` header against an env var.
 *
 * Returns false when the expected secret is missing or empty: otherwise an
 * unset CRON_SECRET turns the comparison into `"Bearer undefined"`, which any
 * caller can send. An endpoint with no secret configured is closed, not open.
 */
export function bearerAuthorized(
  header: string | null,
  expected: string | undefined,
): boolean {
  if (!expected) return false;
  if (!header?.startsWith("Bearer ")) return false;
  return secretsMatch(header.slice("Bearer ".length), expected);
}

/**
 * The caller's IP, for rate limiting.
 *
 * Forwarding headers are only meaningful when something we control sets them.
 * `x-forwarded-for` is client-settable, so if the app is reachable directly,
 * an attacker rotating that header mints an unlimited number of rate-limit
 * buckets and the limit stops existing. We therefore trust these headers only
 * when we know a proxy is in front (Vercel sets VERCEL=1; set
 * TRUST_PROXY_HEADERS=1 behind your own nginx/Cloudflare), and otherwise put
 * every caller in one shared bucket — a blunt limit, but a real one.
 *
 * When trusted: prefer `x-real-ip`, which the platform sets on its own, and
 * otherwise take the last `x-forwarded-for` hop, the one our edge appended.
 */
export function clientIp(headers: Headers): string {
  const behindTrustedProxy =
    process.env.VERCEL === "1" || process.env.TRUST_PROXY_HEADERS === "1";
  if (!behindTrustedProxy) return "unproxied";

  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return "unknown";
}

export type RateLimitResult = { allowed: boolean; count: number; limit: number };

/**
 * Fixed-window rate limit. The increment is one atomic upsert, so concurrent
 * requests cannot both observe the same pre-limit count and both proceed.
 *
 * Fails **closed** on a database error: if we cannot count, we do not spend
 * money on an email or a model call.
 */
export async function consumeRateLimit(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const db = getDb();
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  try {
    const [row] = await db
      .insert(schema.rateLimits)
      .values({ bucket, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [schema.rateLimits.bucket, schema.rateLimits.windowStart],
        set: { count: sql`${schema.rateLimits.count} + 1` },
      })
      .returning({ count: schema.rateLimits.count });
    const count = row?.count ?? limit + 1;
    return { allowed: count <= limit, count, limit };
  } catch {
    return { allowed: false, count: limit + 1, limit };
  }
}

/** Best-effort cleanup of expired windows; safe to call opportunistically. */
export async function pruneRateLimits(olderThanMs = 24 * 60 * 60 * 1000) {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMs);
  await db
    .delete(schema.rateLimits)
    .where(sql`${schema.rateLimits.windowStart} < ${cutoff}`);
}

/**
 * Strip anything that could break out of a header value. The subject line is
 * model-generated, so a CR/LF in it must never reach an SMTP header.
 */
export function sanitizeHeaderValue(value: string, maxLength = 200): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Single-tenant admin auth (§2): one password, a signed session cookie, no
// user table. The signing key is the password itself, so rotating the
// password invalidates every outstanding session.

const COOKIE = "qwen_admin";
const SESSION_MS = 12 * 60 * 60 * 1000;

function secret(): string {
  const value = process.env.ADMIN_PASSWORD;
  if (!value) throw new Error("ADMIN_PASSWORD is not set");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Constant-time compare that tolerates unequal lengths. */
function sameSecret(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function passwordMatches(input: string): boolean {
  return sameSecret(input, secret());
}

export async function startSession(): Promise<void> {
  const expiresAt = String(Date.now() + SESSION_MS);
  const jar = await cookies();
  jar.set(COOKIE, `${expiresAt}.${sign(expiresAt)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return false;
  const [expiresAt, signature] = value.split(".");
  if (!expiresAt || !signature) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) {
    return false;
  }
  return sameSecret(signature, sign(expiresAt));
}

/**
 * Guard for every admin page and every admin server action. The protected
 * layout calls it, and each action calls it again — an action is a public
 * endpoint, so it can never rely on the layout having run.
 */
export async function requireAdmin(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/admin/login");
}

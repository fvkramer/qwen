"use server";

import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { sendEmail } from "@/lib/email/send";
import { confirmTemplate } from "@/lib/email/templates/confirm";

const RATE_LIMIT_PER_HOUR = 5;
const MIN_TIME_ON_PAGE_MS = 3000;

export async function subscribe(formData: FormData): Promise<void> {
  const form = formData.get("form") === "poster" ? "poster" : "hero";
  const success = `/?ok=1&f=${form}#${form}`;
  const failure = (code: string) => `/?err=${code}&f=${form}#${form}`;

  // Bot checks: filled honeypot or an instant submit gets a fake success —
  // never an error a bot could learn from.
  if (formData.get("website")) redirect(success);
  const renderedAt = Number(formData.get("t"));
  if (Number.isFinite(renderedAt) && Date.now() - renderedAt < MIN_TIME_ON_PAGE_MS) {
    redirect(success);
  }

  const parsed = z
    .email()
    .safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  if (!parsed.success) redirect(failure("email"));
  const email = parsed.data;

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const db = getDb();

  // Rate limit per IP using the signup events of the last hour. Over the
  // limit we return the normal success state: no oracle either way.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.type, "signup"),
        gt(schema.events.createdAt, oneHourAgo),
        sql`${schema.events.payload}->>'ip' = ${ip}`,
      ),
    );
  if (count >= RATE_LIMIT_PER_HOUR) redirect(success);

  const existing = await db.query.subscribers.findFirst({
    where: eq(schema.subscribers.email, email),
  });

  // Already active or already awaiting confirmation: success, no second
  // email, no leak of subscription state.
  if (
    existing &&
    (existing.status === "active" || existing.status === "pending_confirm")
  ) {
    await db.insert(schema.events).values({
      subscriberId: existing.id,
      type: "signup",
      payload: { ip, form, duplicate: true },
    });
    redirect(success);
  }

  const confirmToken = randomBytes(24).toString("base64url");

  const [subscriber] = existing
    ? await db
        .update(schema.subscribers)
        .set({ status: "pending_confirm", confirmToken, updatedAt: new Date() })
        .where(eq(schema.subscribers.id, existing.id))
        .returning()
    : await db
        .insert(schema.subscribers)
        .values({ email, confirmToken })
        .onConflictDoUpdate({
          target: schema.subscribers.email,
          set: { status: "pending_confirm", confirmToken, updatedAt: new Date() },
        })
        .returning();

  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "signup",
    payload: { ip, form },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const template = confirmTemplate(`${appUrl}/confirm/${confirmToken}`);
  try {
    await sendEmail({
      subscriber,
      kind: "confirm",
      subject: template.subject,
      text: template.text,
    });
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "confirm_sent",
      payload: {},
    });
  } catch (err) {
    // The messages row already carries status 'failed' + error; log the
    // event and still show success — the visitor can't fix our outbox.
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "send_failed",
      payload: { kind: "confirm", error: err instanceof Error ? err.message : String(err) },
    });
  }

  redirect(success);
}

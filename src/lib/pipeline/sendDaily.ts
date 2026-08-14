import { and, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Subscriber } from "@/db/schema";
import { generateDailyEmail } from "@/lib/ai/generateDaily";
import { sendEmail } from "@/lib/email/send";
import { EMAIL_FOOTER } from "@/lib/email/templates/footer";
import { localDate } from "@/lib/time";

/**
 * One outbound coaching email per user per local day — never two. This is the
 * idempotency guard shared by the cron and the reply-triggered first email.
 */
export async function hasDailyToday(subscriber: Subscriber): Promise<boolean> {
  const db = getDb();
  const [latest] = await db
    .select({ sentAt: schema.messages.sentAt, createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.subscriberId, subscriber.id),
        eq(schema.messages.kind, "daily"),
        isNotNull(schema.messages.sentAt),
      ),
    )
    .orderBy(desc(schema.messages.sentAt))
    .limit(1);
  if (!latest?.sentAt) return false;
  return (
    localDate(subscriber.timezone, latest.sentAt) ===
    localDate(subscriber.timezone)
  );
}

/**
 * Generate and send today's email for one subscriber: guard, generate,
 * validate, send, increment day_number, mark the replies that informed it as
 * processed, log events. Throws on generation failure (after logging) so the
 * caller can count it — a broken email is never sent.
 */
export async function generateAndSendDaily(
  subscriber: Subscriber,
): Promise<"sent" | "skipped"> {
  const db = getDb();

  if (subscriber.status !== "active") return "skipped";
  if (await hasDailyToday(subscriber)) return "skipped";

  const profile = await db.query.profiles.findFirst({
    where: eq(schema.profiles.subscriberId, subscriber.id),
  });

  const dayNumber = subscriber.dayNumber + 1;
  const startedAt = new Date();

  let generated;
  try {
    generated = await generateDailyEmail(subscriber, profile, dayNumber);
  } catch (err) {
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "generation_failed",
      payload: {
        dayNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "daily_generated",
    payload: { dayNumber, subject: generated.subject },
  });

  await sendEmail({
    subscriber,
    kind: "daily",
    subject: generated.subject,
    text: `${generated.body}\n${EMAIL_FOOTER}`,
    dayNumber,
    model: generated.model,
    promptTokens: generated.promptTokens,
    completionTokens: generated.completionTokens,
  });

  await db
    .update(schema.subscribers)
    .set({ dayNumber, updatedAt: new Date() })
    .where(eq(schema.subscribers.id, subscriber.id));

  // The replies that informed this email are now folded in.
  await db
    .update(schema.replies)
    .set({ processedAt: new Date() })
    .where(
      and(
        eq(schema.replies.subscriberId, subscriber.id),
        isNull(schema.replies.processedAt),
        lte(schema.replies.createdAt, startedAt),
      ),
    );

  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "daily_sent",
    payload: { dayNumber },
  });

  return "sent";
}

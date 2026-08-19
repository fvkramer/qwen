import { and, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Subscriber } from "@/db/schema";
import { generateDailyEmail, type GeneratedDaily } from "@/lib/ai/generateDaily";
import { sendEmail } from "@/lib/email/send";
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

/** Admin has held today's send (§9). Self-expiring: the date simply passes. */
export function isHeldToday(subscriber: Subscriber): boolean {
  return (
    subscriber.holdDate !== null &&
    subscriber.holdDate === localDate(subscriber.timezone)
  );
}

/**
 * Deliver one already-generated daily email: send, increment day_number, mark
 * the replies that informed it as processed, log events. Shared by the cron
 * path and the admin "send this preview" action so both leave identical state.
 *
 * `since` bounds which replies count as folded in — pass the time generation
 * started, so a reply that lands mid-generation is picked up tomorrow instead
 * of being silently marked processed.
 */
async function deliverDaily(
  subscriber: Subscriber,
  generated: GeneratedDaily,
  dayNumber: number,
  since: Date,
): Promise<void> {
  const db = getDb();

  await sendEmail({
    subscriber,
    kind: "daily",
    subject: generated.subject,
    text: generated.body,
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
        lte(schema.replies.createdAt, since),
      ),
    );

  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "daily_sent",
    payload: { dayNumber },
  });
}

/**
 * Send a specific, already-reviewed email body (the admin preview path). Still
 * subject to the one-per-local-day guard — reviewing an email in admin is not
 * a licence to send a second one.
 */
export async function sendReviewedDaily(
  subscriber: Subscriber,
  generated: GeneratedDaily,
): Promise<"sent" | "skipped"> {
  if (await hasDailyToday(subscriber)) return "skipped";
  await deliverDaily(subscriber, generated, subscriber.dayNumber + 1, new Date());
  return "sent";
}

/**
 * Generate and send today's email for one subscriber: guard, generate,
 * validate, send, increment day_number, mark the replies that informed it as
 * processed, log events. Throws on generation failure (after logging) so the
 * caller can count it — a broken email is never sent.
 *
 * `force` bypasses the admin hold (an explicit "send now" click overrides a
 * hold) but never the one-per-day guard.
 */
export async function generateAndSendDaily(
  subscriber: Subscriber,
  { force = false }: { force?: boolean } = {},
): Promise<"sent" | "skipped"> {
  const db = getDb();

  if (subscriber.status !== "active") return "skipped";
  if (!force && isHeldToday(subscriber)) return "skipped";
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

  await deliverDaily(subscriber, generated, dayNumber, startedAt);
  return "sent";
}

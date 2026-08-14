import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { updateProfileFromReply } from "@/lib/ai/updateProfile";
import { sendEmail } from "@/lib/email/send";
import { isBareCommand, stripQuotedReply } from "@/lib/email/replyParser";
import { EMAIL_FOOTER } from "@/lib/email/templates/footer";
import {
  CRISIS_RESPONSE,
  EMERGENCY_RESPONSE,
  screenReply,
} from "@/lib/safety";
import { generateAndSendDaily, hasDailyToday } from "./sendDaily";

export type InboundEmail = {
  fromEmail: string;
  subject: string | null;
  rawText: string;
  inReplyToHeader: string | null;
  raw: unknown;
};

const STOP_WORDS = ["stop", "unsubscribe", "cancel", "quit"];

/**
 * Everything that happens when a subscriber replies (§6):
 * verify → match → strip quotes → stop/pause/resume → safety screen →
 * store → profile agent → (first reply only) the agent writes back same-day.
 */
export async function handleInboundReply(
  inbound: InboundEmail,
): Promise<string> {
  const db = getDb();

  const subscriber = await db.query.subscribers.findFirst({
    where: eq(schema.subscribers.email, inbound.fromEmail.toLowerCase()),
  });
  if (!subscriber) {
    await db.insert(schema.events).values({
      type: "reply_received",
      payload: { unknownSender: inbound.fromEmail },
    });
    return "unknown_sender";
  }

  const body = stripQuotedReply(inbound.rawText);
  if (!body) return "empty";

  // stop / unsubscribe / cancel / quit — halt everything, confirm once.
  if (isBareCommand(body, STOP_WORDS)) {
    if (subscriber.status !== "stopped") {
      await db
        .update(schema.subscribers)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(schema.subscribers.id, subscriber.id));
      await db.insert(schema.events).values({
        subscriberId: subscriber.id,
        type: "stopped",
        payload: {},
      });
      await sendEmail({
        subscriber,
        kind: "system",
        subject: "You're unsubscribed",
        text: `Done — no more emails from Qwen. If you ever want back in, sign up again at any time. Take care of yourself.`,
      });
    }
    return "stopped";
  }

  if (isBareCommand(body, ["pause"])) {
    await db
      .update(schema.subscribers)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(schema.subscribers.id, subscriber.id));
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "paused",
      payload: {},
    });
    return "paused";
  }

  if (isBareCommand(body, ["resume", "start", "restart"])) {
    if (subscriber.status === "paused") {
      await db
        .update(schema.subscribers)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(schema.subscribers.id, subscriber.id));
      await db.insert(schema.events).values({
        subscriberId: subscriber.id,
        type: "resumed",
        payload: {},
      });
    }
    return "resumed";
  }

  // Link the reply to the message it answers via In-Reply-To.
  let inReplyToMessageId: string | null = null;
  if (inbound.inReplyToHeader) {
    const parent = await db.query.messages.findFirst({
      where: eq(schema.messages.messageId, inbound.inReplyToHeader),
    });
    inReplyToMessageId = parent?.id ?? null;
  }

  const [reply] = await db
    .insert(schema.replies)
    .values({
      subscriberId: subscriber.id,
      inReplyToMessageId,
      fromEmail: inbound.fromEmail,
      subject: inbound.subject,
      bodyText: body,
      raw: inbound.raw ?? {},
    })
    .returning();

  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "reply_received",
    payload: { replyId: reply.id },
  });

  // Safety screen (§8): fixed human-written response, flag in admin, and the
  // model never touches it.
  const flag = screenReply(body);
  if (flag) {
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "safety_flagged",
      payload: { replyId: reply.id, flag },
    });
    const template = flag === "crisis" ? CRISIS_RESPONSE : EMERGENCY_RESPONSE;
    await sendEmail({
      subscriber,
      kind: "system",
      subject: template.subject,
      text: `${template.text}\n${EMAIL_FOOTER}`,
    });
    if (flag === "crisis") {
      await db
        .update(schema.subscribers)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(schema.subscribers.id, subscriber.id));
    }
    // Mark processed so the coach agent never generates from this content.
    await db
      .update(schema.replies)
      .set({ processedAt: new Date() })
      .where(eq(schema.replies.id, reply.id));
    return "safety_flagged";
  }

  // Profile/memory agent folds the reply in now, so the morning cron is fast.
  const profile = await db.query.profiles.findFirst({
    where: eq(schema.profiles.subscriberId, subscriber.id),
  });
  try {
    await updateProfileFromReply(subscriber, profile, reply);
  } catch (err) {
    // Reply is stored either way; an unprocessed reply is picked up by the
    // next daily generation. Log and continue.
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "generation_failed",
      payload: {
        stage: "profile_update",
        replyId: reply.id,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // First substantive reply (usually to the intake email): the agent analyzes
  // and writes back the first plan same-day. Later replies roll into the next
  // morning — the one-a-day guard makes this safe to attempt.
  if (
    subscriber.status === "active" &&
    subscriber.dayNumber === 0 &&
    !(await hasDailyToday(subscriber))
  ) {
    const fresh = await db.query.subscribers.findFirst({
      where: eq(schema.subscribers.id, subscriber.id),
    });
    if (fresh) {
      try {
        await generateAndSendDaily(fresh);
        return "first_daily_sent";
      } catch {
        // Already logged as generation_failed inside generateAndSendDaily.
        return "first_daily_failed";
      }
    }
  }

  return "processed";
}

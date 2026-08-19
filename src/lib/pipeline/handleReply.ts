import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { updateProfileFromReply } from "@/lib/ai/updateProfile";
import { sendEmail } from "@/lib/email/send";
import {
  assessInboundTrust,
  truncateReply,
} from "@/lib/email/inboundTrust";
import { isBareCommand, stripQuotedReply } from "@/lib/email/replyParser";
import {
  CRISIS_RESPONSE,
  EMERGENCY_RESPONSE,
  screenReply,
} from "@/lib/safety";
import { consumeRateLimit } from "@/lib/security";
import { generateAndSendDaily, hasDailyToday } from "./sendDaily";

export type InboundEmail = {
  fromEmail: string;
  subject: string | null;
  rawText: string;
  inReplyToHeader: string | null;
  authenticationResults: string | null;
  raw: unknown;
};

// Model work per subscriber per hour. A genuine person does not reply twenty
// times in an hour; a script trying to run up the bill does.
const REPLIES_PER_HOUR = 20;

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

  const stripped = stripQuotedReply(inbound.rawText);
  if (!stripped) return "empty";
  const { text: body, truncated } = truncateReply(stripped);

  // Match In-Reply-To against our own Message-IDs before trusting anything:
  // this both links the reply to what it answers and proves the sender saw it.
  let inReplyToMessageId: string | null = null;
  let threadMatches = false;
  if (inbound.inReplyToHeader) {
    const parent = await db.query.messages.findFirst({
      where: eq(schema.messages.messageId, inbound.inReplyToHeader),
    });
    if (parent && parent.subscriberId === subscriber.id) {
      inReplyToMessageId = parent.id;
      threadMatches = true;
    }
  }

  const trust = assessInboundTrust({
    threadMatches,
    authenticationResults: inbound.authenticationResults,
    allowUnverified: process.env.INBOUND_ALLOW_UNVERIFIED === "1",
  });
  if (!trust.trusted) {
    // Never act on an unauthenticated message — not even "stop", which would
    // otherwise let anyone unsubscribe a stranger by forging one header.
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "reply_rejected",
      payload: { reason: trust.reason, fromEmail: inbound.fromEmail },
    });
    return "unverified_sender";
  }

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
    payload: { replyId: reply.id, trust: trust.reason, truncated },
  });

  // Everything below this line costs money. The reply is already stored, so a
  // throttled subscriber loses nothing but the immediate turnaround.
  const budget = await consumeRateLimit(
    `reply:${subscriber.id}`,
    REPLIES_PER_HOUR,
    60 * 60 * 1000,
  );
  if (!budget.allowed) {
    await db.insert(schema.events).values({
      subscriberId: subscriber.id,
      type: "rate_limited",
      payload: { scope: "reply", replyId: reply.id, count: budget.count },
    });
    return "rate_limited";
  }

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
      text: template.text,
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

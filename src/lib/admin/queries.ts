import { and, count, desc, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Message, Profile, Reply, Subscriber } from "@/db/schema";

export type SubscriberRow = Subscriber & {
  lastSentAt: Date | null;
  lastReplyAt: Date | null;
  replyCount: number;
};

/** Subscribers table (§9), optionally filtered by status. */
export async function listSubscribers(
  status?: Subscriber["status"],
): Promise<SubscriberRow[]> {
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.subscribers)
    .where(status ? eq(schema.subscribers.status, status) : undefined)
    .orderBy(desc(schema.subscribers.createdAt))
    .limit(500);

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const sends = await db
    .select({
      subscriberId: schema.messages.subscriberId,
      lastSentAt: max(schema.messages.sentAt),
    })
    .from(schema.messages)
    .where(inArray(schema.messages.subscriberId, ids))
    .groupBy(schema.messages.subscriberId);

  const replies = await db
    .select({
      subscriberId: schema.replies.subscriberId,
      lastReplyAt: max(schema.replies.createdAt),
      replyCount: count(),
    })
    .from(schema.replies)
    .where(inArray(schema.replies.subscriberId, ids))
    .groupBy(schema.replies.subscriberId);

  const sendBy = new Map(sends.map((s) => [s.subscriberId, s.lastSentAt]));
  const replyBy = new Map(replies.map((r) => [r.subscriberId, r]));

  return rows.map((row) => ({
    ...row,
    lastSentAt: sendBy.get(row.id) ?? null,
    lastReplyAt: replyBy.get(row.id)?.lastReplyAt ?? null,
    replyCount: replyBy.get(row.id)?.replyCount ?? 0,
  }));
}

export type TimelineEntry =
  | { at: Date; type: "message"; message: Message }
  | { at: Date; type: "reply"; reply: Reply };

export type Preview = {
  at: Date;
  dayNumber: number | null;
  subject: string;
  body: string;
};

export type SubscriberDetail = {
  subscriber: Subscriber;
  profile: Profile | undefined;
  timeline: TimelineEntry[];
  preview: Preview | null;
  safetyFlags: Array<{ at: Date; flag: string }>;
};

/** Subscriber detail (§9): profile, interleaved timeline, pending preview. */
export async function getSubscriberDetail(
  id: string,
): Promise<SubscriberDetail | null> {
  const db = getDb();

  const subscriber = await db.query.subscribers.findFirst({
    where: eq(schema.subscribers.id, id),
  });
  if (!subscriber) return null;

  const [profile, messages, replies, previewEvents, flagEvents] =
    await Promise.all([
      db.query.profiles.findFirst({
        where: eq(schema.profiles.subscriberId, id),
      }),
      db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.subscriberId, id))
        .orderBy(desc(schema.messages.createdAt))
        .limit(200),
      db
        .select()
        .from(schema.replies)
        .where(eq(schema.replies.subscriberId, id))
        .orderBy(desc(schema.replies.createdAt))
        .limit(200),
      db
        .select()
        .from(schema.events)
        .where(
          and(
            eq(schema.events.subscriberId, id),
            eq(schema.events.type, "daily_generated"),
            sql`${schema.events.payload}->>'preview' = 'true'`,
          ),
        )
        .orderBy(desc(schema.events.createdAt))
        .limit(1),
      db
        .select()
        .from(schema.events)
        .where(
          and(
            eq(schema.events.subscriberId, id),
            eq(schema.events.type, "safety_flagged"),
          ),
        )
        .orderBy(desc(schema.events.createdAt))
        .limit(10),
    ]);

  const timeline: TimelineEntry[] = [
    ...messages.map((message) => ({
      at: message.createdAt,
      type: "message" as const,
      message,
    })),
    ...replies.map((reply) => ({
      at: reply.createdAt,
      type: "reply" as const,
      reply,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const payload = previewEvents[0]?.payload as
    | { subject?: string; body?: string; dayNumber?: number }
    | undefined;

  return {
    subscriber,
    profile,
    timeline,
    preview:
      payload?.subject && payload?.body
        ? {
            at: previewEvents[0].createdAt,
            dayNumber: payload.dayNumber ?? null,
            subject: payload.subject,
            body: payload.body,
          }
        : null,
    safetyFlags: flagEvents.map((e) => ({
      at: e.createdAt,
      flag: String((e.payload as { flag?: string })?.flag ?? "flagged"),
    })),
  };
}

export type SendRow = {
  message: Message;
  email: string;
  subscriberId: string;
};

export type FailureRow = {
  at: Date;
  subscriberId: string | null;
  email: string | null;
  error: string;
  stage: string;
};

/** Sends view (§9): today's cron results, failures first. */
export async function getRecentSends(): Promise<{
  sends: SendRow[];
  failures: FailureRow[];
}> {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const sends = await db
    .select({
      message: schema.messages,
      email: schema.subscribers.email,
      subscriberId: schema.subscribers.id,
    })
    .from(schema.messages)
    .innerJoin(
      schema.subscribers,
      eq(schema.messages.subscriberId, schema.subscribers.id),
    )
    .where(gte(schema.messages.createdAt, since))
    .orderBy(desc(schema.messages.createdAt))
    .limit(200);

  const failureEvents = await db
    .select({ event: schema.events, email: schema.subscribers.email })
    .from(schema.events)
    .leftJoin(
      schema.subscribers,
      eq(schema.events.subscriberId, schema.subscribers.id),
    )
    .where(
      and(
        gte(schema.events.createdAt, since),
        inArray(schema.events.type, ["generation_failed", "send_failed"]),
      ),
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(100);

  // Failed sends sort above delivered ones — the whole point of this view.
  const rank = (m: Message) =>
    m.status === "failed" || m.status === "bounced" || m.status === "complained"
      ? 0
      : 1;

  return {
    sends: sends.sort(
      (a, b) =>
        rank(a.message) - rank(b.message) ||
        b.message.createdAt.getTime() - a.message.createdAt.getTime(),
    ),
    failures: failureEvents.map(({ event, email }) => {
      const payload = (event.payload ?? {}) as {
        error?: string;
        stage?: string;
        kind?: string;
      };
      return {
        at: event.createdAt,
        subscriberId: event.subscriberId,
        email,
        error: payload.error ?? "(no error recorded)",
        stage: payload.stage ?? payload.kind ?? event.type,
      };
    }),
  };
}

export type Overview = {
  signupsPerDay: Array<{ day: string; count: number }>;
  total: number;
  active: number;
  confirmed: number;
  confirmRate: number | null;
  stopped: number;
  bounced: number;
  dailiesSent: number;
  repliesReceived: number;
  replyRate: number | null;
  hardBounces: number;
  complaints: number;
  bounceRate: number | null;
};

/** Overview (§9): simple numbers, no charts. */
export async function getOverview(): Promise<Overview> {
  const db = getDb();
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [signups, byStatus, confirmedRow, statusCounts, dailyRow, replyRow] =
    await Promise.all([
      db
        .select({
          day: sql<string>`to_char(${schema.events.createdAt}, 'YYYY-MM-DD')`,
          count: count(),
        })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.type, "signup"),
            gte(schema.events.createdAt, since),
          ),
        )
        .groupBy(sql`to_char(${schema.events.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${schema.events.createdAt}, 'YYYY-MM-DD') desc`),
      db
        .select({ status: schema.subscribers.status, count: count() })
        .from(schema.subscribers)
        .groupBy(schema.subscribers.status),
      db
        .select({ count: count() })
        .from(schema.subscribers)
        .where(isNotNull(schema.subscribers.confirmedAt)),
      db
        .select({ status: schema.messages.status, count: count() })
        .from(schema.messages)
        .groupBy(schema.messages.status),
      db
        .select({ count: count() })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.kind, "daily"),
            isNotNull(schema.messages.sentAt),
          ),
        ),
      db.select({ count: count() }).from(schema.replies),
    ]);

  const statusOf = (s: string) =>
    byStatus.find((r) => r.status === s)?.count ?? 0;
  const messageStatusOf = (s: string) =>
    statusCounts.find((r) => r.status === s)?.count ?? 0;

  const total = byStatus.reduce((sum, r) => sum + r.count, 0);
  const confirmed = confirmedRow[0]?.count ?? 0;
  const dailiesSent = dailyRow[0]?.count ?? 0;
  const repliesReceived = replyRow[0]?.count ?? 0;
  const hardBounces = messageStatusOf("bounced");
  const complaints = messageStatusOf("complained");
  const totalMessages = statusCounts.reduce((sum, r) => sum + r.count, 0);

  return {
    signupsPerDay: signups,
    total,
    active: statusOf("active"),
    confirmed,
    confirmRate: total ? confirmed / total : null,
    stopped: statusOf("stopped"),
    bounced: statusOf("bounced"),
    dailiesSent,
    repliesReceived,
    replyRate: dailiesSent ? repliesReceived / dailiesSent : null,
    hardBounces,
    complaints,
    bounceRate: totalMessages
      ? (hardBounces + complaints) / totalMessages
      : null,
  };
}

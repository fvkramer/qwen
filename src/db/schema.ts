import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Case-insensitive email column; requires `CREATE EXTENSION citext` (in migration 0000).
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

export const subscriberStatusEnum = pgEnum("subscriber_status", [
  "pending_confirm",
  "active",
  "paused",
  "stopped",
  "bounced",
]);

export const messageKindEnum = pgEnum("message_kind", [
  "intake",
  "daily",
  "confirm",
  "system",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull().unique(),
    status: subscriberStatusEnum("status").notNull().default("pending_confirm"),
    timezone: text("timezone").notNull().default("America/New_York"),
    sendHourLocal: integer("send_hour_local").notNull().default(6),
    sendMinuteLocal: integer("send_minute_local").notNull().default(30),
    confirmToken: text("confirm_token"),
    // Stable per-subscriber secret for the RFC 8058 one-click unsubscribe URL.
    // Unlike confirmToken it is never cleared — the link has to keep working
    // for the life of every email already sitting in their inbox.
    unsubscribeToken: text("unsubscribe_token")
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    dayNumber: integer("day_number").notNull().default(0),
    threadMessageId: text("thread_message_id"),
    // Admin "hold tomorrow's send": the subscriber's local date to skip.
    // Self-expiring — once that date passes, sending resumes on its own.
    holdDate: text("hold_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("subscribers_status_send_hour_idx").on(table.status, table.sendHourLocal)],
);

export type ProfileFacts = {
  injuries?: string[];
  equipment?: string[];
  availability?: string[];
  preferences?: string[];
  other?: string[];
};

export type CurrentPlan = {
  focus?: string;
  progression?: string;
  upcomingDays?: Array<{ day: number; theme: string; notes: string }>;
};

export const profiles = pgTable("profiles", {
  subscriberId: uuid("subscriber_id")
    .primaryKey()
    .references(() => subscribers.id, { onDelete: "cascade" }),
  summary: text("summary").notNull().default(""),
  facts: jsonb("facts").$type<ProfileFacts>().notNull().default({}),
  currentPlan: jsonb("current_plan").$type<CurrentPlan>(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    kind: messageKindEnum("kind").notNull(),
    dayNumber: integer("day_number"),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    providerId: text("provider_id"),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    status: messageStatusEnum("status").notNull().default("queued"),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    error: text("error"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("messages_subscriber_created_idx").on(
      table.subscriberId,
      table.createdAt.desc(),
    ),
    index("messages_message_id_idx").on(table.messageId),
    index("messages_provider_id_idx").on(table.providerId),
  ],
);

export const replies = pgTable(
  "replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    inReplyToMessageId: uuid("in_reply_to_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    fromEmail: text("from_email").notNull(),
    subject: text("subject"),
    bodyText: text("body_text").notNull(),
    raw: jsonb("raw").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("replies_subscriber_created_idx").on(
      table.subscriberId,
      table.createdAt.desc(),
    ),
  ],
);

export type EventType =
  | "signup"
  | "confirm_sent"
  | "confirmed"
  | "daily_generated"
  | "daily_sent"
  | "reply_received"
  | "profile_updated"
  | "paused"
  | "resumed"
  | "stopped"
  | "bounced"
  | "complained"
  | "safety_flagged"
  | "reply_rejected"
  | "rate_limited"
  | "admin_action"
  | "generation_failed"
  | "send_failed";

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id").references(() => subscribers.id, {
      onDelete: "set null",
    }),
    type: text("type").$type<EventType>().notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_created_idx").on(table.createdAt.desc()),
    index("events_type_created_idx").on(table.type, table.createdAt.desc()),
  ],
);

/**
 * Fixed-window counters for abuse control. Keyed by bucket + window so the
 * increment is a single atomic upsert — two concurrent requests cannot both
 * read "4 of 5" and both proceed.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.windowStart] }),
    index("rate_limits_window_idx").on(table.windowStart),
  ],
);

export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Reply = typeof replies.$inferSelect;
export type Event = typeof events.$inferSelect;

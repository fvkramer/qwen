import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../src/db";

async function main() {
  const db = getDb();

  const [ana] = await db
    .insert(schema.subscribers)
    .values({
      email: "ana@example.com",
      status: "active",
      timezone: "America/New_York",
      confirmedAt: new Date(),
      dayNumber: 3,
      threadMessageId: "<seed-thread-ana@qwen.local>",
    })
    .onConflictDoNothing()
    .returning();

  const [ben] = await db
    .insert(schema.subscribers)
    .values({
      email: "ben@example.com",
      status: "pending_confirm",
      timezone: "Europe/London",
      confirmToken: "seed-confirm-token-ben",
    })
    .onConflictDoNothing()
    .returning();

  if (!ana) {
    console.log("Seed data already present, nothing to do.");
    return;
  }

  await db.insert(schema.profiles).values({
    subscriberId: ana.id,
    summary:
      "Ana is starting from zero after a desk-job decade. Goal: have more energy, not weight loss. Left knee gets sore going down stairs. Has 20 minutes most mornings before work; no equipment beyond a yoga mat.",
    facts: {
      injuries: ["left knee soreness on stairs"],
      equipment: ["yoga mat"],
      availability: { weekdays: "20 minutes before work" },
      preferences: { tone: "gentle", focus: "energy" },
    },
    currentPlan: {
      focus: "build a daily movement habit without aggravating the knee",
      progression: "walking + bodyweight basics, add time before intensity",
      upcomingDays: [
        { day: 4, theme: "brisk walk + wall sits", notes: "knee-neutral" },
        { day: 5, theme: "rest + gentle stretching" },
      ],
    },
  });

  await db.insert(schema.messages).values([
    {
      subscriberId: ana.id,
      kind: "confirm",
      subject: "Confirm your email",
      bodyText: "Tap the link to confirm and Qwen will take it from there.",
      status: "delivered",
      messageId: "<seed-confirm-ana@qwen.local>",
      sentAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
    },
    {
      subscriberId: ana.id,
      kind: "intake",
      subject: "Quick hello from Qwen",
      bodyText:
        "Before tomorrow: what are you hoping changes for you, and what does a normal day look like? Plain words are perfect.",
      status: "delivered",
      messageId: "<seed-thread-ana@qwen.local>",
      sentAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000 + 60_000),
    },
    {
      subscriberId: ana.id,
      kind: "daily",
      dayNumber: 3,
      subject: "Day 3: the stairs test",
      bodyText:
        "Yesterday you said the knee felt fine on the flat walk, so today we keep the walk and add one flight of stairs at your own pace. The point is information, not effort: we're finding where the knee complains. How did the stairs feel?",
      status: "delivered",
      messageId: "<seed-daily-3-ana@qwen.local>",
      inReplyTo: "<seed-thread-ana@qwen.local>",
      model: "seed",
      sentAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  ]);

  const [daily3] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.messageId, "<seed-daily-3-ana@qwen.local>"))
    .limit(1);

  await db.insert(schema.replies).values({
    subscriberId: ana.id,
    inReplyToMessageId: daily3?.id,
    fromEmail: "ana@example.com",
    subject: "Re: Day 3: the stairs test",
    bodyText:
      "Stairs were okay going up, a little sore going down. Also I only had 10 minutes today, work was chaos.",
    raw: { seed: true },
    processedAt: null,
  });

  await db.insert(schema.events).values([
    { subscriberId: ana.id, type: "signup", payload: { source: "seed" } },
    { subscriberId: ana.id, type: "confirmed", payload: { source: "seed" } },
    { subscriberId: ana.id, type: "daily_sent", payload: { dayNumber: 3 } },
    { subscriberId: ana.id, type: "reply_received", payload: { seed: true } },
    ...(ben
      ? [
          {
            subscriberId: ben.id,
            type: "signup" as const,
            payload: { source: "seed" },
          },
        ]
      : []),
  ]);

  console.log("Seeded:", {
    ana: ana.email,
    ben: ben?.email ?? "(already existed)",
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

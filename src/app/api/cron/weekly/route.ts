import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { bearerAuthorized } from "@/lib/security";
import { regenerateWeeklyPlan } from "@/lib/ai/weeklyPlan";

export const maxDuration = 600;

const CONCURRENCY = 5;

export async function GET(request: Request) {
  if (
    !bearerAuthorized(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const active = await db
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.status, "active"));

  let planned = 0;
  let failed = 0;

  for (let i = 0; i < active.length; i += CONCURRENCY) {
    const batch = active.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (subscriber) => {
        if (subscriber.dayNumber === 0) return; // nothing to plan from yet
        const profile = await db.query.profiles.findFirst({
          where: eq(schema.profiles.subscriberId, subscriber.id),
        });
        if (!profile) return;
        await regenerateWeeklyPlan(subscriber, profile);
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") planned++;
      else failed++;
    }
  }

  const summary = { subscribers: active.length, planned, failed };
  console.log("[cron/weekly]", JSON.stringify(summary));
  return Response.json(summary);
}

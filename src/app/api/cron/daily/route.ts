import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { generateAndSendDaily } from "@/lib/pipeline/sendDaily";
import { localParts } from "@/lib/time";

export const maxDuration = 600;

const CONCURRENCY = 5;

export async function GET(request: Request) {
  if (
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const active = await db
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.status, "active"));

  // Runs hourly at minute 0: due = everyone whose local hour matches their
  // send hour. The one-daily-per-local-day check inside generateAndSendDaily
  // is the idempotency guard — this cron is safe to run twice.
  const due = active.filter(
    (s) => localParts(s.timezone).hour === s.sendHourLocal,
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((subscriber) => generateAndSendDaily(subscriber)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value === "sent") sent++;
        else skipped++;
      } else {
        failed++;
      }
    }
  }

  const summary = { attempted: due.length, sent, skipped, failed };
  console.log("[cron/daily]", JSON.stringify(summary));
  return Response.json(summary);
}

import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Honour an unsubscribe by token. Idempotent: a provider may POST the
 * one-click URL more than once, and a person may click twice.
 * Returns false only when the token matches nobody.
 */
export async function unsubscribeByToken(token: string): Promise<boolean> {
  const db = getDb();
  const subscriber = await db.query.subscribers.findFirst({
    where: eq(schema.subscribers.unsubscribeToken, token),
  });
  if (!subscriber) return false;
  if (subscriber.status === "stopped") return true;

  await db
    .update(schema.subscribers)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(schema.subscribers.id, subscriber.id));
  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "stopped",
    payload: { via: "one_click" },
  });
  return true;
}

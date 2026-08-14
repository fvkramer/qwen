import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { sendEmail } from "@/lib/email/send";
import { intakeTemplate } from "@/lib/email/templates/intake";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const db = getDb();

  const subscriber = await db.query.subscribers.findFirst({
    where: and(
      eq(schema.subscribers.confirmToken, token),
      eq(schema.subscribers.status, "pending_confirm"),
    ),
  });

  if (!subscriber) {
    // Unknown, reused, or stale token — nothing to confirm.
    redirect("/confirmed?state=invalid");
  }

  const [updated] = await db
    .update(schema.subscribers)
    .set({
      status: "active",
      confirmedAt: new Date(),
      confirmToken: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.subscribers.id, subscriber.id))
    .returning();

  await db.insert(schema.events).values({
    subscriberId: updated.id,
    type: "confirmed",
    payload: {},
  });

  // Fire the intake email immediately; it anchors the one thread every
  // later email lands in. A send failure shouldn't break confirmation.
  try {
    const template = intakeTemplate();
    await sendEmail({
      subscriber: updated,
      kind: "intake",
      subject: template.subject,
      text: template.text,
    });
  } catch (err) {
    await db.insert(schema.events).values({
      subscriberId: updated.id,
      type: "send_failed",
      payload: {
        kind: "intake",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  redirect("/confirmed");
}

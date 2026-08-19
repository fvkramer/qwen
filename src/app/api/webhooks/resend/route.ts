import { eq } from "drizzle-orm";
import { Webhook } from "svix";
import { getDb, schema } from "@/db";
import type { Message } from "@/db/schema";

// Resend delivery webhooks (§5): delivered / bounced / complained keep
// messages.status honest and take dead addresses out of rotation. Without
// this a hard bounce is invisible and we keep mailing it — which is how a
// young sending domain loses its reputation.

export const maxDuration = 60;

type ResendStatusPayload = {
  type?: string;
  data?: {
    email_id?: string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
};

// A late-arriving event must never walk a message backwards (a delayed
// `sent` after `delivered`), but a complaint days later must still land.
const RANK: Record<Message["status"], number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  bounced: 3,
  complained: 3,
  failed: 3,
};

export async function POST(request: Request) {
  const secret =
    process.env.RESEND_STATUS_WEBHOOK_SECRET ??
    process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "webhook not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  let payload: ResendStatusPayload;
  try {
    payload = new Webhook(secret).verify(rawBody, {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    }) as ResendStatusPayload;
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const type = payload.type ?? "";
  const providerId = payload.data?.email_id;
  if (!providerId) {
    return Response.json({ ok: true, skipped: "no email_id" });
  }

  const status: Message["status"] | null =
    type === "email.delivered"
      ? "delivered"
      : type === "email.bounced"
        ? "bounced"
        : type === "email.complained"
          ? "complained"
          : null;
  // email.sent / email.delivery_delayed / opens / clicks carry no state we keep.
  if (!status) {
    return Response.json({ ok: true, skipped: type });
  }

  const db = getDb();
  const message = await db.query.messages.findFirst({
    where: eq(schema.messages.providerId, providerId),
  });
  if (!message) {
    return Response.json({ ok: true, skipped: "unknown email_id" });
  }

  if (RANK[status] >= RANK[message.status]) {
    await db
      .update(schema.messages)
      .set({
        status,
        error: payload.data?.bounce?.message ?? message.error,
      })
      .where(eq(schema.messages.id, message.id));
  }

  // A permanent bounce takes the address out of rotation. Transient bounces
  // (full mailbox, greylisting) are not the subscriber's fault — leave them.
  const bounceType = payload.data?.bounce?.type?.toLowerCase();
  if (status === "bounced" && bounceType !== "transient") {
    await db
      .update(schema.subscribers)
      .set({ status: "bounced", updatedAt: new Date() })
      .where(eq(schema.subscribers.id, message.subscriberId));
    await db.insert(schema.events).values({
      subscriberId: message.subscriberId,
      type: "bounced",
      payload: { messageId: message.id, bounce: payload.data?.bounce },
    });
  }

  // A spam complaint is an unsubscribe with feeling. Stop immediately.
  if (status === "complained") {
    await db
      .update(schema.subscribers)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(schema.subscribers.id, message.subscriberId));
    await db.insert(schema.events).values({
      subscriberId: message.subscriberId,
      type: "complained",
      payload: { messageId: message.id },
    });
  }

  return Response.json({ ok: true, status });
}

"use server";

import { desc, and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import type { Subscriber } from "@/db/schema";
import { generateDailyEmail } from "@/lib/ai/generateDaily";
import {
  endSession,
  passwordMatches,
  requireAdmin,
  startSession,
} from "@/lib/admin/auth";
import { sendEmail } from "@/lib/email/send";
import {
  generateAndSendDaily,
  hasDailyToday,
  sendReviewedDaily,
} from "@/lib/pipeline/sendDaily";
import { localDate } from "@/lib/time";

// Every action re-checks auth: a server action is a public endpoint and can
// never rely on the protected layout having run.

async function loadSubscriber(id: string): Promise<Subscriber> {
  const db = getDb();
  const subscriber = await db.query.subscribers.findFirst({
    where: eq(schema.subscribers.id, id),
  });
  if (!subscriber) throw new Error(`No subscriber ${id}`);
  return subscriber;
}

async function logAdmin(subscriberId: string, action: string, detail?: unknown) {
  const db = getDb();
  await db.insert(schema.events).values({
    subscriberId,
    type: "admin_action",
    payload: { action, ...(detail ? { detail } : {}) },
  });
}

function backTo(id: string): string {
  return `/admin/subscribers/${id}`;
}

export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  if (!password || !passwordMatches(password)) {
    redirect("/admin/login?err=1");
  }
  await startSession();
  redirect("/admin");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/admin/login");
}

/**
 * Generate tomorrow's email without sending it (§10 step 4) — the voice can be
 * tuned against real subscriber history before anything reaches an inbox.
 * Stored as a `daily_generated` event flagged `preview`, so it is auditable
 * next to every real generation.
 */
export async function previewNext(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("subscriberId"));
  const subscriber = await loadSubscriber(id);
  const db = getDb();

  const profile = await db.query.profiles.findFirst({
    where: eq(schema.profiles.subscriberId, id),
  });
  const dayNumber = subscriber.dayNumber + 1;

  try {
    const generated = await generateDailyEmail(subscriber, profile, dayNumber);
    await db.insert(schema.events).values({
      subscriberId: id,
      type: "daily_generated",
      payload: {
        preview: true,
        dayNumber,
        subject: generated.subject,
        body: generated.body,
        model: generated.model,
        promptTokens: generated.promptTokens,
        completionTokens: generated.completionTokens,
      },
    });
  } catch (err) {
    await db.insert(schema.events).values({
      subscriberId: id,
      type: "generation_failed",
      payload: {
        stage: "preview",
        dayNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  revalidatePath(backTo(id));
}

/** Send the exact text shown in the preview — still one email per day. */
export async function sendPreview(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("subscriberId"));
  const subscriber = await loadSubscriber(id);
  const db = getDb();

  const [event] = await db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.subscriberId, id),
        eq(schema.events.type, "daily_generated"),
      ),
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(1);

  const payload = event?.payload as
    | {
        preview?: boolean;
        subject?: string;
        body?: string;
        model?: string;
        promptTokens?: number;
        completionTokens?: number;
      }
    | undefined;
  if (!payload?.preview || !payload.subject || !payload.body) {
    revalidatePath(backTo(id));
    return;
  }

  await sendReviewedDaily(subscriber, {
    subject: payload.subject,
    body: payload.body,
    model: payload.model ?? "preview",
    promptTokens: payload.promptTokens ?? 0,
    completionTokens: payload.completionTokens ?? 0,
  });
  await logAdmin(id, "send_preview");
  revalidatePath(backTo(id));
}

/** Generate fresh and send now. Overrides a hold; never the one-a-day rule. */
export async function sendNow(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("subscriberId"));
  const subscriber = await loadSubscriber(id);
  try {
    await generateAndSendDaily(subscriber, { force: true });
    await logAdmin(id, "send_now");
  } catch {
    // generateAndSendDaily already logged generation_failed; it surfaces in
    // the Sends view.
  }
  revalidatePath(backTo(id));
}

/** Hold today's/tomorrow's send. Self-expiring — stored as a local date. */
export async function toggleHold(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("subscriberId"));
  const subscriber = await loadSubscriber(id);
  const db = getDb();

  // Hold whichever send is actually next: today's if it hasn't gone out yet,
  // otherwise tomorrow's.
  const target = subscriber.holdDate
    ? null
    : await hasDailyToday(subscriber)
      ? localDate(subscriber.timezone, new Date(Date.now() + 24 * 60 * 60 * 1000))
      : localDate(subscriber.timezone);

  await db
    .update(schema.subscribers)
    .set({ holdDate: target, updatedAt: new Date() })
    .where(eq(schema.subscribers.id, id));
  await logAdmin(id, target ? "hold_set" : "hold_cleared", target);
  revalidatePath(backTo(id));
}

export async function setStatus(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("subscriberId"));
  const status = String(formData.get("status"));
  if (!["active", "paused", "stopped"].includes(status)) return;
  const db = getDb();

  await db
    .update(schema.subscribers)
    .set({
      status: status as Subscriber["status"],
      updatedAt: new Date(),
    })
    .where(eq(schema.subscribers.id, id));
  await logAdmin(id, `status_${status}`);
  revalidatePath(backTo(id));
}

/** Re-send an existing message verbatim — the repair path for a failed send. */
export async function resendMessage(formData: FormData): Promise<void> {
  await requireAdmin();
  const messageId = String(formData.get("messageId"));
  const db = getDb();

  const message = await db.query.messages.findFirst({
    where: eq(schema.messages.id, messageId),
  });
  if (!message?.subject || !message.bodyText) return;
  const subscriber = await loadSubscriber(message.subscriberId);

  await sendEmail({
    subscriber,
    kind: message.kind,
    subject: message.subject,
    text: message.bodyText,
    dayNumber: message.dayNumber ?? undefined,
    model: message.model ?? undefined,
  });
  await logAdmin(subscriber.id, "resend", { messageId });
  revalidatePath(backTo(subscriber.id));
  revalidatePath("/admin/sends");
}

export async function updateSchedule(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("subscriberId"));
  const timezone = String(formData.get("timezone") ?? "").trim();
  const hour = Number(formData.get("sendHourLocal"));
  const minute = Number(formData.get("sendMinuteLocal"));

  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  } catch {
    return; // unknown IANA zone — leave the record untouched
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return;

  const db = getDb();
  await db
    .update(schema.subscribers)
    .set({
      timezone,
      sendHourLocal: hour,
      sendMinuteLocal: minute,
      updatedAt: new Date(),
    })
    .where(eq(schema.subscribers.id, id));
  await logAdmin(id, "schedule_updated", { timezone, hour, minute });
  revalidatePath(backTo(id));
}

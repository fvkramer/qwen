import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { getDb, schema } from "@/db";
import type { Subscriber } from "@/db/schema";
import { sanitizeHeaderValue } from "@/lib/security";
import { emailFooter } from "./templates/footer";

type SendArgs = {
  subscriber: Subscriber;
  kind: "intake" | "daily" | "confirm" | "system";
  subject: string;
  text: string;
  html?: string;
  dayNumber?: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Minimal single-column table on the design tokens: max 600px, no images,
// left-aligned. Plaintext is canonical; this is a light wrapper around it.
export function renderHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p.trim()).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0;text-align:left;font-family:Archivo,system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#14120e;"><tr><td style="padding:24px;">
${paragraphs}
</td></tr></table>
</td></tr></table>`;
}

/**
 * Send one email through Resend. Always records the `messages` row before the
 * send attempt (never send without a row), sets threading headers from the
 * subscriber's thread_message_id, and stores provider id + Message-ID after.
 */
export async function sendEmail(args: SendArgs) {
  const db = getDb();
  const from = required("FROM_EMAIL");
  const replyTo = required("REPLY_TO_EMAIL");
  const domain = from.match(/@([A-Za-z0-9.-]+)/)?.[1] ?? "qwen.local";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const token = args.subscriber.unsubscribeToken;
  // RFC 8058 one-click requires an HTTPS URI: pairing List-Unsubscribe-Post
  // with a mailto alone is non-conformant, and Gmail/Yahoo bulk-sender rules
  // expect the URL form. The mailto stays as a fallback for older clients.
  const oneClickUrl = `${appUrl}/api/unsubscribe/${token}`;
  const text = `${args.text}\n${emailFooter(`${appUrl}/unsubscribe/${token}`)}`;
  // Model-written, so it must not be able to smuggle a newline into a header.
  const subject = sanitizeHeaderValue(args.subject);
  const messageId = `<${randomUUID()}@${domain}>`;
  const inReplyTo = args.subscriber.threadMessageId ?? null;

  const [row] = await db
    .insert(schema.messages)
    .values({
      subscriberId: args.subscriber.id,
      kind: args.kind,
      dayNumber: args.dayNumber,
      subject,
      bodyText: text,
      bodyHtml: args.html ?? renderHtml(text),
      messageId,
      inReplyTo,
      status: "queued",
      model: args.model,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
    })
    .returning();

  try {
    const resend = new Resend(required("RESEND_API_KEY"));
    const headers: Record<string, string> = {
      "Message-ID": messageId,
      "List-Unsubscribe": `<${oneClickUrl}>, <mailto:${replyTo}?subject=stop>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
    if (inReplyTo) {
      headers["In-Reply-To"] = inReplyTo;
      headers["References"] = inReplyTo;
    }

    const { data, error } = await resend.emails.send({
      from,
      to: args.subscriber.email,
      replyTo,
      subject,
      text,
      html: args.html ?? renderHtml(text),
      headers,
    });
    if (error) throw new Error(`Resend: ${error.message}`);

    await db
      .update(schema.messages)
      .set({ providerId: data?.id, status: "sent", sentAt: new Date() })
      .where(eq(schema.messages.id, row.id));

    // The first threaded email (intake) anchors the conversation; every later
    // send references it so clients stack them in one thread.
    if (!args.subscriber.threadMessageId && args.kind !== "confirm") {
      await db
        .update(schema.subscribers)
        .set({ threadMessageId: messageId, updatedAt: new Date() })
        .where(eq(schema.subscribers.id, args.subscriber.id));
    }

    return { ...row, providerId: data?.id ?? null, status: "sent" as const };
  } catch (err) {
    await db
      .update(schema.messages)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.messages.id, row.id));
    throw err;
  }
}

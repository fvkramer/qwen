import { Webhook } from "svix";
import { handleInboundReply } from "@/lib/pipeline/handleReply";

export const maxDuration = 120;

type ResendInboundPayload = {
  type?: string;
  data?: {
    from?: string | { email?: string; name?: string };
    to?: unknown;
    subject?: string;
    text?: string;
    html?: string;
    headers?: Array<{ name?: string; value?: string }> | Record<string, string>;
  };
};

function extractFromEmail(from: ResendInboundPayload["data"] extends infer D ? (D extends { from?: infer F } ? F : never) : never): string | null {
  if (!from) return null;
  if (typeof from === "string") {
    const match = from.match(/<([^>]+)>/);
    return (match ? match[1] : from).trim().toLowerCase();
  }
  if (typeof from === "object" && from.email) return from.email.trim().toLowerCase();
  return null;
}

function extractHeader(
  headers: NonNullable<ResendInboundPayload["data"]>["headers"],
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    const hit = headers.find((h) => h.name?.toLowerCase() === lower);
    return hit?.value ?? null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "webhook not configured" }, { status: 500 });
  }

  // Verify the svix signature on the raw body. Reject unsigned.
  const rawBody = await request.text();
  let payload: ResendInboundPayload;
  try {
    const webhook = new Webhook(secret);
    payload = webhook.verify(rawBody, {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    }) as ResendInboundPayload;
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  // Only inbound email events carry a reply.
  if (payload.type && !/received|inbound/i.test(payload.type)) {
    return Response.json({ ok: true, skipped: payload.type });
  }

  const data = payload.data ?? {};
  const fromEmail = extractFromEmail(data.from as never);
  const text =
    data.text ?? (data.html ? data.html.replace(/<[^>]+>/g, " ") : "");

  if (!fromEmail || !text?.trim()) {
    return Response.json({ ok: true, skipped: "no sender or body" });
  }

  const outcome = await handleInboundReply({
    fromEmail,
    subject: data.subject ?? null,
    rawText: text,
    inReplyToHeader: extractHeader(data.headers, "in-reply-to"),
    raw: payload,
  });

  return Response.json({ ok: true, outcome });
}

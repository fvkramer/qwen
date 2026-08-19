import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { Profile, Subscriber } from "@/db/schema";
import { generateStructured } from "./generate";
import { COACH_VOICE, SAFETY_RULES, UNTRUSTED_INPUT_RULES } from "./voice";

const DailyEmailSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export type GeneratedDaily = {
  subject: string;
  body: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

function validate(subject: string, body: string): string | null {
  if (subject.trim().length < 3 || subject.length > 120) {
    return "subject must be 3-120 characters";
  }
  if (body.trim().length < 200 || body.length > 4000) {
    return "body must be 200-4000 characters";
  }
  if (!body.includes("?")) {
    return "body must end with (at least contain) a question";
  }
  if (/\[[A-Z_ ]+\]|\{\{|\bTODO\b|\bXXX\b|lorem ipsum/i.test(body + subject)) {
    return "output contains placeholder text";
  }
  return null;
}

/**
 * The coach-writer agent. Builds full-history context (profile, recent
 * outbound emails, unprocessed replies, day number) and writes one daily
 * email. Output is validated; one retry with the validation error fed back;
 * a second failure throws so the caller records generation_failed — a broken
 * email is never sent.
 */
export async function generateDailyEmail(
  subscriber: Subscriber,
  profile: Profile | undefined,
  dayNumber: number,
  modelOverride?: string,
): Promise<GeneratedDaily> {
  const db = getDb();

  const recent = await db
    .select({
      kind: schema.messages.kind,
      dayNumber: schema.messages.dayNumber,
      subject: schema.messages.subject,
      bodyText: schema.messages.bodyText,
    })
    .from(schema.messages)
    .where(eq(schema.messages.subscriberId, subscriber.id))
    .orderBy(desc(schema.messages.createdAt))
    .limit(10);

  const unprocessed = await db
    .select({
      bodyText: schema.replies.bodyText,
      createdAt: schema.replies.createdAt,
    })
    .from(schema.replies)
    .where(
      and(
        eq(schema.replies.subscriberId, subscriber.id),
        isNull(schema.replies.processedAt),
      ),
    )
    .orderBy(desc(schema.replies.createdAt))
    .limit(10);

  const context = `<subscriber_profile>
Summary:
${profile?.summary || "(no profile yet — they may not have replied to the intake email; write a gentle, truly-beginner day-one plan and ask one question that helps you learn about them)"}

Structured facts (JSON):
${JSON.stringify(profile?.facts ?? {}, null, 2)}
</subscriber_profile>

Current week's plan (JSON):
${JSON.stringify(profile?.currentPlan ?? null, null, 2)}

Recent emails Qwen sent (newest first):
${
  recent.length
    ? recent
        .map(
          (m) =>
            `--- [${m.kind}${m.dayNumber ? ` day ${m.dayNumber}` : ""}] ${m.subject ?? ""}\n${(m.bodyText ?? "").slice(0, 800)}`,
        )
        .join("\n")
    : "(none yet)"
}

Replies not yet acknowledged (newest first) — acknowledge naturally, do not quote them back:
<subscriber_reply>
${
  unprocessed.length
    ? unprocessed.map((r) => `--- ${r.bodyText.slice(0, 800)}`).join("\n")
    : "(none)"
}
</subscriber_reply>

Today is day ${dayNumber} for this subscriber.`;

  const system = `${COACH_VOICE}

${SAFETY_RULES}

${UNTRUSTED_INPUT_RULES}

Write today's email — the one email this person gets today. Requirements:
- Subject: short, concrete, no clickbait. Format like "Day ${dayNumber} — <what today is>".
- Body: what to do today, the reasoning behind it in plain words, and end with one question (or at most two) that will inform tomorrow's plan.
- Always name something the person told you earlier.
- Sized to the time they said they have; if you don't know yet, keep it under 20 minutes.
- If a recent reply mentioned pain or a constraint, today's plan visibly adapts to it and says so.
- Plain text only: no markdown, no bullets with asterisks, no emoji. Short paragraphs separated by blank lines, like a person typing an email.
- Do not include a greeting longer than a word or two, do not sign off with a name, and do not add a footer (one is appended automatically).`;

  type Attempt = {
    subject: string | null;
    body: string | null;
    error: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
  };

  async function attempt(content: string): Promise<Attempt> {
    try {
      const result = await generateStructured({
        role: "writer",
        system,
        user: content,
        schema: DailyEmailSchema,
        schemaName: "daily_email",
        modelOverride,
      });
      return {
        subject: result.parsed.subject,
        body: result.parsed.body,
        error: null,
        model: result.model,
        inputTokens: result.promptTokens,
        outputTokens: result.completionTokens,
      };
    } catch (err) {
      // A refusal or an unparseable response is a failed attempt, not a
      // crash: the retry below feeds the reason back and tries once more.
      return {
        subject: null,
        body: null,
        error: err instanceof Error ? err.message : String(err),
        model: modelOverride ?? "",
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  let feedback: string | null = null;
  const usage = { input: 0, output: 0 };
  let servedBy = "";

  for (let i = 0; i < 2; i++) {
    const result = await attempt(
      feedback
        ? `${context}\n\nYour previous attempt was rejected: ${feedback}. Write it again, fixing that.`
        : context,
    );
    usage.input += result.inputTokens;
    usage.output += result.outputTokens;
    if (result.model) servedBy = result.model;

    if (result.error || !result.subject || !result.body) {
      feedback = result.error ?? "model returned no subject or body";
      continue;
    }

    const error = validate(result.subject, result.body);
    if (error) {
      feedback = error;
      continue;
    }

    return {
      subject: result.subject.trim(),
      body: result.body.trim(),
      model: servedBy,
      promptTokens: usage.input,
      completionTokens: usage.output,
    };
  }

  throw new Error(`Daily generation failed after retry: ${feedback}`);
}

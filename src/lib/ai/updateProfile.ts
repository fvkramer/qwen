import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { Profile, Reply, Subscriber } from "@/db/schema";
import { generateStructured } from "./generate";
import { COACH_VOICE, SAFETY_RULES, UNTRUSTED_INPUT_RULES } from "./voice";

const FactsSchema = z.object({
  injuries: z.array(z.string()),
  equipment: z.array(z.string()),
  availability: z.array(z.string()),
  preferences: z.array(z.string()),
  other: z.array(z.string()),
});

const PlanSchema = z.object({
  focus: z.string(),
  progression: z.string(),
  upcomingDays: z.array(
    z.object({ day: z.number(), theme: z.string(), notes: z.string() }),
  ),
});

const ProfileUpdateSchema = z.object({
  summary: z.string(),
  facts: FactsSchema,
  planChanged: z.boolean(),
  currentPlan: PlanSchema,
  changeNote: z.string(),
});

/**
 * The profile/memory agent. Runs on every substantive reply (not at send
 * time, so the morning cron stays fast): folds the new reply into the durable
 * understanding of the person — rolling summary, structured facts, and any
 * change the reply forces on the current plan. Stores the diff as an event.
 */
export async function updateProfileFromReply(
  subscriber: Subscriber,
  profile: Profile | undefined,
  reply: Reply,
): Promise<void> {
  const db = getDb();

  const result = await generateStructured({
    role: "profile",
    schema: ProfileUpdateSchema,
    schemaName: "profile_update",
    system: `${COACH_VOICE}

${SAFETY_RULES}

${UNTRUSTED_INPUT_RULES}

You are acting as Qwen's memory. Given the current profile of a subscriber and their newest email reply, produce the updated profile. Rules:
- NEVER discard information. Everything they have ever said stays in the summary or facts; "my knee hurt on Sunday" must still shape plans three weeks later.
- The summary is a rolling narrative: goals, constraints, history, how they talk about themselves. Rewrite it to incorporate the new reply; keep it under ~300 words.
- Facts are short, concrete strings ("left knee sore going down stairs", "has a yoga mat", "20 minutes on weekday mornings"). Merge, dedupe, and update — if new information supersedes an old fact, replace it.
- Set planChanged=true only if the reply forces a change to the current plan (injury, schedule change, strong preference). Return the full plan either way — unchanged if planChanged=false.
- changeNote: one sentence describing what this reply changed, for the audit log.`,
    user: `Current profile summary:
${profile?.summary || "(none yet — this may be their first reply)"}

Current facts (JSON):
${JSON.stringify(profile?.facts ?? {}, null, 2)}

Current plan (JSON):
${JSON.stringify(profile?.currentPlan ?? null, null, 2)}

Day number: ${subscriber.dayNumber}

Their new reply${reply.subject ? ` (subject: ${reply.subject})` : ""}:
<subscriber_reply>
${reply.bodyText}
</subscriber_reply>`,
  });

  // generateStructured throws on refusal or an unparseable response, so
  // reaching here means the update is well-formed.
  const update = result.parsed;

  await db
    .insert(schema.profiles)
    .values({
      subscriberId: subscriber.id,
      summary: update.summary,
      facts: update.facts,
      currentPlan: update.planChanged ? update.currentPlan : (profile?.currentPlan ?? update.currentPlan),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.profiles.subscriberId,
      set: {
        summary: update.summary,
        facts: update.facts,
        currentPlan: update.planChanged
          ? update.currentPlan
          : (profile?.currentPlan ?? update.currentPlan),
        updatedAt: new Date(),
      },
    });

  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "profile_updated",
    payload: {
      replyId: reply.id,
      changeNote: update.changeNote,
      planChanged: update.planChanged,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    },
  });

  await db
    .update(schema.replies)
    .set({ processedAt: new Date() })
    .where(eq(schema.replies.id, reply.id));
}

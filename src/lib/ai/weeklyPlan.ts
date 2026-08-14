import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { Profile, Subscriber } from "@/db/schema";
import { getAnthropic, MODEL } from "./client";
import { COACH_VOICE, SAFETY_RULES } from "./voice";

const PlanSchema = z.object({
  focus: z.string(),
  progression: z.string(),
  upcomingDays: z.array(
    z.object({ day: z.number(), theme: z.string(), notes: z.string() }),
  ),
});

/**
 * The planner agent. Runs weekly: regenerates current_plan from the
 * accumulated profile so progression looks ahead instead of only reacting
 * to yesterday's reply.
 */
export async function regenerateWeeklyPlan(
  subscriber: Subscriber,
  profile: Profile,
): Promise<void> {
  const db = getDb();
  const client = getAnthropic();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 5000,
    system: `${COACH_VOICE}

${SAFETY_RULES}

You are planning the coming week for this subscriber. Given everything known about them, produce the week's shape: a focus, a one-line progression idea (how this week builds on what they've done), and themes for the next 7 days (day numbers continue from their current day number). Respect every constraint in their profile — injuries, time, equipment, preferences. Beginner-safe: progress by adding time or ease before intensity, and include recovery days.`,
    messages: [
      {
        role: "user",
        content: `Profile summary:
${profile.summary}

Facts (JSON):
${JSON.stringify(profile.facts, null, 2)}

Previous plan (JSON):
${JSON.stringify(profile.currentPlan ?? null, null, 2)}

Current day number: ${subscriber.dayNumber}`,
      },
    ],
    output_config: { format: zodOutputFormat(PlanSchema) },
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Weekly plan failed: stop_reason=${response.stop_reason}`);
  }

  await db
    .update(schema.profiles)
    .set({ currentPlan: response.parsed_output, updatedAt: new Date() })
    .where(eq(schema.profiles.subscriberId, subscriber.id));

  await db.insert(schema.events).values({
    subscriberId: subscriber.id,
    type: "profile_updated",
    payload: {
      source: "weekly_plan",
      model: MODEL,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  });
}

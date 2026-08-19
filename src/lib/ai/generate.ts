import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import {
  fallbacksFor,
  getOpenRouter,
  modelFor,
  type ModelRole,
} from "./client";

export type StructuredResult<T> = {
  parsed: T;
  /** The model that actually served the request — not necessarily the one
   *  asked for, since OpenRouter may have fallen through to another. */
  model: string;
  promptTokens: number;
  completionTokens: number;
};

// OpenRouter accepts a few parameters the OpenAI schema does not describe.
type OpenRouterExtras = {
  models?: string[];
  provider?: { require_parameters?: boolean };
};

/**
 * One structured model call. Every agent goes through here so model choice,
 * routing, refusal handling and token accounting live in one place.
 *
 * `provider.require_parameters` keeps OpenRouter from routing to a provider
 * that would silently ignore the JSON schema and hand back prose.
 */
export async function generateStructured<S extends z.ZodType>({
  role,
  system,
  user,
  schema,
  schemaName,
  maxTokens = 6000,
  modelOverride,
}: {
  role: ModelRole;
  system: string;
  user: string;
  schema: S;
  schemaName: string;
  maxTokens?: number;
  modelOverride?: string;
}): Promise<StructuredResult<z.infer<S>>> {
  const client = getOpenRouter();
  const model = modelOverride || modelFor(role);
  const fallbacks = modelOverride ? [] : fallbacksFor(role);

  const extras: OpenRouterExtras = {
    provider: { require_parameters: true },
    ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
  };

  const params = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
    response_format: zodResponseFormat(schema, schemaName),
  };

  // The extras ride along on the wire; the cast keeps `parsed` inferred from
  // the schema rather than collapsing to `{}`.
  const response = await client.chat.completions.parse({
    ...params,
    ...extras,
  } as typeof params);

  const choice = response.choices[0];
  if (choice?.message.refusal) {
    throw new Error(`Model refused: ${choice.message.refusal}`);
  }
  const parsed = choice?.message.parsed;
  if (!parsed) {
    throw new Error(
      `Model returned no parseable output (finish_reason=${choice?.finish_reason ?? "none"})`,
    );
  }

  return {
    // The SDK infers through its own alias; same schema, same shape.
    parsed: parsed as z.infer<S>,
    model: response.model || model,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  };
}

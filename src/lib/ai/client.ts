import OpenAI from "openai";

/**
 * All model calls go through OpenRouter, which speaks the OpenAI wire format.
 * Using the gateway rather than one vendor's SDK means the model behind each
 * job is a config value, not a code change.
 */

export type ModelRole = "writer" | "profile" | "planner";

const ROLE_ENV: Record<ModelRole, string> = {
  writer: "OPENROUTER_MODEL_WRITER",
  profile: "OPENROUTER_MODEL_PROFILE",
  planner: "OPENROUTER_MODEL_PLANNER",
};

/**
 * The model for a job: its role-specific override, else the shared default.
 * There is deliberately no hardcoded fallback slug — OpenRouter's catalogue
 * changes, and a stale default would fail at send time in production rather
 * than at boot.
 */
export function modelFor(role: ModelRole): string {
  const model =
    process.env[ROLE_ENV[role]] || process.env.OPENROUTER_MODEL || "";
  if (!model) {
    throw new Error(
      `No model configured for the ${role} job. Set ${ROLE_ENV[role]} or OPENROUTER_MODEL ` +
        `to an OpenRouter model slug (see https://openrouter.ai/models).`,
    );
  }
  return model;
}

/**
 * Optional comma-separated fallbacks. OpenRouter tries them in order when the
 * primary is rate-limited, down, or refuses — so one flaky provider does not
 * cost a subscriber their morning email.
 */
export function fallbacksFor(role: ModelRole): string[] {
  const raw =
    process.env[`${ROLE_ENV[role]}_FALLBACKS`] ||
    process.env.OPENROUTER_MODEL_FALLBACKS ||
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let _client: OpenAI | null = null;

export function getOpenRouter(): OpenAI {
  if (!_client) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    _client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL:
        process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      // OpenRouter uses these for attribution on its dashboard and rankings.
      defaultHeaders: {
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "",
        "X-Title": "Qwen",
      },
    });
  }
  return _client;
}

/**
 * Slugs offered in the admin preview picker: the configured writer model plus
 * anything in OPENROUTER_PREVIEW_MODELS. Nothing is hardcoded — which models
 * are worth comparing is an account-level question, not a code one.
 */
export function previewModels(): string[] {
  const configured =
    process.env.OPENROUTER_MODEL_WRITER || process.env.OPENROUTER_MODEL || "";
  const extra = (process.env.OPENROUTER_PREVIEW_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([configured, ...extra].filter(Boolean))];
}

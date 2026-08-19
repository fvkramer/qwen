// Stub Resend + OpenRouter on one port so the whole pipeline can be exercised
// end-to-end with no real credentials. Both clients honour a base-URL env var
// (RESEND_BASE_URL / OPENROUTER_BASE_URL), so nothing in src/ knows about this.
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 3222);

const outbox = [];
let modelMode = "ok"; // ok | error | invalid
let counter = 0;
const modelCalls = [];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Answer whichever structured-output schema the caller asked for. */
function completionBody(request) {
  const props = Object.keys(
    request?.response_format?.json_schema?.schema?.properties ?? {},
  );
  const asked = JSON.stringify(request?.messages ?? []);

  if (props.includes("subject") && props.includes("body")) {
    // Echo any knee/time constraint we were given, so a test can assert that
    // continuity actually reached the writer's context.
    const constraint = /knee/i.test(asked) ? "your knee" : "what you told me";
    const minutes = /10 minutes/i.test(asked) ? "10" : "20";
    return {
      subject: `Day ${/day (\d+)/i.exec(asked)?.[1] ?? 1} — short walk`,
      body:
        `Morning. You said you have ${minutes} minutes today, so that is what this is sized to.\n\n` +
        `We are keeping the walk flat because of ${constraint}. Stop a rep early if anything complains — ` +
        `the point today is information, not effort. Walk at a pace where you could still hold a conversation, ` +
        `and give yourself permission to cut it short.\n\n` +
        `How did it feel afterwards?`,
    };
  }
  if (props.includes("planChanged")) {
    return {
      summary: "Beginner. Sore left knee on stairs. Often short on time.",
      facts: {
        injuries: ["left knee soreness on stairs"],
        equipment: ["yoga mat"],
        availability: ["10 minutes on busy days"],
        preferences: ["gentle tone"],
        other: [],
      },
      planChanged: true,
      currentPlan: {
        focus: "movement habit without aggravating the knee",
        progression: "add time before intensity",
        upcomingDays: [{ day: 4, theme: "flat walk", notes: "knee-neutral" }],
      },
      changeNote: "Knee soreness on stairs; keep routes flat.",
    };
  }
  return {
    focus: "consistency",
    progression: "add five minutes across the week",
    upcomingDays: [{ day: 5, theme: "flat walk", notes: "" }],
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://localhost");

    // ── inspection API (test-only) ──
    if (url.pathname === "/__outbox") return json(res, 200, outbox);
    if (url.pathname === "/__model-calls") return json(res, 200, modelCalls);
    if (url.pathname === "/__reset") {
      outbox.length = 0;
      modelCalls.length = 0;
      modelMode = "ok";
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__mode") {
      modelMode = url.searchParams.get("model") ?? "ok";
      return json(res, 200, { modelMode });
    }

    // ── Resend ──
    if (url.pathname === "/emails" && req.method === "POST") {
      const body = JSON.parse(raw);
      const id = `mock-email-${++counter}`;
      outbox.push({ id, ...body });
      return json(res, 200, { id });
    }

    // ── OpenRouter (OpenAI chat-completions wire format) ──
    if (url.pathname === "/chat/completions" && req.method === "POST") {
      const body = JSON.parse(raw);
      modelCalls.push(body);
      if (modelMode === "error") {
        return json(res, 500, {
          error: { type: "server_error", message: "mock upstream failure" },
        });
      }
      const content =
        modelMode === "invalid"
          ? JSON.stringify({ subject: "x", body: "too short" })
          : JSON.stringify(completionBody(body));
      return json(res, 200, {
        id: `gen_mock_${counter++}`,
        object: "chat.completion",
        created: 1700000000,
        // OpenRouter reports the model that actually served the request, which
        // may differ from the one asked for when `models` fallbacks are used.
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content, refusal: null },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
      });
    }

    return json(res, 404, { error: "not found", path: url.pathname });
  });
});

server.listen(PORT, () => console.log(`mock upstream on :${PORT}`));

// Stub Resend + Anthropic on one port so the whole pipeline can be exercised
// end-to-end with no real credentials. Both SDKs honour a base-URL env var
// (RESEND_BASE_URL / ANTHROPIC_BASE_URL), so nothing in src/ knows about this.
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 3222);

const outbox = [];
let anthropicMode = "ok"; // ok | error | invalid
let counter = 0;
const anthropicCalls = [];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Answer whichever structured-output schema the caller asked for. */
function anthropicBody(request) {
  const props = Object.keys(
    request?.output_config?.format?.schema?.properties ?? {},
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
    if (url.pathname === "/__anthropic-calls") return json(res, 200, anthropicCalls);
    if (url.pathname === "/__reset") {
      outbox.length = 0;
      anthropicCalls.length = 0;
      anthropicMode = "ok";
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__mode") {
      anthropicMode = url.searchParams.get("anthropic") ?? "ok";
      return json(res, 200, { anthropicMode });
    }

    // ── Resend ──
    if (url.pathname === "/emails" && req.method === "POST") {
      const body = JSON.parse(raw);
      const id = `mock-email-${++counter}`;
      outbox.push({ id, ...body });
      return json(res, 200, { id });
    }

    // ── Anthropic ──
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      const body = JSON.parse(raw);
      anthropicCalls.push(body);
      if (anthropicMode === "error") {
        return json(res, 500, {
          type: "error",
          error: { type: "api_error", message: "mock upstream failure" },
        });
      }
      const text =
        anthropicMode === "invalid"
          ? JSON.stringify({ subject: "x", body: "too short" })
          : JSON.stringify(anthropicBody(body));
      return json(res, 200, {
        id: `msg_mock_${counter++}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 300 },
      });
    }

    return json(res, 404, { error: "not found", path: url.pathname });
  });
});

server.listen(PORT, () => console.log(`mock upstream on :${PORT}`));

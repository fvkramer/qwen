// Acceptance checks from BUILD_PLAN §11, run against a real Next server, a
// real Postgres, and the stub upstream in mock-upstream.mjs.
//
//   node tests/mock-upstream.mjs 3222 &
//   RESEND_BASE_URL=... ANTHROPIC_BASE_URL=... npx next start -p 3111 &
//   node tests/acceptance.mjs
import postgres from "postgres";
import { Webhook } from "svix";

const APP = process.env.APP_URL ?? "http://localhost:3111";
const MOCK = process.env.MOCK_URL ?? "http://localhost:3222";
const DB = process.env.DATABASE_URL;
const WEBHOOK_SECRET =
  process.env.RESEND_WEBHOOK_SECRET ?? "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0";
const CRON_SECRET = process.env.CRON_SECRET ?? "test-cron-secret";

const sql = postgres(DB, { prepare: false, max: 3, onnotice: () => {} });
const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const outbox = () => fetch(`${MOCK}/__outbox`).then((r) => r.json());
const aiCalls = () => fetch(`${MOCK}/__anthropic-calls`).then((r) => r.json());
const setMode = (m) => fetch(`${MOCK}/__mode?anthropic=${m}`).then((r) => r.json());

async function reset() {
  await sql`truncate subscribers, events restart identity cascade`;
  await fetch(`${MOCK}/__reset`);
}

/** Submit the signup form the way a browser with JavaScript disabled does. */
async function signup(email, { form = "hero", age = 5000 } = {}) {
  const html = await fetch(APP).then((r) => r.text());
  const actionId = /name="(\$ACTION_ID_[a-f0-9]+)"/.exec(html)?.[1];
  if (!actionId) throw new Error("no server-action id in the rendered form");

  const body = new FormData();
  body.set(actionId, "");
  body.set("form", form);
  body.set("t", String(Date.now() - age));
  body.set("website", "");
  body.set("email", email);

  return fetch(APP, { method: "POST", body, redirect: "manual" });
}

async function inbound(fromEmail, text, inReplyTo = null) {
  const payload = JSON.stringify({
    type: "email.received",
    data: {
      from: fromEmail,
      subject: "Re: Qwen",
      text,
      headers: inReplyTo ? [{ name: "In-Reply-To", value: inReplyTo }] : [],
    },
  });
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const signature = new Webhook(WEBHOOK_SECRET).sign(id, timestamp, payload);
  return fetch(`${APP}/api/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: payload,
  });
}


/** Post a server-action form the way a no-JS browser does. */
async function actionPost(path, fields, extraHeaders = {}) {
  const html = await fetch(`${APP}${path}`, { headers: extraHeaders }).then((r) => r.text());
  const actionId = /name="(\$ACTION_ID_[a-f0-9]+)"/.exec(html)?.[1];
  if (!actionId) throw new Error(`no server-action id at ${path}`);
  const body = new FormData();
  body.set(actionId, "");
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return fetch(`${APP}${path}`, {
    method: "POST",
    body,
    headers: extraHeaders,
    redirect: "manual",
  });
}

async function statusWebhook(type, emailId, bounce) {
  const payload = JSON.stringify({ type, data: { email_id: emailId, bounce } });
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const signature = new Webhook(WEBHOOK_SECRET).sign(id, timestamp, payload);
  return fetch(`${APP}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: payload,
  });
}

const cron = (path) =>
  fetch(`${APP}/api/cron/${path}`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  }).then((r) => r.json());

// ───────────────────────────────────────────────────────────────────────────

async function main() {
  // §11 — "Signing up twice sends one confirm email, creates one row."
  // Also §4 — "it must work with JS disabled": these are raw form POSTs.
  await reset();
  await signup("dupe@example.com");
  await signup("dupe@example.com");
  const rows = await sql`select * from subscribers where email = 'dupe@example.com'`;
  const confirms = (await outbox()).filter((m) => m.subject?.match(/confirm/i));
  check("signup works with JS disabled", rows.length === 1, `${rows.length} row(s)`);
  check(
    "signing up twice → one row, one confirm email",
    rows.length === 1 && confirms.length === 1,
    `${rows.length} row(s), ${confirms.length} confirm email(s)`,
  );

  // Confirm → intake fires and anchors the thread.
  await reset();
  await signup("ana@example.com");
  const [pending] = await sql`select * from subscribers where email = 'ana@example.com'`;
  await fetch(`${APP}/confirm/${pending.confirm_token}`, { redirect: "manual" });
  const [confirmed] = await sql`select * from subscribers where id = ${pending.id}`;
  const intake = (await outbox()).find((m) => m.subject?.match(/hello/i));
  check(
    "confirm activates and sends the intake email",
    confirmed.status === "active" && Boolean(intake),
    `status=${confirmed.status}`,
  );
  check(
    "intake anchors the thread",
    Boolean(confirmed.thread_message_id) &&
      confirmed.thread_message_id === intake?.headers?.["Message-ID"],
    `thread=${confirmed.thread_message_id}`,
  );

  // §11 — "A reply mentioning a constraint visibly changes the next day's
  // email and appears in the profile facts."
  await inbound(
    "ana@example.com",
    "Stairs hurt my left knee going down. Also I only had 10 minutes today.",
  );
  const [profile] = await sql`select * from profiles where subscriber_id = ${pending.id}`;
  const factsText = JSON.stringify(profile?.facts ?? {});
  check(
    "reply is folded into profile facts",
    /knee/i.test(factsText),
    factsText.slice(0, 70),
  );

  const dailyCall = (await aiCalls()).find((c) =>
    Object.keys(c.output_config?.format?.schema?.properties ?? {}).includes("body"),
  );
  check(
    "the constraint reaches the writer's context (continuity)",
    /knee/i.test(JSON.stringify(dailyCall?.messages ?? [])),
    dailyCall ? "found in prompt" : "no daily generation call",
  );

  const afterReply = await outbox();
  const daily = afterReply.find((m) => m.subject?.match(/^Day /));
  check(
    "the next email reflects it",
    Boolean(daily) && /knee|10 minutes/i.test(daily.text),
    daily ? daily.subject : "no daily sent",
  );

  // §11 — "All daily emails land in one thread."
  const threaded = afterReply.filter((m) => m.subject && !m.subject.match(/confirm/i));
  const anchor = confirmed.thread_message_id;
  const allThreaded = threaded
    .filter((m) => m.headers?.["Message-ID"] !== anchor)
    .every(
      (m) =>
        m.headers?.["In-Reply-To"] === anchor && m.headers?.["References"] === anchor,
    );
  check(
    "every later email threads onto the intake",
    allThreaded,
    `${threaded.length} threaded email(s)`,
  );

  check(
    "every email carries List-Unsubscribe headers",
    afterReply.every(
      (m) => m.headers?.["List-Unsubscribe"] && m.headers?.["List-Unsubscribe-Post"],
    ),
    `${afterReply.length} email(s)`,
  );

  // §11 — "Cron run twice in the same hour sends exactly one daily email."
  await reset();
  // Due right now: the cron honours the minute, not just the hour.
  const utcHour = new Date().getUTCHours();
  const utcMinute = new Date().getUTCMinutes();
  await sql`
    insert into subscribers (email, status, timezone, send_hour_local, send_minute_local,
                             confirmed_at, day_number, thread_message_id)
    values ('ben@example.com', 'active', 'UTC', ${utcHour}, ${utcMinute}, now(), 2,
            '<anchor@qwen.local>')`;
  const first = await cron("daily");
  const second = await cron("daily");
  const dailies = (await outbox()).filter((m) => m.subject?.match(/^Day /));
  check(
    "cron run twice sends exactly one daily email",
    dailies.length === 1,
    `run1=${JSON.stringify(first)} run2=${JSON.stringify(second)}`,
  );

  // The send must never land before the time the subscriber chose: the
  // landing page promises 06:30, and hour-only matching used to mail at 06:00.
  await reset();
  const later = new Date(Date.now() + 90 * 60 * 1000);
  await sql`
    insert into subscribers (email, status, timezone, send_hour_local, send_minute_local,
                             confirmed_at, day_number, thread_message_id)
    values ('early@example.com', 'active', 'UTC', ${later.getUTCHours()},
            ${later.getUTCMinutes()}, now(), 2, '<anchor6@qwen.local>')`;
  const earlyRun = await cron("daily");
  check(
    "nobody is mailed before their chosen send time",
    earlyRun.attempted === 0 && (await outbox()).length === 0,
    JSON.stringify(earlyRun),
  );

  // §11 — "'stop' halts all future sends and is confirmed once."
  await reset();
  const [ben2] = await sql`
    insert into subscribers (email, status, timezone, send_hour_local, send_minute_local,
                             confirmed_at, day_number, thread_message_id)
    values ('ben@example.com', 'active', 'UTC', ${utcHour}, ${utcMinute}, now(), 2,
            '<anchor7@qwen.local>')
    returning *`;
  await inbound("ben@example.com", "stop");
  await inbound("ben@example.com", "stop");
  const [stopped] = await sql`select * from subscribers where id = ${ben2.id}`;
  const goodbyes = (await outbox()).filter((m) => m.subject?.match(/unsubscribed/i));
  check(
    "'stop' halts sending, confirmed exactly once",
    stopped.status === "stopped" && goodbyes.length === 1,
    `status=${stopped.status}, ${goodbyes.length} confirmation(s)`,
  );
  const beforeStopCron = (await outbox()).length;
  await cron("daily");
  check(
    "no further sends after stop",
    (await outbox()).length === beforeStopCron,
    `${beforeStopCron} email(s) before and after`,
  );

  // §11 — "A generation failure produces no email and one visible admin row."
  await reset();
  await setMode("error");
  const [carl] = await sql`
    insert into subscribers (email, status, timezone, send_hour_local, send_minute_local,
                             confirmed_at, day_number, thread_message_id)
    values ('carl@example.com', 'active', 'UTC', ${utcHour}, ${utcMinute}, now(), 1,
            '<anchor2@qwen.local>')
    returning *`;
  const failRun = await cron("daily");
  const failures =
    await sql`select * from events where subscriber_id = ${carl.id} and type = 'generation_failed'`;
  check(
    "generation failure sends no email and logs one admin row",
    (await outbox()).length === 0 && failures.length === 1 && failRun.failed === 1,
    `${(await outbox()).length} email(s), ${failures.length} failure event(s)`,
  );
  await setMode("ok");

  // Validation rejects a too-short body without sending.
  await reset();
  await setMode("invalid");
  const [dana] = await sql`
    insert into subscribers (email, status, timezone, send_hour_local, send_minute_local,
                             confirmed_at, day_number, thread_message_id)
    values ('dana@example.com', 'active', 'UTC', ${utcHour}, ${utcMinute}, now(), 1,
            '<anchor3@qwen.local>')
    returning *`;
  await cron("daily");
  const invalidFailures =
    await sql`select * from events where subscriber_id = ${dana.id} and type = 'generation_failed'`;
  check(
    "output failing validation is never sent",
    (await outbox()).length === 0 && invalidFailures.length === 1,
    `${(await outbox()).length} email(s)`,
  );
  await setMode("ok");


  // §8 — the safety screen answers with fixed text and never reaches the model.
  await reset();
  await setMode("ok");
  const [erin] = await sql`
    insert into subscribers (email, status, timezone, confirmed_at, day_number,
                             thread_message_id)
    values ('erin@example.com', 'active', 'UTC', now(), 3, '<anchor4@qwen.local>')
    returning *`;
  const callsBefore = (await aiCalls()).length;
  await inbound("erin@example.com", "I got chest pain halfway through the walk.");
  const emergency = (await outbox()).find((m) => m.subject?.match(/checked now/i));
  const flagged =
    await sql`select * from events where subscriber_id = ${erin.id} and type = 'safety_flagged'`;
  const [emergencyReply] =
    await sql`select * from replies where subscriber_id = ${erin.id}`;
  check(
    "emergency wording gets the fixed response, not the model",
    Boolean(emergency) &&
      flagged.length === 1 &&
      (await aiCalls()).length === callsBefore,
    `${flagged.length} flag(s), ${(await aiCalls()).length - callsBefore} model call(s)`,
  );
  check(
    "flagged reply is marked processed so it never feeds generation",
    emergencyReply?.processed_at !== null,
    `processed_at=${emergencyReply?.processed_at}`,
  );

  await reset();
  const [finn] = await sql`
    insert into subscribers (email, status, timezone, confirmed_at, day_number,
                             thread_message_id)
    values ('finn@example.com', 'active', 'UTC', now(), 3, '<anchor5@qwen.local>')
    returning *`;
  await inbound("finn@example.com", "honestly I want to die most mornings");
  const [finnAfter] = await sql`select * from subscribers where id = ${finn.id}`;
  const crisis = (await outbox()).find((m) => m.subject?.match(/please read this/i));
  check(
    "crisis wording pauses sending and sends the crisis response",
    Boolean(crisis) && finnAfter.status === "paused",
    `status=${finnAfter.status}`,
  );

  // §5 — delivery webhook keeps status honest and retires dead addresses.
  await reset();
  const [gus] = await sql`
    insert into subscribers (email, status, timezone, confirmed_at, day_number)
    values ('gus@example.com', 'active', 'UTC', now(), 1) returning *`;
  await sql`
    insert into messages (subscriber_id, kind, status, subject, body_text, provider_id)
    values (${gus.id}, 'daily', 'sent', 'Day 1', 'body', 'prov-1')`;

  const unsigned = await fetch(`${APP}/api/webhooks/resend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "email.delivered", data: { email_id: "prov-1" } }),
  });
  check("delivery webhook rejects unsigned requests", unsigned.status === 401,
    `HTTP ${unsigned.status}`);

  await statusWebhook("email.delivered", "prov-1");
  await statusWebhook("email.sent", "prov-1"); // late, out of order
  const [afterDelivered] = await sql`select * from messages where provider_id = 'prov-1'`;
  check(
    "a late event cannot walk a delivered message backwards",
    afterDelivered.status === "delivered",
    `status=${afterDelivered.status}`,
  );

  await statusWebhook("email.bounced", "prov-1", { type: "Transient", message: "mailbox full" });
  const [softBounced] = await sql`select * from subscribers where id = ${gus.id}`;
  check(
    "a transient bounce does not retire the subscriber",
    softBounced.status === "active",
    `status=${softBounced.status}`,
  );

  await statusWebhook("email.bounced", "prov-1", { type: "Permanent", message: "no such user" });
  const [hardBounced] = await sql`select * from subscribers where id = ${gus.id}`;
  check(
    "a permanent bounce retires the subscriber",
    hardBounced.status === "bounced",
    `status=${hardBounced.status}`,
  );

  await sql`update subscribers set status = 'active' where id = ${gus.id}`;
  await statusWebhook("email.complained", "prov-1");
  const [complained] = await sql`select * from subscribers where id = ${gus.id}`;
  check(
    "a spam complaint stops sending immediately",
    complained.status === "stopped",
    `status=${complained.status}`,
  );

  // §7 — the weekly planner refreshes current_plan.
  await reset();
  const [hana] = await sql`
    insert into subscribers (email, status, timezone, confirmed_at, day_number)
    values ('hana@example.com', 'active', 'UTC', now(), 4) returning *`;
  await sql`insert into profiles (subscriber_id, summary) values (${hana.id}, 'Knows the basics.')`;
  await cron("weekly");
  const [planned] = await sql`select * from profiles where subscriber_id = ${hana.id}`;
  check(
    "weekly cron regenerates the forward plan",
    Boolean(planned.current_plan?.focus),
    JSON.stringify(planned.current_plan ?? null).slice(0, 60),
  );

  // §9 — admin is closed by default and opens with the password.
  const guarded = await fetch(`${APP}/admin/subscribers`, { redirect: "manual" });
  check(
    "admin redirects to login when signed out",
    guarded.status === 307 && (guarded.headers.get("location") ?? "").includes("/admin/login"),
    `HTTP ${guarded.status}`,
  );
  const badLogin = await actionPost("/admin/login", { password: "wrong" });
  check(
    "wrong admin password sets no session",
    !(badLogin.headers.get("set-cookie") ?? "").includes("qwen_admin="),
    "no cookie issued",
  );
  const goodLogin = await actionPost("/admin/login", { password: "hunter2-admin" });
  const cookie = (goodLogin.headers.get("set-cookie") ?? "").split(";")[0];
  const dashboard = await fetch(`${APP}/admin/subscribers`, {
    headers: { cookie },
    redirect: "manual",
  });
  const dashboardHtml = await dashboard.text();
  check(
    "correct admin password opens the dashboard",
    dashboard.status === 200 && dashboardHtml.includes("hana@example.com"),
    `HTTP ${dashboard.status}`,
  );

  // ── summary ──
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? `\nFAILED: ${failed.map((f) => f.name).join(", ")}` : ""),
  );
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});

# Qwen — build plan

Design reference: `Qwen Landing.dc.html` in this project (or screenshots of it). Design tokens: `_ds/modernist-<id>/styles.css`.

---

## 1. What the product is

Qwen is a personal health trainer that operates entirely over email. There is no app and no dashboard for the user.

The loop:

1. A person enters their email on the landing page.
2. Qwen sends a short intake email. They reply in plain language — no forms, no fitness vocabulary. The target user is starting from zero.
3. Every morning at their local send time, Qwen sends one email: what to do today, the reasoning behind it, and a question or two.
4. They reply whenever they want. Replies are ingested, stored, and used to adapt the next day's plan.
5. Everything they have ever said is retained and connected. The user never repeats themselves — "my knee hurt on Sunday" should still be shaping the plan three weeks later.

Product rules that constrain the build:

- **Exactly one outbound email per user per day.** Never two. If a reply needs acknowledgement, it rolls into tomorrow's email unless it is urgent (see safety, §8).
- **Email is the only interface.** No login for end users. Unsubscribe is replying "stop".
- **Continuity is the feature.** The daily generation must have access to the full history, not just the last message.
- **One email thread per user.** Daily emails stack in a single Gmail/Apple Mail conversation, not 60 separate threads.

Admin (internal, single-tenant) needs to see: subscriber list and state, every message sent, every reply received, generation failures, and the ability to preview/regenerate/hold a user's next email.

---

## 2. Stack

- Next.js (App Router, TypeScript) on Vercel
- Postgres (Neon or Supabase) + Drizzle ORM + migrations
- Resend for outbound email and inbound reply webhooks (Postmark inbound is an acceptable substitute)
- Anthropic SDK (`@anthropic-ai/sdk`) for plan generation
- Vercel Cron for the daily send
- Auth for `/admin` only (Auth.js single-user credentials, or Vercel password protection)

Env vars: `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, `ADMIN_PASSWORD`, `NEXT_PUBLIC_APP_URL`, `FROM_EMAIL`, `REPLY_TO_EMAIL`.

---

## 3. Data model

```
subscribers
  id                uuid pk
  email             citext unique not null
  status            enum('pending_confirm','active','paused','stopped','bounced')
  timezone          text            -- IANA; default 'America/New_York', refined from reply headers or intake
  send_hour_local   int default 6
  send_minute_local int default 30
  confirm_token     text
  confirmed_at      timestamptz
  day_number        int default 0   -- increments on each successful daily send
  thread_message_id text            -- Message-ID of the first email; all later sends reference it
  created_at, updated_at

profiles              -- durable, model-maintained understanding of the person
  subscriber_id      uuid pk fk
  summary            text            -- rolling narrative: goals, constraints, history
  facts              jsonb           -- structured: injuries[], equipment[], availability{}, preferences{}
  current_plan       jsonb           -- this week's shape: focus, progression, upcoming days
  updated_at

messages              -- outbound
  id                uuid pk
  subscriber_id     uuid fk
  kind              enum('intake','daily','confirm','system')
  day_number        int
  subject           text
  body_text         text
  body_html         text
  provider_id       text            -- Resend id
  message_id        text            -- RFC Message-ID we set/received
  in_reply_to       text
  status            enum('queued','sent','delivered','bounced','complained','failed')
  model             text
  prompt_tokens, completion_tokens int
  error             text
  scheduled_for     timestamptz
  sent_at           timestamptz
  created_at

replies               -- inbound
  id                uuid pk
  subscriber_id     uuid fk
  in_reply_to_message_id uuid fk nullable
  from_email        text
  subject           text
  body_text         text            -- quoted history stripped
  raw               jsonb           -- full webhook payload, always keep
  processed_at      timestamptz     -- when it was folded into the profile
  created_at

events                -- append-only audit/analytics
  id, subscriber_id, type, payload jsonb, created_at
  -- types: signup, confirm_sent, confirmed, daily_generated, daily_sent, reply_received,
  --        profile_updated, paused, stopped, bounced, generation_failed, send_failed
```

Indexes: `subscribers(status, send_hour_local)`, `messages(subscriber_id, created_at desc)`, `messages(message_id)`, `replies(subscriber_id, created_at desc)`, `events(created_at desc)`.

---

## 4. Landing page

Build `app/page.tsx` from `Qwen Landing.dc.html`. It is plain semantic markup with inline styles; convert `style="…"` to `style={{…}}` and `class` to `className`. Import the design system's `styles.css` in the root layout and replace the literal hexes with its `var(--color-*)` tokens. Archivo via `next/font/google` (weights 400/500/600/800).

Structure, top to bottom: ruled header · hero (headline, copy, email capture) beside a sample-email panel · "How it works" in three equal cells with 2px vertical dividers · red poster close with a second email capture · footer. Rules are 2px `var(--color-divider)`, zero border radius anywhere, everything flush left including button labels.

Signup is a server action, not a client fetch:

```
app/actions/subscribe.ts
  - zod-validate email
  - normalize + lowercase
  - upsert subscriber (status 'pending_confirm', generate confirm_token)
  - if already active: return success without re-sending (no leak of subscription state either way)
  - rate limit by IP (Upstash or a simple Postgres counter): 5/hour
  - honeypot field + minimum time-on-page check for bots
  - send confirm email
  - log event
```

Both forms post to the same action and render the same inline success state ("You're in. Your first email arrives tomorrow at 6:30am."). Progressive enhancement: it must work with JS disabled.

`app/confirm/[token]/route.ts` — sets `status='active'`, `confirmed_at`, fires the intake email immediately, then redirects to a confirmation page styled on the same system.

---

## 5. Email sending

`lib/email/send.ts` wraps Resend and always:

- sets `From: Qwen <coach@…>`, `Reply-To: <inbound address>`
- sets `In-Reply-To` and `References` to `subscriber.thread_message_id` for every email after the first, so the client threads them
- stores the returned provider id and the `Message-ID` on the `messages` row
- includes `List-Unsubscribe` and `List-Unsubscribe-Post` headers
- records a `messages` row **before** the send attempt (status `queued`), then updates it — never send without a row

Templates in `lib/email/templates/`. Plaintext is the canonical version; the HTML is a minimal single-column table styled on the design tokens, max 600px, no images, left-aligned. It should read like a person wrote it, because tomorrow's version is written by the model.

Deliverability setup (do it before any volume): SPF, DKIM, DMARC on the sending domain; a dedicated subdomain for sending; Resend webhooks for `delivered`, `bounced`, `complained` → update `messages.status` and flip `subscribers.status` to `bounced` on hard bounce.

---

## 6. Inbound replies

`app/api/inbound/route.ts`

1. Verify the webhook signature. Reject unsigned.
2. Match the sender to a subscriber by email; if unknown, log an event and drop.
3. Strip quoted history and signatures (`email-reply-parser` or equivalent) into `body_text`; keep the full payload in `raw`.
4. Match `In-Reply-To` against `messages.message_id` to link the reply to what it answers.
5. If the body is a stop word (`stop`, `unsubscribe`, `cancel`, `quit`, case-insensitive, alone on the line) → `status='stopped'`, send one brief confirmation, done.
6. If the body is `pause` / `resume` → toggle `status` between `paused` and `active`.
7. Otherwise: insert the reply, fire a profile-update job.

`lib/ai/updateProfile.ts` — given the profile plus the new reply, return an updated `summary`, merged `facts`, and any change to `current_plan`. Use a JSON-schema tool call so the output is typed. Store the diff as an event. This runs on reply, not at send time, so the morning cron stays fast.

---

## 7. Daily generation and send

`app/api/cron/daily/route.ts`, scheduled hourly (`0 * * * *` in `vercel.json`), guarded by `CRON_SECRET`.

Each run:

1. Select active subscribers whose local time now matches their `send_hour_local`/`send_minute_local` (compute with `date-fns-tz` from stored IANA zone) **and** who have no `daily` message today. That last check is the idempotency guard — the cron must be safe to run twice.
2. For each, in a bounded concurrency pool (say 5):
   - Build context: profile summary + facts + current_plan, the last ~10 outbound subjects/bodies, unprocessed replies, `day_number`.
   - Generate subject + body via the Anthropic SDK with a system prompt encoding the voice: warm, plainspoken, second person, no hype, no emoji, no fitness jargon, always explains why, always names something the person told you earlier, always ends with one question. Sized to the time they said they have. Beginner-safe progression.
   - Validate the output (length bounds, has subject, has a question, no placeholder text). On failure, retry once, then write `generation_failed` and surface it in admin — never send a broken email.
   - Send, increment `day_number`, mark the replies that informed it as processed, log events.
3. Return a summary body: attempted / sent / failed. Log it.

Weekly (`0 5 * * 1`) a second cron regenerates `current_plan` from the accumulated profile so progression looks ahead rather than only reacting.

---

## 8. Safety

This gives health guidance to beginners, so bake in limits rather than hoping the prompt holds:

- The system prompt forbids diagnosis, medication advice, calorie/weight prescriptions, and anything for pregnancy or a named medical condition; in those cases it says plainly that this is outside what it does and suggests talking to a clinician.
- A keyword screen on inbound replies (chest pain, fainting, blood, self-harm, suicidal language) routes to a fixed, human-written response pointing at emergency services and flags the subscriber in admin. Never let the model freelance on those.
- Footer on every email: not medical advice, stop anytime.
- Log every prompt and completion (`messages.model`, token counts) so any bad output is traceable.

---

## 9. Admin panel

`/admin`, auth-gated, built on the same design system — mostly `.table` and `.card`, no new visual language.

- **Subscribers** — table: email, status, day number, timezone, last sent, last reply, reply count. Filter by status. Row click → detail.
- **Subscriber detail** — profile summary and facts, full message/reply timeline interleaved chronologically, and actions: preview next email, regenerate, hold tomorrow's send, pause, resend last, edit timezone/send time.
- **Sends** — today's cron results, failures first, with the error text and a retry button.
- **Overview** — signups per day, confirm rate, active count, reply rate per send, bounce/complaint rate, stop count. Simple numbers, no charts needed initially.

---

## 10. Build order

1. Schema + migrations + seed script.
2. Landing page ported from the design, signup action, confirm route, transactional emails wired to Resend. Deploy. This alone is a working waitlist.
3. Inbound webhook + reply parsing + storage.
4. Generation pipeline behind a manual "send now for one user" admin button, so the voice can be tuned before any cron runs.
5. Cron + timezone selection + idempotency guard.
6. Profile updates on reply, then the weekly plan job.
7. Admin panel.
8. Safety screens, deliverability records, bounce handling.

## 11. Acceptance checks

- Signing up twice sends one confirm email, creates one row.
- Cron run twice in the same hour sends exactly one daily email per user.
- A reply mentioning a constraint ("my knee hurts") visibly changes the next day's email and appears in the profile facts.
- "stop" halts all future sends and is confirmed once.
- All daily emails land in one thread in Gmail.
- A generation failure produces no email and one visible admin row.
- The landing page form works with JavaScript disabled.

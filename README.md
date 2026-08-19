# Qwen

A personal health trainer that operates entirely over email. One email each
morning, replies fold back into the plan, no app and no dashboard for the user.

The product spec and build order live in [`BUILD_PLAN.md`](./BUILD_PLAN.md).

## Stack

Next.js (App Router) on Vercel · Postgres + Drizzle · Resend for outbound mail
and inbound replies · OpenRouter for generation · Vercel Cron for the daily and
weekly jobs.

## Local development

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run db:migrate
npm run db:seed                # two example subscribers with history
npm run dev
```

`/admin` is password-gated by `ADMIN_PASSWORD`.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres. Use the pooled connection string; the client sets `prepare: false` for transaction-mode poolers. |
| `RESEND_API_KEY` | Outbound mail. |
| `RESEND_WEBHOOK_SECRET` | Signing secret for the **inbound** webhook (`/api/inbound`). |
| `RESEND_STATUS_WEBHOOK_SECRET` | Signing secret for the **delivery** webhook (`/api/webhooks/resend`). Falls back to `RESEND_WEBHOOK_SECRET` if unset, but Resend issues one secret per endpoint — set both. |
| `OPENROUTER_API_KEY` | Generation. All model calls go through OpenRouter. |
| `OPENROUTER_MODEL` | Default model slug, e.g. `vendor/model-name`. Required — there is no hardcoded default. |
| `OPENROUTER_MODEL_WRITER` / `_PROFILE` / `_PLANNER` | Optional per-job overrides. |
| `OPENROUTER_MODEL_FALLBACKS` | Optional comma-separated fallbacks for when the primary is down. |
| `OPENROUTER_PREVIEW_MODELS` | Optional extra slugs in the admin preview picker. |
| `CRON_SECRET` | Bearer token both cron routes require. Vercel sends it automatically. |
| `ADMIN_PASSWORD` | The only admin credential. It is also the session-cookie signing key, so rotating it signs everyone out. |
| `NEXT_PUBLIC_APP_URL` | Absolute base URL, used to build confirmation links. |
| `FROM_EMAIL` | e.g. `Qwen <coach@qwen.fit>`. |
| `REPLY_TO_EMAIL` | The inbound address replies are routed to. |

## Resend setup

Two webhooks, two different endpoints and secrets:

1. **Inbound replies** → `POST /api/inbound`, subscribed to the inbound email
   event. Routes replies into the profile agent.
2. **Delivery status** → `POST /api/webhooks/resend`, subscribed to
   `email.delivered`, `email.bounced`, and `email.complained`. Keeps
   `messages.status` honest, takes permanently-bounced addresses out of
   rotation, and stops sending to anyone who reports the mail as spam.

Both verify the svix signature and reject unsigned requests.

## Deliverability

Do this before any volume — these are DNS records, not code, and nothing in the
app can compensate for their absence:

- **Dedicated sending subdomain** (e.g. `mail.qwen.fit`) so the apex domain's
  reputation is insulated.
- **SPF** — the TXT record Resend gives you for that subdomain.
- **DKIM** — the CNAME records from the Resend domain page; wait for verified.
- **DMARC** — start at `v=DMARC1; p=none; rua=mailto:…`, read reports for a
  couple of weeks, then tighten to `p=quarantine`.

Every send carries RFC 8058 one-click unsubscribe — `List-Unsubscribe` with
an HTTPS URL (plus a `mailto:` fallback) and `List-Unsubscribe-Post` — which
Gmail and Yahoo require of bulk senders. Providers POST
`/api/unsubscribe/<token>`; the visible footer link points at a confirmation
page instead, so mail-security crawlers that follow every URL cannot silently
unsubscribe people. All of a subscriber's emails thread into one conversation
via `In-Reply-To`/`References` anchored on the intake message.

Still outstanding and not something the code can supply: **CAN-SPAM requires a
valid physical postal address in commercial email.** Add yours to
`emailFooter()` in `src/lib/email/templates/footer.ts` before sending at
volume.

## Cron

Declared in `vercel.json`:

- `/api/cron/daily` hourly — sends to everyone whose local send time has
  arrived within the last hour. Safe to run twice: exactly one daily email per
  subscriber per local day is enforced in the pipeline, not by the schedule.
- `/api/cron/weekly` Mondays — regenerates each active subscriber's
  `current_plan` so progression looks ahead rather than only reacting.

**Send-time granularity.** Subscribers have a send hour *and* minute, and the
default is 06:30 — but an hourly cron can only fire on the hour. The selection
rule is "at or after their send time, within the last 60 minutes", so a 06:30
subscriber is mailed at 07:00: never early, at most an hour late. To land on
06:30 exactly, tighten the schedule to `*/30 * * * *` (or `*/15`); the code
needs no change, and the once-per-local-day guard already makes the extra runs
free. More frequent crons need a Vercel plan that allows them.

## Tests

```bash
npm test                                     # pure logic: scheduling, timezones, DST
DATABASE_URL=postgres://…/qwen_test npm run test:acceptance
```

`test:acceptance` walks the acceptance checks in `BUILD_PLAN.md` §11 against a
production build, a real Postgres, and a stub upstream (`tests/mock-upstream.mjs`)
that impersonates Resend and OpenRouter. No real credentials, no mail sent,
nothing billed — both clients are redirected with `RESEND_BASE_URL` and
`OPENROUTER_BASE_URL`.

It truncates every table it touches, so point `DATABASE_URL` at a throwaway
database. Note that `tests/run.sh` exports its environment explicitly rather
than using `.env.local`: Next's dotenv never overrides variables already set in
the environment, and some sandboxes already export provider base URLs.

Covered: signup (including with JavaScript disabled), double signup, confirm and
intake, threading, `List-Unsubscribe` headers, reply → profile → next-day
continuity, cron idempotency, no-early-sends, `stop`, generation failure and
output validation, the emergency and crisis screens, the delivery webhook
(unsigned, out-of-order, soft bounce, hard bounce, complaint), the weekly
planner, admin auth, per-job model routing, schema-capable provider pinning,
fallback lists, and the admin model picker.

## Models

Every model call goes through [OpenRouter](https://openrouter.ai), so which
model does which job is configuration, not code. There are three jobs:

| Job | Env | What it does |
| --- | --- | --- |
| `writer` | `OPENROUTER_MODEL_WRITER` | Writes the daily coaching email. This is the one whose voice you tune. |
| `profile` | `OPENROUTER_MODEL_PROFILE` | Folds each reply into the durable profile and facts. |
| `planner` | `OPENROUTER_MODEL_PLANNER` | Regenerates the week's forward plan. |

Each falls back to `OPENROUTER_MODEL`. There is deliberately **no hardcoded
default slug** — OpenRouter's catalogue changes, and a stale default would fail
at send time rather than at boot. Set at least `OPENROUTER_MODEL`.

Requests pin `provider.require_parameters`, so OpenRouter only routes to
providers that honour the JSON schema; a provider that would quietly return
prose instead of structured output is never selected. `OPENROUTER_MODEL_FALLBACKS`
(or a per-job `…_FALLBACKS`) adds models the router tries when the primary is
rate-limited or down, so one flaky provider does not cost a subscriber their
morning email.

`messages.model` records the model that *actually served* each send, which is
not always the one requested when fallbacks are in play.

To compare models before switching, use the model box on a subscriber's admin
page: preview the same person's real history through any slug, read both, then
change the env var. An explicit choice there is never re-routed through
fallbacks — you see exactly the model you asked for.

## Admin

`/admin` — overview numbers, subscribers, and sends.

The subscriber detail page is where the coaching voice gets tuned: **Preview
next email** generates against that person's real history and shows it without
sending anything. Regenerate until it reads right, then **Send this** delivers
that exact text. **Generate & send now** skips the review step.

**Hold next send** parks the next email; it stores a local date, so it expires
on its own rather than needing to be remembered. Neither the hold override nor
the preview send can produce a second email in one day — that guard sits below
every path.

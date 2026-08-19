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
| `NEXT_PUBLIC_APP_URL` | Absolute base URL, used to build confirmation and unsubscribe links. |
| `TRUST_PROXY_HEADERS` | Set to `1` only behind a proxy you control. Vercel is detected automatically. See Security. |
| `INBOUND_ALLOW_UNVERIFIED` | Set to `1` to accept unauthenticated inbound replies. Leave unset. See Security. |
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

## Security

The abuse surface is small but real: two public endpoints that spend money
(each signup sends an email, each reply runs a model), a webhook that accepts
mail from anyone, and a single-password admin.

**Inbound replies are authenticated, not merely signed.** The webhook
signature only proves a message arrived through Resend — not who wrote it, and
a `From:` header is free to forge. A reply is acted on only if it threads onto
a Message-ID we generated for *that* subscriber (a random UUID, so quoting it
back is evidence of receipt) or the sending domain passed SPF or DKIM.
Everything else is stored as a `reply_rejected` event and ignored — including
`stop`, which would otherwise let anyone unsubscribe a stranger. If your
provider strips `Authentication-Results` and legitimate replies start getting
rejected, `INBOUND_ALLOW_UNVERIFIED=1` opens it back up; prefer fixing the
provider.

**Rate limits** are fixed-window counters in Postgres, incremented with one
atomic upsert so concurrent requests cannot both slip under the same limit,
and they fail *closed* — if the count cannot be read, the money is not spent.
Signups are capped per IP and, separately, **per email address**, so nobody
can point the form at a stranger's inbox and have us mail them repeatedly.
Replies are capped per subscriber, and the reply is stored either way: a
throttled subscriber loses the immediate turnaround, never their words. Admin
logins are capped per IP.

**Per-IP limits depend on knowing the caller's IP.** `x-forwarded-for` is
client-settable, so if the app is reachable directly, rotating that header
mints unlimited buckets and the limit stops existing. Forwarding headers are
therefore trusted only when `VERCEL=1` or `TRUST_PROXY_HEADERS=1`; otherwise
every caller shares one bucket — blunt, but not bypassable. **If you deploy
anywhere other than Vercel, set `TRUST_PROXY_HEADERS=1` and make sure your
proxy overwrites those headers.**

**Cron endpoints** compare their bearer token in constant time and treat a
missing `CRON_SECRET` as closed, not open — otherwise an unset variable turns
the check into the guessable string `Bearer undefined`.

**Model input is treated as data.** Subscriber text is delimited and the
system prompt refuses instructions found inside it. This is defence in depth
only: the hard limits — the emergency and crisis screens — are deterministic
keyword matches that run *before* the model and route to fixed, human-written
replies. Replies are truncated before they reach a prompt, both to bound cost
and to limit what an injection can carry. Model-written subject lines are
stripped of control characters so they cannot smuggle a header into an email.

**Responses** carry CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, and a
restrictive `Permissions-Policy`. `/admin`, `/confirm`, and `/unsubscribe`
additionally send `X-Robots-Tag: noindex`.

Not covered, and worth knowing: there is no CAPTCHA (the honeypot, time-on-page
check and rate limits are the whole bot defence), no WAF, and admin is a single
shared password — consider putting Vercel password protection in front of it as
a second factor.

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
fallback lists, and the admin model picker. Abuse resistance has its own
scenarios: forged senders, forged `stop`, reply floods, oversized payloads,
unauthenticated cron, header-spoofed signup floods, per-address email bombing,
admin password guessing, and the response headers.

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

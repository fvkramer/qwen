# Qwen

A personal health trainer that operates entirely over email. One email each
morning, replies fold back into the plan, no app and no dashboard for the user.

The product spec and build order live in [`BUILD_PLAN.md`](./BUILD_PLAN.md).

## Stack

Next.js (App Router) on Vercel · Postgres + Drizzle · Resend for outbound mail
and inbound replies · Anthropic SDK for generation · Vercel Cron for the daily
and weekly jobs.

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
| `ANTHROPIC_API_KEY` | Plan generation. |
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

Every send already carries `List-Unsubscribe` and `List-Unsubscribe-Post`
headers, and all of a subscriber's emails thread into one conversation via
`In-Reply-To`/`References` anchored on the intake message.

## Cron

Declared in `vercel.json`:

- `/api/cron/daily` hourly — sends to everyone whose local hour matches their
  send hour. Safe to run twice: exactly one daily email per subscriber per
  local day is enforced in the pipeline, not by the schedule.
- `/api/cron/weekly` Mondays — regenerates each active subscriber's
  `current_plan` so progression looks ahead rather than only reacting.

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

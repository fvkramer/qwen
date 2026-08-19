#!/usr/bin/env bash
# Boot the stub upstream + a production build against a throwaway Postgres and
# run the acceptance checks. Env is passed explicitly rather than via .env.local:
# Next's dotenv never overrides variables already present in the environment,
# and some CI/sandbox images already export ANTHROPIC_BASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?set DATABASE_URL to a throwaway database}"
APP_PORT="${APP_PORT:-3111}"
MOCK_PORT="${MOCK_PORT:-3222}"

export RESEND_API_KEY=re_test_key
export RESEND_BASE_URL="http://localhost:${MOCK_PORT}"
export RESEND_WEBHOOK_SECRET=whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0
export ANTHROPIC_API_KEY=sk-ant-test
export ANTHROPIC_BASE_URL="http://localhost:${MOCK_PORT}"
export CRON_SECRET=test-cron-secret
export ADMIN_PASSWORD=hunter2-admin
export NEXT_PUBLIC_APP_URL="http://localhost:${APP_PORT}"
export FROM_EMAIL="Qwen <coach@qwen.fit>"
export REPLY_TO_EMAIL=coach@qwen.fit
export APP_URL="http://localhost:${APP_PORT}"
export MOCK_URL="http://localhost:${MOCK_PORT}"

MOCK_PID=""; APP_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null; true; }
trap cleanup EXIT

node tests/mock-upstream.mjs "$MOCK_PORT" & MOCK_PID=$!
npx next start -p "$APP_PORT" > /tmp/qwen-test-app.log 2>&1 & APP_PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://localhost:${APP_PORT}/" > /dev/null && break
  sleep 0.5
done

node tests/acceptance.mjs

// Pure-logic checks that need no server or database.
// Run with: npx tsx tests/unit.mjs
import { isDueNow, localDate, localParts } from "../src/lib/time.ts";
import {
  bearerAuthorized,
  clientIp,
  sanitizeHeaderValue,
} from "../src/lib/security.ts";
import {
  assessInboundTrust,
  checkAuthenticationResults,
  truncateReply,
  MAX_REPLY_CHARS,
} from "../src/lib/email/inboundTrust.ts";

const results = [];
function check(name, pass, detail = "") {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const at = (iso) => new Date(iso);
const ny = { timezone: "America/New_York", sendHourLocal: 6, sendMinuteLocal: 30 };
const utc = { timezone: "UTC", sendHourLocal: 6, sendMinuteLocal: 0 };

// 06:30 New York in summer is 10:30 UTC.
check("not due before the chosen time",
  !isDueNow(ny, at("2026-08-19T10:00:00Z")), "06:00 local");
check("due at the chosen time",
  isDueNow(ny, at("2026-08-19T10:30:00Z")), "06:30 local");
check("still due on the next hourly run",
  isDueNow(ny, at("2026-08-19T11:00:00Z")), "07:00 local");
check("not due once the window has passed",
  !isDueNow(ny, at("2026-08-19T11:30:00Z")), "07:30 local");
check("not due in the middle of the night",
  !isDueNow(ny, at("2026-08-20T04:00:00Z")), "midnight local");

// Winter: the same wall-clock time is 11:30 UTC, so the offset must come from
// the zone, not from a stored number.
check("follows the zone across DST",
  isDueNow(ny, at("2026-01-15T11:30:00Z")) &&
    !isDueNow(ny, at("2026-01-15T10:30:00Z")),
  "06:30 EST");

check("whole-hour send times still fire on an hourly cron",
  isDueNow(utc, at("2026-08-19T06:00:00Z")), "06:00 UTC");

// A tighter cron schedule needs no code change.
check("a 15-minute window would hit 06:30 exactly",
  isDueNow(ny, at("2026-08-19T10:30:00Z"), 15) &&
    !isDueNow(ny, at("2026-08-19T11:00:00Z"), 15),
  "windowMinutes=15");

// Local-day boundaries drive the one-per-day guard.
check("local date rolls at local midnight, not UTC",
  localDate("America/New_York", at("2026-08-20T03:00:00Z")) === "2026-08-19" &&
    localDate("UTC", at("2026-08-20T03:00:00Z")) === "2026-08-20",
  "23:00 EDT is still the 19th");

check("an unknown timezone falls back instead of throwing",
  localParts("Not/AZone").hour >= 0, "no throw");

// ── cron bearer auth ──
check("cron rejects a missing secret configuration",
  !bearerAuthorized("Bearer undefined", undefined) &&
    !bearerAuthorized("Bearer ", "") &&
    !bearerAuthorized("Bearer anything", undefined),
  "unset CRON_SECRET closes the endpoint");
check("cron rejects a wrong or malformed token",
  !bearerAuthorized("Bearer wrong", "right") &&
    !bearerAuthorized("right", "right") &&
    !bearerAuthorized(null, "right"),
  "no bare or mismatched tokens");
check("cron accepts the configured token",
  bearerAuthorized("Bearer right", "right"));

// ── client IP ──
const hdr = (o) => new Headers(o);
delete process.env.TRUST_PROXY_HEADERS;
delete process.env.VERCEL;
check("forwarding headers are ignored when nothing trusted sets them",
  clientIp(hdr({ "x-forwarded-for": "1.1.1.1" })) === "unproxied" &&
    clientIp(hdr({ "x-real-ip": "2.2.2.2" })) === "unproxied",
  "one shared bucket rather than a caller-chosen one");

process.env.TRUST_PROXY_HEADERS = "1";
check("behind a trusted proxy, the claimed first hop is not used",
  clientIp(hdr({ "x-forwarded-for": "1.1.1.1, 9.9.9.9" })) === "9.9.9.9",
  "uses the hop our edge appended");
check("x-real-ip wins when present",
  clientIp(hdr({ "x-real-ip": "8.8.8.8", "x-forwarded-for": "1.1.1.1" })) === "8.8.8.8");
check("missing headers collapse to one bucket, not none",
  clientIp(hdr({})) === "unknown");
delete process.env.TRUST_PROXY_HEADERS;

// ── header injection ──
check("a newline in a model-written subject cannot reach a header",
  !/[\r\n]/.test(sanitizeHeaderValue("Day 3\r\nBcc: victim@example.com")),
  JSON.stringify(sanitizeHeaderValue("Day 3\r\nBcc: victim@example.com")));
check("an over-long subject is bounded",
  sanitizeHeaderValue("x".repeat(500)).length === 200);

// ── inbound sender trust ──
check("a threaded reply is trusted",
  assessInboundTrust({ threadMatches: true, authenticationResults: null,
    allowUnverified: false }).trusted);
check("an authenticated sender is trusted without threading",
  assessInboundTrust({ threadMatches: false,
    authenticationResults: "mx.example.com; spf=pass; dkim=pass",
    allowUnverified: false }).trusted);
check("a forged sender is rejected",
  !assessInboundTrust({ threadMatches: false,
    authenticationResults: "mx.example.com; spf=fail; dkim=fail",
    allowUnverified: false }).trusted,
  "spf/dkim fail");
check("an unverifiable sender is rejected by default",
  !assessInboundTrust({ threadMatches: false, authenticationResults: null,
    allowUnverified: false }).trusted &&
  assessInboundTrust({ threadMatches: false, authenticationResults: null,
    allowUnverified: true }).trusted,
  "closed unless INBOUND_ALLOW_UNVERIFIED");
check("authentication results parse both ways",
  checkAuthenticationResults("spf=pass") === "pass" &&
    checkAuthenticationResults("dkim=fail; spf=softfail") === "fail" &&
    checkAuthenticationResults(null) === "absent");

// ── reply size ──
check("an oversized reply is truncated, not passed to the model whole",
  truncateReply("x".repeat(50000)).text.length === MAX_REPLY_CHARS &&
    truncateReply("x".repeat(50000)).truncated === true &&
    truncateReply("short").truncated === false);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

// Pure-logic checks that need no server or database.
// Run with: npx tsx tests/unit.mjs
import { isDueNow, localDate, localParts } from "../src/lib/time.ts";

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

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

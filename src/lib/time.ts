// Timezone helpers built on Intl (no dependency, IANA-zone aware).

export type LocalParts = { date: string; hour: number; minute: number };

export function localParts(timezone: string, at: Date = new Date()): LocalParts {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    tz = "America/New_York";
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The subscriber's local calendar date for a given instant. */
export function localDate(timezone: string, at: Date = new Date()): string {
  return localParts(timezone, at).date;
}

/**
 * Is this subscriber due for today's email right now?
 *
 * True from their local send time until `windowMinutes` after it, so a send is
 * never *early* — mailing someone at 06:00 when they asked for 06:30 breaks the
 * promise the landing page makes. Matching a window rather than an exact minute
 * keeps this correct at any cron granularity: hourly today (06:30 → fires at
 * 07:00), and exactly on time if the cron is tightened to every 15 or 30
 * minutes, with no code change. Pair it with the one-per-local-day guard,
 * which is what makes overlapping runs safe.
 */
export function isDueNow(
  subscriber: { timezone: string; sendHourLocal: number; sendMinuteLocal: number },
  at: Date = new Date(),
  windowMinutes = 60,
): boolean {
  const now = localParts(subscriber.timezone, at);
  const minutesSinceSendTime =
    now.hour * 60 +
    now.minute -
    (subscriber.sendHourLocal * 60 + subscriber.sendMinuteLocal);
  return minutesSinceSendTime >= 0 && minutesSinceSendTime < windowMinutes;
}

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

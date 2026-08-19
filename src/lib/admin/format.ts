import type { Message, Subscriber } from "@/db/schema";

export function formatDateTime(at: Date | null): string {
  if (!at) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at);
}

/** The subscriber's own wall clock — the only clock the product cares about. */
export function formatLocal(at: Date | null, timezone: string): string {
  if (!at) return "—";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone,
    }).format(at);
  } catch {
    return formatDateTime(at);
  }
}

export function relative(at: Date | null): string {
  if (!at) return "—";
  const seconds = Math.round((Date.now() - at.getTime()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(-Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function subscriberPill(status: Subscriber["status"]): string {
  if (status === "bounced" || status === "stopped") return "pill pill--alert";
  if (status === "active") return "pill";
  return "pill pill--muted";
}

export function messagePill(status: Message["status"]): string {
  if (status === "failed" || status === "bounced" || status === "complained") {
    return "pill pill--alert";
  }
  if (status === "queued") return "pill pill--muted";
  return "pill";
}

// Model-response timestamps use elapsed age, not calendar-day boundaries:
// time alone for <24h; Yesterday for 24–<48h; local date thereafter.
// Add the year only when the message is from a different local year.
const DAY_MS = 24 * 60 * 60 * 1000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(kind: "time" | "year" | "date" | "dateYear", timeZone?: string): Intl.DateTimeFormat {
  const key = `${kind}:${timeZone ?? ""}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    const options: Intl.DateTimeFormatOptions =
      kind === "time"
        ? { hour: "numeric", minute: "2-digit", hour12: true, timeZone }
        : kind === "year"
          ? { year: "numeric", timeZone }
          : kind === "dateYear"
            ? { month: "short", day: "numeric", year: "numeric", timeZone }
            : { month: "short", day: "numeric", timeZone };
    formatter = new Intl.DateTimeFormat("en-US", options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function formatMessageTime(iso: string | null | undefined, nowMs = Date.now(), timeZone?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms);
  const time = getFormatter("time", timeZone).format(at);
  const ageMs = Math.max(0, nowMs - ms);
  if (ageMs < DAY_MS) return time;
  if (ageMs < 2 * DAY_MS) return `Yesterday, ${time}`;
  const year = getFormatter("year", timeZone);
  const otherYear = year.format(at) !== year.format(new Date(nowMs));
  const date = getFormatter(otherYear ? "dateYear" : "date", timeZone).format(at);
  return `${date}, ${time}`;
}

// Model-response timestamps use elapsed age, not calendar-day boundaries:
// time alone for <24h; Yesterday for 24–<48h; local date thereafter.
// Add the year only when the message is from a different local year.
const DAY_MS = 24 * 60 * 60 * 1000;
export function formatMessageTime(iso: string | null | undefined, nowMs = Date.now(), timeZone?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone,
  }).format(at);
  const ageMs = Math.max(0, nowMs - ms);
  if (ageMs < DAY_MS) return time;
  if (ageMs < 2 * DAY_MS) return `Yesterday, ${time}`;
  const year = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone });
  const otherYear = year.format(at) !== year.format(new Date(nowMs));
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", ...(otherYear ? { year: "numeric" } : {}), timeZone,
  }).format(at);
  return `${date}, ${time}`;
}

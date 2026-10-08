// Run time for a transcript tool row: a live counter while the tool runs,
// the final duration once it has finished. Null when the start is unknown
// (rows recorded before timing existed).
export function toolElapsedMs(startedAt: string | null | undefined, finishedAt: string | null | undefined, nowMs: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : nowMs;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// "0.4s" / "7.2s" (finished, under 10s), but "5s" instead of "5.0s";
// "3s" (running), "42s", "4m 5s", "1h 2m".
// A running tool shows whole seconds: the display ticks once per second.
export function formatToolDuration(ms: number, running: boolean): string {
  if (ms < 10_000 && !running) return `${Math.floor(ms / 100) / 10}s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

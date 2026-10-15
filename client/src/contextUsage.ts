// Composer context tooltip: "673k/922k (72.9%) of context used".
// Compact counts and a percentage — no "approximately", no token jargon.
export function contextUsageLabel(value: number, max: number): string {
  const compact = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`);
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return `${compact(value)}/${compact(max)} (${percent.toFixed(1)}%) of context used`;
}

const labels: Record<string, string> = {
  none: "Direct",
  minimal: "Express",
  low: "Quick",
  medium: "Balanced",
  high: "Thoughtful",
  xhigh: "Thorough",
  max: "Meticulous",
  ultra: "Exhaustive",
};

export function companionWorkingStyle(effort: string): string {
  return Object.hasOwn(labels, effort) ? labels[effort]! : "Custom";
}

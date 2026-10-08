// Browser-local appearance preference. "system" follows changes to the OS
// setting; CSS receives the resolved mode so every pane uses the same palette.
export type ColorMode = "system" | "light" | "dark";
export type ResolvedColorMode = "light" | "dark";

export const COLOR_MODE_KEY = "muse-code-space:color-mode";

export function parseColorMode(value: string | null): ColorMode {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveColorMode(mode: ColorMode, systemIsDark: boolean): ResolvedColorMode {
  return mode === "system" ? (systemIsDark ? "dark" : "light") : mode;
}

export function loadColorMode(): ColorMode {
  try { return parseColorMode(window.localStorage.getItem(COLOR_MODE_KEY)); } catch { return "system"; }
}

export function applyColorMode(mode: ColorMode): void {
  const systemIsDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.colorMode = resolveColorMode(mode, systemIsDark);
}

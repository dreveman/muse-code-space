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

export type UiTheme = "system" | "web" | "liquid-glass";
export type ResolvedUiTheme = "web" | "liquid-glass";

export const UI_THEME_KEY = "muse-code-space:ui-theme";

export function parseUiTheme(value: string | null): UiTheme {
  return value === "web" || value === "liquid-glass" ? value : "system";
}

export function detectIosDevice(nav?: {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
} | null): boolean {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : null);
  if (!n) return false;
  const ua = n.userAgent ?? "";
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  // iPadOS 13+ reports MacIntel with multi-touch points.
  if (n.platform === "MacIntel" && typeof n.maxTouchPoints === "number" && n.maxTouchPoints > 1) {
    return true;
  }
  return false;
}

export function resolveUiTheme(theme: UiTheme, isIos: boolean): ResolvedUiTheme {
  return theme === "system" ? (isIos ? "liquid-glass" : "web") : theme;
}

export function loadUiTheme(): UiTheme {
  try { return parseUiTheme(window.localStorage.getItem(UI_THEME_KEY)); } catch { return "system"; }
}

export function applyUiTheme(theme: UiTheme): void {
  try { window.localStorage.setItem(UI_THEME_KEY, theme); } catch { /* ignore blocked storage */ }
  const resolved = resolveUiTheme(theme, detectIosDevice());
  if (typeof document !== "undefined") {
    document.documentElement.dataset.uiTheme = resolved;
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("muse-code-space:ui-theme", { detail: theme }));
  }
}

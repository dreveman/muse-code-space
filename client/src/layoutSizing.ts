// Desktop pane sizes are a browser preference, not an agent setting. Keep
// enough room to use the chat and terminal at every desktop window size.
export const DEFAULT_SIDEBAR_WIDTH = 316;
export const DEFAULT_CHAT_SHARE = 0.5;
export const SIDEBAR_MIN = 244;
export const SIDEBAR_MAX = 560;
export const MIN_DETAIL_WIDTH = 440;
export const CHAT_MIN = 280;
export const TERMINAL_MIN = 240;
export const DIVIDER_WIDTH = 1;
export const PANE_SIZES_KEY = "muse-code-space:pane-sizes-v1";

export type PaneSizes = { sidebarWidth: number; chatShare: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function sidebarWidthBounds(viewportWidth: number) {
  return { min: SIDEBAR_MIN, max: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewportWidth - DIVIDER_WIDTH - MIN_DETAIL_WIDTH)) };
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const { min, max } = sidebarWidthBounds(viewportWidth);
  return clamp(Number.isFinite(width) ? Math.round(width) : DEFAULT_SIDEBAR_WIDTH, min, max);
}

export function chatWidthBounds(splitWidth: number) {
  const usable = Math.max(0, splitWidth - DIVIDER_WIDTH);
  // At small desktop sizes each side can shrink to half the available space.
  const min = Math.min(CHAT_MIN, usable / 2);
  return { min, max: usable - Math.min(TERMINAL_MIN, usable / 2) };
}

export function clampChatShare(share: number, splitWidth: number): number {
  const usable = Math.max(1, splitWidth - DIVIDER_WIDTH);
  const { min, max } = chatWidthBounds(splitWidth);
  return clamp(Number.isFinite(share) ? share : DEFAULT_CHAT_SHARE, min / usable, max / usable);
}

export function loadPaneSizes(viewportWidth: number): PaneSizes {
  let stored: Partial<PaneSizes> | null = null;
  try { stored = JSON.parse(window.localStorage.getItem(PANE_SIZES_KEY) ?? "null"); } catch { /* storage can be disabled in an embedded webview */ }
  const sidebarWidth = clampSidebarWidth(typeof stored?.sidebarWidth === "number" ? stored.sidebarWidth : DEFAULT_SIDEBAR_WIDTH, viewportWidth);
  const splitWidth = viewportWidth - sidebarWidth - DIVIDER_WIDTH;
  return {
    sidebarWidth,
    chatShare: clampChatShare(typeof stored?.chatShare === "number" ? stored.chatShare : DEFAULT_CHAT_SHARE, splitWidth),
  };
}

export function savePaneSizes(sizes: PaneSizes): void {
  try { window.localStorage.setItem(PANE_SIZES_KEY, JSON.stringify(sizes)); } catch { /* keep resizing usable even without storage */ }
}

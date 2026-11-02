// Isolated device-quirk detection and overrides.
//
// Safe areas on the iPhone Duo are asymmetric (`env(safe-area-inset-left)` !=
// `env(safe-area-inset-right)`), and in landscape mode the host places a
// native controls pane immediately to the right of the Space WebView.
// Centralizing that detection here makes it trivial to disable (`"off"`),
// force-enable for desktop testing (`"force-iphone-duo"`), or extend to
// future devices without scattering device heuristics across components.

import { detectIosDevice } from "./colorMode.ts";

export const DEVICE_QUIRKS_KEY = "muse-code-space:device-quirks";

export type DeviceQuirksMode = "auto" | "off" | "force-iphone-duo";

export type SafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export function parseDeviceQuirksMode(raw: string | null | undefined): DeviceQuirksMode {
  if (raw === "off" || raw === "force-iphone-duo") return raw;
  return "auto";
}

export function loadDeviceQuirksMode(): DeviceQuirksMode {
  try {
    return parseDeviceQuirksMode(window.localStorage.getItem(DEVICE_QUIRKS_KEY));
  } catch {
    return "auto";
  }
}

export function saveDeviceQuirksMode(mode: DeviceQuirksMode): void {
  try {
    if (mode === "auto") {
      window.localStorage.removeItem(DEVICE_QUIRKS_KEY);
    } else {
      window.localStorage.setItem(DEVICE_QUIRKS_KEY, mode);
    }
  } catch { /* ignore storage errors */ }
  syncDeviceQuirks();
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("muse-code-space:device-quirks"));
  }
}

export function isAsymmetricHorizontalSafeArea(insets: SafeAreaInsets): boolean {
  return Math.abs(insets.left - insets.right) >= 1;
}

export function resolveIphoneDuoLandscapeQuirk(input: {
  mode: DeviceQuirksMode;
  isIos: boolean;
  isLandscape?: boolean;
  insets: SafeAreaInsets;
}): boolean {
  if (input.mode === "off") return false;
  if (input.mode === "force-iphone-duo") return true;
  // Asymmetric horizontal safe-area insets (left != right) only occur in
  // landscape when the host's native controls pane occupies one side of the
  // screen (in portrait, both left and right safe-area insets are 0). Note
  // that the remaining WebView width beside the native pane can be narrower
  // than innerHeight, so we do not require innerWidth > innerHeight here.
  return input.isIos && isAsymmetricHorizontalSafeArea(input.insets);
}

let probeEl: HTMLDivElement | null = null;

export function measureSafeAreaInsets(doc: Document | undefined = typeof document !== "undefined" ? document : undefined): SafeAreaInsets {
  if (!doc?.body || typeof window === "undefined") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  if (!probeEl || !doc.body.contains(probeEl)) {
    probeEl = doc.createElement("div");
    probeEl.setAttribute("aria-hidden", "true");
    probeEl.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "width:0",
      "height:0",
      "pointer-events:none",
      "visibility:hidden",
      "z-index:-1",
      "padding-top:var(--twsa-safe-area-inset-top, env(safe-area-inset-top, 0px))",
      "padding-right:var(--twsa-safe-area-inset-right, env(safe-area-inset-right, 0px))",
      "padding-bottom:var(--twsa-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
      "padding-left:var(--twsa-safe-area-inset-left, env(safe-area-inset-left, 0px))",
    ].join(";");
    doc.body.appendChild(probeEl);
  }
  const cs = window.getComputedStyle(probeEl);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

export function syncDeviceQuirks(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const mode = loadDeviceQuirksMode();
  const isIos = detectIosDevice();
  const isLandscape = window.innerWidth > window.innerHeight;
  const insets = measureSafeAreaInsets(document);
  const active = resolveIphoneDuoLandscapeQuirk({
    mode,
    isIos,
    isLandscape,
    insets,
  });
  if (active) {
    document.documentElement.dataset.quirkIphoneDuo = "true";
  } else {
    delete document.documentElement.dataset.quirkIphoneDuo;
  }
  return active;
}

export function installDeviceQuirksObserver(): () => void {
  if (typeof window === "undefined") return () => {};
  const update = () => {
    syncDeviceQuirks();
  };
  update();
  const vv = window.visualViewport;
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.addEventListener("muse-code-space:device-quirks", update);
  vv?.addEventListener("resize", update);
  return () => {
    window.removeEventListener("resize", update);
    window.removeEventListener("orientationchange", update);
    window.removeEventListener("muse-code-space:device-quirks", update);
    vv?.removeEventListener("resize", update);
  };
}

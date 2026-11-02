// Isolated device-quirk detection and overrides.
//
// On the iPhone Duo in landscape mode, the host app places a native controls
// pane immediately to the right of the Space WebView. Because the WebView's
// right edge abuts that interior native pane rather than the physical phone
// bezel, UIKit reports `env(safe-area-inset-right) = 0` in landscape (whereas
// a full-bleed iPhone WebView in landscape has `safe-area-inset-right >= 44px`,
// and portrait mode has `safe-area-inset-bottom >= 30px`).
// Centralizing that detection here makes it trivial to disable (`"off"`),
// force-enable for desktop testing (`"force-iphone-duo"`), or extend to
// future devices without scattering device heuristics across components.

export const DEVICE_QUIRKS_KEY = "muse-code-space:device-quirks";

export type DeviceQuirksMode = "auto" | "off" | "force-iphone-duo";

export type SafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

let currentQuirksMode: DeviceQuirksMode = "auto";

export function parseDeviceQuirksMode(raw: string | null | undefined): DeviceQuirksMode {
  if (raw === "off" || raw === "force-iphone-duo") return raw;
  return "auto";
}

export function loadDeviceQuirksMode(): DeviceQuirksMode {
  return currentQuirksMode;
}

export function saveDeviceQuirksMode(mode: DeviceQuirksMode): void {
  currentQuirksMode = parseDeviceQuirksMode(mode);
  try {
    window.localStorage.removeItem(DEVICE_QUIRKS_KEY);
  } catch { /* ignore storage errors */ }
  syncDeviceQuirks();
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("muse-code-space:device-quirks"));
  }
}

export function detectIphoneDevice(
  nav: { userAgent?: string } | undefined = typeof navigator !== "undefined" ? navigator : undefined,
): boolean {
  if (!nav) return false;
  return /\biPhone\b/i.test(nav.userAgent ?? "");
}

export function isAsymmetricHorizontalSafeArea(insets: SafeAreaInsets): boolean {
  return Math.abs(insets.left - insets.right) >= 1;
}

export function resolveIphoneDuoLandscapeQuirk(input: {
  mode: DeviceQuirksMode;
  isIos: boolean;
  isIphone?: boolean;
  isLandscape?: boolean;
  viewportWidth?: number;
  insets: SafeAreaInsets;
}): boolean {
  if (input.mode === "off") return false;
  if (input.mode === "force-iphone-duo") return true;
  const isPhone = input.isIphone ?? input.isIos;
  if (!isPhone) return false;
  // In portrait on iPhone, safe-area-inset-bottom is ~34px and native controls
  // sit at the bottom rather than the right.
  if (input.insets.bottom >= 30 && !input.isLandscape) return false;
  const landscape =
    input.isLandscape === true ||
    (input.insets.bottom < 30 && (input.viewportWidth === undefined || input.viewportWidth >= 480));
  if (!landscape) return false;
  // On a normal full-width iPhone in landscape, both left and right safe-area
  // insets are >= 44px. When the host places a native pane on the right (as on
  // the iPhone Duo in landscape), `insets.right` is 0 (or asymmetric).
  return input.insets.right === 0 || isAsymmetricHorizontalSafeArea(input.insets);
}

let probeContainer: HTMLDivElement | null = null;
let probeTop: HTMLDivElement | null = null;
let probeRight: HTMLDivElement | null = null;
let probeBottom: HTMLDivElement | null = null;
let probeLeft: HTMLDivElement | null = null;

function ensureProbeElements(doc: Document): void {
  const host = doc.querySelector<HTMLElement>(".hatch-space-root[data-hatch-space-root]") ?? doc.body;
  if (!host) return;
  if (probeContainer && host.contains(probeContainer)) return;
  probeContainer = doc.createElement("div");
  probeContainer.setAttribute("aria-hidden", "true");
  probeContainer.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden;z-index:-1;";

  const makeProbe = (cssProp: "width" | "height", expr: string): HTMLDivElement => {
    const el = doc.createElement("div");
    el.style.cssText = `${cssProp}:${expr};`;
    probeContainer!.appendChild(el);
    return el;
  };

  probeTop = makeProbe("height", "env(safe-area-inset-top, 0px)");
  probeRight = makeProbe("width", "env(safe-area-inset-right, 0px)");
  probeBottom = makeProbe("height", "env(safe-area-inset-bottom, 0px)");
  probeLeft = makeProbe("width", "env(safe-area-inset-left, 0px)");
  host.appendChild(probeContainer);
}

export function measureSafeAreaInsets(
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): SafeAreaInsets {
  if (!doc?.body || typeof window === "undefined") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  ensureProbeElements(doc);
  return {
    top: probeTop ? Math.round(probeTop.getBoundingClientRect().height * 10) / 10 : 0,
    right: probeRight ? Math.round(probeRight.getBoundingClientRect().width * 10) / 10 : 0,
    bottom: probeBottom ? Math.round(probeBottom.getBoundingClientRect().height * 10) / 10 : 0,
    left: probeLeft ? Math.round(probeLeft.getBoundingClientRect().width * 10) / 10 : 0,
  };
}

export function syncDeviceQuirks(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const mode = loadDeviceQuirksMode();
  const isIphone = detectIphoneDevice();
  const isLandscape =
    window.innerWidth > window.innerHeight ||
    (typeof window.matchMedia === "function" && window.matchMedia("(orientation: landscape)").matches);
  const insets = measureSafeAreaInsets(document);
  const active = resolveIphoneDuoLandscapeQuirk({
    mode,
    isIos: isIphone,
    isIphone,
    isLandscape,
    viewportWidth: window.innerWidth,
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
  try {
    window.localStorage.removeItem(DEVICE_QUIRKS_KEY);
  } catch { /* ignore */ }
  const update = () => {
    syncDeviceQuirks();
  };
  update();
  const raf = window.requestAnimationFrame(update);
  const timer = window.setTimeout(update, 180);
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
  if (ro && probeContainer) {
    for (const child of Array.from(probeContainer.children)) {
      ro.observe(child);
    }
  }
  const vv = window.visualViewport;
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.addEventListener("muse-code-space:device-quirks", update);
  vv?.addEventListener("resize", update);
  return () => {
    window.cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    ro?.disconnect();
    window.removeEventListener("resize", update);
    window.removeEventListener("orientationchange", update);
    window.removeEventListener("muse-code-space:device-quirks", update);
    vv?.removeEventListener("resize", update);
  };
}

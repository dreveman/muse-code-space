// Pure helpers for the Enter-to-submit policy in the message composers.
// No runtime imports: safe to load anywhere (client bundle, probes).
//
// Touch (virtual) keyboards use Enter for newlines — only the send button
// submits. A Bluetooth/hardware keyboard on the same device behaves like a
// desktop: Enter submits. Letter keys look identical from both, so hardware
// presence is inferred from keys a virtual keyboard cannot produce (Tab,
// Escape, function keys). Shift is deliberately excluded: virtual keyboards
// have one. Until such a key is seen, a touch-primary device stays in
// newline mode — the send button always works either way.
//
// Deliberately not part of the decision: visual-viewport height tracking.
// It misreports on real devices (stale or under-threshold readings with the
// software keyboard open) and let a virtual Return submit.

const HARDWARE_ONLY_KEYS = new Set([
  "Tab",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

export function isVirtualKeyboardEnvironment(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches;
}

// True when the on-screen keyboard is visibly open: it shrinks the visual
// viewport well beyond any browser-chrome wobble. An Enter that arrives
// while the virtual keyboard is closed must come from hardware — this is
// the common iPad + Bluetooth case, where docking the keyboard hides the
// on-screen one.
export function isVirtualKeyboardOpen(viewportHeight: number, windowHeight: number): boolean {
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(windowHeight) || windowHeight <= 0) return false;
  return viewportHeight < windowHeight - 150;
}

export function isHardwareKeyEvent(key: string): boolean {
  return HARDWARE_ONLY_KEYS.has(key);
}

export function shouldSubmitOnEnter(args: {
  isComposing: boolean;
  shiftKey: boolean;
  virtualKeyboard?: boolean;
  hardwareKeyboardSeen?: boolean;
  submitOnEnter?: boolean;
}): boolean {
  if (args.isComposing || args.shiftKey) return false;
  if (args.submitOnEnter !== undefined) return args.submitOnEnter;
  if (args.virtualKeyboard && !args.hardwareKeyboardSeen) return false;
  return true;
}

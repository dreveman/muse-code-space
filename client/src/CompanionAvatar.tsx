import { useEffect, useRef, useState } from "react";
import type { CompanionArtwork } from "./companionArtwork";
import { observeElementIntersection } from "./CodeFileLines";

// Pause idle companion WebP animations after 60s without user interaction so
// an unattended visible window does not continuously decode/composite frames.
export const IDLE_MOTION_TIMEOUT_MS = 60_000;
const ACTIVITY_RESET_THROTTLE_MS = 2_000;
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus"] as const;

const motionSubscribers = new Set<(allowed: boolean) => void>();
let idleTimer: number | null = null;
let lastActivityAt = 0;
let userIdle = false;
let reducedMotionMedia: MediaQueryList | null = null;

export function isIdleMotionAllowed(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const reduced = reducedMotionMedia
    ? reducedMotionMedia.matches
    : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return !reduced && !document.hidden && !userIdle;
}

function notifyMotionSubscribers() {
  const allowed = isIdleMotionAllowed();
  for (const fn of motionSubscribers) fn(allowed);
}

function scheduleIdleTimeout() {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  if (typeof document !== "undefined" && document.hidden) {
    idleTimer = null;
    return;
  }
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    if (!userIdle) {
      userIdle = true;
      notifyMotionSubscribers();
    }
  }, IDLE_MOTION_TIMEOUT_MS);
}

function onUserActivity() {
  const now = Date.now();
  if (!userIdle && now - lastActivityAt < ACTIVITY_RESET_THROTTLE_MS) return;
  lastActivityAt = now;
  const wasIdle = userIdle;
  userIdle = false;
  scheduleIdleTimeout();
  if (wasIdle) notifyMotionSubscribers();
}

function onVisibilityOrMediaChange() {
  if (typeof document !== "undefined" && !document.hidden) {
    lastActivityAt = Date.now();
    userIdle = false;
    scheduleIdleTimeout();
  } else if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  notifyMotionSubscribers();
}

export function subscribeIdleMotion(listener: (allowed: boolean) => void): () => void {
  if (motionSubscribers.size === 0 && typeof window !== "undefined" && typeof document !== "undefined") {
    lastActivityAt = Date.now();
    userIdle = false;
    reducedMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionMedia.addEventListener("change", onVisibilityOrMediaChange);
    document.addEventListener("visibilitychange", onVisibilityOrMediaChange);
    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, onUserActivity, { passive: true, capture: true });
    }
    scheduleIdleTimeout();
  }
  motionSubscribers.add(listener);
  listener(isIdleMotionAllowed());
  return () => {
    motionSubscribers.delete(listener);
    if (motionSubscribers.size === 0 && typeof window !== "undefined" && typeof document !== "undefined") {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
      reducedMotionMedia?.removeEventListener("change", onVisibilityOrMediaChange);
      reducedMotionMedia = null;
      document.removeEventListener("visibilitychange", onVisibilityOrMediaChange);
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, onUserActivity, { capture: true });
      }
    }
  };
}

export function CompanionAvatar({ artwork, animate = true, className }: {
  artwork: CompanionArtwork;
  animate?: boolean;
  className?: string;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [inView, setInView] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useEffect(() => {
    if (artwork.portraitIdle === artwork.still) return;
    const stopMotion = subscribeIdleMotion(setMotionAllowed);
    const stopInView = imageRef.current && typeof IntersectionObserver !== "undefined"
      ? observeElementIntersection(imageRef.current, null, "0px", setInView)
      : undefined;
    return () => {
      stopMotion();
      stopInView?.();
    };
  }, [artwork.portraitIdle, artwork.still]);
  const source = animate && motionAllowed && inView ? artwork.portraitIdle : artwork.still;
  return <img ref={imageRef} className={className} src={failedSource === source ? artwork.still : source}
    width={44} height={44} alt="" loading="lazy" decoding="async" onError={() => setFailedSource(source)} />;
}

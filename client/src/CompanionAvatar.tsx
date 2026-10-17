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
const preloadedAnimations = new Set<string>();

type NetworkInfo = {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
};

export function isSlowConnection(): boolean {
  if (typeof navigator !== "undefined") {
    const conn = (navigator as unknown as { connection?: NetworkInfo }).connection;
    if (conn) {
      if (conn.saveData === true) return true;
      if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g" || conn.effectiveType === "3g") return true;
      if (typeof conn.downlink === "number" && conn.downlink > 0 && conn.downlink < 2) return true;
      if (typeof conn.rtt === "number" && conn.rtt >= 150) return true;
    }
  }
  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (let i = 0; i < resources.length; i++) {
      const entry = resources[i]!;
      if (/\.(js|css)(\?|$)/.test(entry.name) && entry.duration > 500) {
        return true;
      }
    }
  }
  return false;
}

export function useProgressiveCompanionImage(stillSource: string, animatedSource: string, motionEnabled: boolean): {
  source: string;
  onStillLoad: () => void;
  onError: () => void;
} {
  const [stillLoaded, setStillLoaded] = useState(() => preloadedAnimations.has(stillSource));
  const [animatedReady, setAnimatedReady] = useState(() => preloadedAnimations.has(animatedSource));
  const [failedSource, setFailedSource] = useState<string | null>(null);

  useEffect(() => {
    setStillLoaded(preloadedAnimations.has(stillSource));
    setAnimatedReady(preloadedAnimations.has(animatedSource));
    setFailedSource(null);
  }, [stillSource, animatedSource]);

  useEffect(() => {
    if (!motionEnabled || !stillLoaded || animatedSource === stillSource || failedSource === animatedSource) return;
    if (preloadedAnimations.has(animatedSource)) {
      setAnimatedReady(true);
      return;
    }
    let cancelled = false;
    let img: HTMLImageElement | null = null;
    const timer = window.setTimeout(() => {
      if (cancelled || isSlowConnection()) return;
      img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (cancelled) return;
        preloadedAnimations.add(animatedSource);
        setAnimatedReady(true);
      };
      img.onerror = () => {
        if (cancelled) return;
        setFailedSource(animatedSource);
      };
      img.src = animatedSource;
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (img) {
        img.onload = null;
        img.onerror = null;
      }
    };
  }, [motionEnabled, stillLoaded, animatedSource, stillSource, failedSource]);

  const useAnimated = motionEnabled && animatedReady && failedSource !== animatedSource;
  const source = useAnimated ? animatedSource : stillSource;
  return {
    source,
    onStillLoad: () => {
      preloadedAnimations.add(stillSource);
      setStillLoaded(true);
    },
    onError: () => {
      if (useAnimated) setFailedSource(animatedSource);
    },
  };
}

export function isIdleMotionAllowed(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (isSlowConnection()) return false;
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
  useEffect(() => {
    if (!animate || artwork.portraitIdle === artwork.still) return;
    const stopMotion = subscribeIdleMotion(setMotionAllowed);
    const stopInView = imageRef.current && typeof IntersectionObserver !== "undefined"
      ? observeElementIntersection(imageRef.current, null, "0px", setInView)
      : undefined;
    return () => {
      stopMotion();
      stopInView?.();
    };
  }, [animate, artwork.portraitIdle, artwork.still]);
  const { source, onStillLoad, onError } = useProgressiveCompanionImage(
    artwork.still,
    artwork.portraitIdle,
    animate && motionAllowed && inView,
  );
  return <img ref={imageRef} className={className} src={source}
    width={44} height={44} alt="" loading="lazy" decoding="async" onLoad={onStillLoad} onError={onError} />;
}

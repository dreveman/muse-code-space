import { useEffect, useRef, useState } from "react";
import type { CompanionArtwork } from "./companionArtwork";
import { observeElementIntersection } from "./CodeFileLines";

// Pause idle companion WebP animations after 60s without user interaction so
// an unattended visible window does not continuously decode/composite frames.
export const IDLE_MOTION_TIMEOUT_MS = 60_000;
const ACTIVITY_RESET_THROTTLE_MS = 2_000;
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus"] as const;

const motionSubscribers = new Set<(allowed: boolean) => void>();
const slowConnectionSubscribers = new Set<(slow: boolean) => void>();
let idleTimer: number | null = null;
let lastActivityAt = 0;
let userIdle = false;
let lastNotifiedAllowed: boolean | null = null;
let lastNotifiedSlow: boolean | null = null;
let reducedMotionMedia: MediaQueryList | null = null;
let resourceObserver: PerformanceObserver | null = null;
const preloadedAnimations = new Set<string>();

export function isAnimationPreloaded(url: string | undefined): boolean {
  if (!url) return false;
  if (preloadedAnimations.has(url)) return true;
  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    const target = url.replace(/^\.\//, "/");
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (let i = resources.length - 1; i >= 0; i--) {
      const entry = resources[i]!;
      if (entry.duration > 0 && (entry.name.endsWith(target) || entry.name.endsWith(url))) {
        preloadedAnimations.add(url);
        return true;
      }
    }
  }
  return false;
}

export function markAnimationPreloaded(url: string | undefined): void {
  if (url) preloadedAnimations.add(url);
}

type NetworkInfo = {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function getNetworkConnection(): NetworkInfo | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as unknown as { connection?: NetworkInfo }).connection;
}

export function isSlowConnection(): boolean {
  const conn = getNetworkConnection();
  if (conn) {
    if (conn.saveData === true) return true;
    if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g" || conn.effectiveType === "3g") return true;
    if (typeof conn.downlink === "number" && conn.downlink > 0 && conn.downlink < 2) return true;
    if (typeof conn.rtt === "number" && conn.rtt >= 150) return true;
  }
  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    // Walk backward from the newest real HTTP network transfer so a fast recent
    // request (after recovering from initial 3G/tunnel conditions) snaps out of
    // slow mode, while ignoring browser-extension or memory-cached (0-byte) hits.
    for (let i = resources.length - 1; i >= 0; i--) {
      const entry = resources[i]!;
      if (entry.duration <= 0) continue;
      if (!entry.name.startsWith("http://") && !entry.name.startsWith("https://")) continue;
      if (entry.name.includes("/__dev/events")) continue;
      if (typeof entry.transferSize === "number" && entry.transferSize === 0) continue;
      if (!/\.(js|css|png|webp)(\?|$)/.test(entry.name) && !entry.name.includes("/actions")) continue;
      if (entry.duration < 250) return false;
      if (entry.duration > 500) return true;
    }
  }
  return false;
}

export function subscribeSlowConnection(listener: (slow: boolean) => void): () => void {
  slowConnectionSubscribers.add(listener);
  listener(isSlowConnection());
  return () => {
    slowConnectionSubscribers.delete(listener);
  };
}

export function useProgressiveCompanionImage(stillSource: string, animatedSource: string, motionEnabled: boolean): {
  source: string;
  onStillLoad: () => void;
  onError: () => void;
} {
  const [stillLoaded, setStillLoaded] = useState(() => isAnimationPreloaded(stillSource));
  const [animatedReady, setAnimatedReady] = useState(() => isAnimationPreloaded(animatedSource));
  const [slowConnection, setSlowConnection] = useState(isSlowConnection);
  const [failedSource, setFailedSource] = useState<string | null>(null);

  useEffect(() => subscribeSlowConnection(setSlowConnection), []);

  useEffect(() => {
    setStillLoaded(isAnimationPreloaded(stillSource));
    setAnimatedReady(isAnimationPreloaded(animatedSource));
    setFailedSource(null);
  }, [stillSource, animatedSource]);

  useEffect(() => {
    if (!motionEnabled || !stillLoaded || animatedSource === stillSource || failedSource === animatedSource) return;
    if (isAnimationPreloaded(animatedSource)) {
      setAnimatedReady(true);
      return;
    }
    if (slowConnection) return;
    let cancelled = false;
    let img: HTMLImageElement | null = null;
    const timer = window.setTimeout(() => {
      if (cancelled || isSlowConnection()) return;
      img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (cancelled) return;
        markAnimationPreloaded(animatedSource);
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
  }, [motionEnabled, stillLoaded, slowConnection, animatedSource, stillSource, failedSource]);

  const useAnimated = motionEnabled && animatedReady && failedSource !== animatedSource;
  const source = useAnimated ? animatedSource : stillSource;
  return {
    source,
    onStillLoad: () => {
      markAnimationPreloaded(stillSource);
      setStillLoaded(true);
    },
    onError: () => {
      if (useAnimated) setFailedSource(animatedSource);
    },
  };
}

export function isIdleMotionAllowed(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const reduced = reducedMotionMedia
    ? reducedMotionMedia.matches
    : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return !reduced && !document.hidden && !userIdle;
}

function notifyMotionSubscribers() {
  const allowed = isIdleMotionAllowed();
  if (allowed !== lastNotifiedAllowed) {
    lastNotifiedAllowed = allowed;
    for (const fn of motionSubscribers) fn(allowed);
  }
  const slow = isSlowConnection();
  if (slow !== lastNotifiedSlow) {
    lastNotifiedSlow = slow;
    for (const fn of slowConnectionSubscribers) fn(slow);
  }
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
  if (!userIdle && lastNotifiedAllowed === true && now - lastActivityAt < ACTIVITY_RESET_THROTTLE_MS) return;
  lastActivityAt = now;
  userIdle = false;
  scheduleIdleTimeout();
  notifyMotionSubscribers();
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
    lastNotifiedAllowed = isIdleMotionAllowed();
    lastNotifiedSlow = isSlowConnection();
    reducedMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionMedia.addEventListener("change", onVisibilityOrMediaChange);
    getNetworkConnection()?.addEventListener?.("change", onVisibilityOrMediaChange);
    if (typeof PerformanceObserver !== "undefined") {
      try {
        resourceObserver = new PerformanceObserver(() => {
          notifyMotionSubscribers();
        });
        resourceObserver.observe({ type: "resource", buffered: false });
      } catch {
        resourceObserver = null;
      }
    }
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
      lastNotifiedAllowed = null;
      lastNotifiedSlow = null;
      reducedMotionMedia?.removeEventListener("change", onVisibilityOrMediaChange);
      reducedMotionMedia = null;
      getNetworkConnection()?.removeEventListener?.("change", onVisibilityOrMediaChange);
      resourceObserver?.disconnect();
      resourceObserver = null;
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

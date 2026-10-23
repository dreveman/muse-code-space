import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { companionArtwork } from "./companionArtwork";
import {
  isAnimationPreloaded,
  isIdleMotionAllowed,
  isSlowConnection,
  markAnimationPreloaded,
  subscribeIdleMotion,
  subscribeSlowConnection,
} from "./CompanionAvatar";
import { companionForName } from "./companionRoster";

function CompanionPortrait({ source, stillSource, crossFade, onError }: {
  source: string;
  stillSource?: string;
  crossFade: boolean;
  onError: () => void;
}) {
  const baseLayer = stillSource ?? source;
  const startShown = isAnimationPreloaded(source) ? source : baseLayer;
  const [layers, setLayers] = useState<string[]>(() => {
    const initial = [baseLayer];
    if (source !== baseLayer) initial.push(source);
    return initial;
  });
  const [shown, setShown] = useState(startShown);
  const loaded = useRef(new Set<string>([baseLayer, ...(isAnimationPreloaded(source) ? [source] : [])]));

  useLayoutEffect(() => {
    loaded.current.add(baseLayer);
    const sourceReady = loaded.current.has(source) || isAnimationPreloaded(source);
    if (sourceReady) {
      loaded.current.add(source);
      setShown(source);
    }
    setLayers((current) => {
      if (!crossFade && sourceReady) {
        return source === baseLayer ? [baseLayer] : [baseLayer, source];
      }
      const next = current.includes(baseLayer) ? [...current] : [baseLayer, ...current];
      if (!next.includes(source)) next.push(source);
      return next;
    });
  }, [source, baseLayer, crossFade]);

  useEffect(() => {
    // Retire outgoing animated layers after the 640ms fade so their animations
    // stop, while keeping `baseLayer` (still.png) permanently mounted underneath.
    const timer = window.setTimeout(() => {
      setLayers((current) => {
        const filtered = current.filter((layer) => layer === baseLayer || layer === shown || layer === source);
        return filtered.length === current.length ? current : filtered;
      });
    }, 660);
    return () => window.clearTimeout(timer);
  }, [shown, source, baseLayer]);

  return <span className="transcript-companion-portrait" aria-hidden="true">
    {layers.map((layer) => <img key={layer} className="transcript-companion-image"
      src={layer} width={64} height={64} alt="" decoding={isAnimationPreloaded(layer) ? "sync" : "async"}
      style={{ opacity: layer === baseLayer || layer === shown ? 1 : 0 }}
      onLoad={(event) => {
        loaded.current.add(layer);
        markAnimationPreloaded(layer, event.currentTarget);
        if (layer !== source) return;
        // Establish the starting opacity even when the image is cached.
        void getComputedStyle(event.currentTarget).opacity;
        setShown(layer);
      }}
      onError={() => {
        if (layer === source) {
          setShown(baseLayer);
          onError();
        }
      }} />)}
  </span>;
}

export const TranscriptCompanion = memo(function TranscriptCompanion({ name, active, starting, activity, visible, archived = false, connecting = false }: {
  name: string;
  active: boolean;
  starting: boolean;
  activity: string;
  visible: boolean;
  archived?: boolean;
  connecting?: boolean;
}) {
  const artwork = companionArtwork[companionForName(name)?.id ?? ""];
  // Choose the first frame before mounting the image. Starting with a still
  // would briefly show the idle pose before the wake-up animation.
  const [motionAllowed, setMotionAllowed] = useState(() =>
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches && !document.hidden);
  const [idleMotionAllowed, setIdleMotionAllowed] = useState(isIdleMotionAllowed);
  const [slowConnection, setSlowConnection] = useState(isSlowConnection);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionAllowed(!media.matches && !document.hidden);
    update();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    const stopIdle = subscribeIdleMotion(setIdleMotionAllowed);
    const stopSlow = subscribeSlowConnection(setSlowConnection);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      stopIdle();
      stopSlow();
    };
  }, []);
  const animation = starting ? "waking" : active ? "working" : "idle";
  const animatedSource = artwork && (animation === "idle" ? artwork.portraitIdle : artwork[animation]);
  const canLoadAnimated = !slowConnection || isAnimationPreloaded(animatedSource);
  const canAnimate = (animation === "idle" ? idleMotionAllowed : motionAllowed) && canLoadAnimated && visible && !archived;
  const source = artwork && (canAnimate ? animatedSource : artwork.still);
  const imageSource = failedSource === source ? artwork?.still : source;
  const activityLabel = activity === "Thinking" ? "is thinking"
    : activity === "Typing" ? "is typing"
    : activity.startsWith("Running ") ? `is running ${activity.slice(8)}` : activity;
  const label = connecting ? "is connecting" : archived ? "archived task" : starting ? "is waking up" : active ? activityLabel : name;
  const showActivity = connecting || archived || active || starting;
  return (
    <div className="transcript-companion" data-animation={archived ? "archived" : animation}>
      {imageSource && <CompanionPortrait source={imageSource}
        stillSource={artwork?.still ?? imageSource}
        crossFade={motionAllowed && visible && !archived}
        onError={() => setFailedSource(source ?? null)} />}
      <span className="transcript-companion-label" role="status" aria-live="polite" aria-atomic="true"
        aria-label={showActivity ? `${name}: ${label}` : name}>
        <span className="transcript-companion-name">{name}</span>
        {showActivity && <span className="transcript-companion-activity">
          <span className="transcript-companion-activity-text">{label}</span>
        </span>}
      </span>
    </div>
  );
});

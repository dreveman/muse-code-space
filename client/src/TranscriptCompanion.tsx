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

function CompanionPortrait({ source, initialSource, crossFade, onError }: {
  source: string;
  initialSource?: string;
  crossFade: boolean;
  onError: () => void;
}) {
  const startSource = initialSource && crossFade && initialSource !== source ? initialSource : source;
  const [layers, setLayers] = useState(() => startSource !== source ? [startSource, source] : [source]);
  const [shown, setShown] = useState(startSource);
  const loaded = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (!crossFade) {
      if (layers.length !== 1 || layers[0] !== source) setLayers([source]);
      setShown(source);
    } else if (!layers.includes(source)) {
      setLayers([...layers, source]);
    } else if (loaded.current.has(source)) {
      // A rapid state change can return to an image that's still fading out.
      setShown(source);
    }
  }, [source, crossFade, layers]);
  useEffect(() => {
    // Retire outgoing images after the 640ms fade so their animations stop.
    const timer = window.setTimeout(() => {
      setLayers((current) => current.filter((layer) => layer === shown || layer === source));
    }, 660);
    return () => window.clearTimeout(timer);
  }, [shown, source]);
  return <span className="transcript-companion-portrait" aria-hidden="true">
    {layers.map((layer) => <img key={layer} className="transcript-companion-image"
      src={layer} width={64} height={64} alt="" decoding="async"
      style={{ opacity: layer === shown ? 1 : 0 }}
      onLoad={(event) => {
        loaded.current.add(layer);
        markAnimationPreloaded(layer);
        if (layer !== source) return;
        // Establish the starting opacity even when the image is cached.
        void getComputedStyle(event.currentTarget).opacity;
        setShown(layer);
      }}
      onError={() => { if (layer === source) onError(); }} />)}
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
        initialSource={starting ? imageSource : (artwork?.still ?? imageSource)}
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

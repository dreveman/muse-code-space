import { useEffect, useRef, useState } from "react";
import type { CompanionArtwork } from "./companionArtwork";
import { observeElementIntersection } from "./CodeFileLines";

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
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionAllowed(!media.matches && !document.hidden);
    update();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    const stop = imageRef.current && typeof IntersectionObserver !== "undefined"
      ? observeElementIntersection(imageRef.current, null, "0px", setInView)
      : undefined;
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      stop?.();
    };
  }, [artwork.portraitIdle, artwork.still]);
  const source = animate && motionAllowed && inView ? artwork.portraitIdle : artwork.still;
  return <img ref={imageRef} className={className} src={failedSource === source ? artwork.still : source}
    width={44} height={44} alt="" loading="lazy" decoding="async" onError={() => setFailedSource(source)} />;
}

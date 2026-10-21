import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "./api";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 1000) / 1000));
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
      <path d="M13.476.516c.42 0 .762.34.762.762v2.744c0 .421-.341.762-.762.762H10.81a.762.762 0 1 1 0-1.524h.995a6.1 6.1 0 1 0 2.44 4.88.762.762 0 0 1 1.524 0 7.624 7.624 0 1 1-3.054-6.102v-.76c0-.421.341-.762.762-.762z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
    </svg>
  );
}

export function isWorkspaceImagePath(rawPath: string): boolean {
  const cleaned = rawPath.trim().replace(/[?#].*$/, "");
  return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(cleaned);
}

export function ImageTab({
  sessionId,
  path,
  initialSrc = null,
  title,
}: {
  sessionId: string;
  path?: string | null;
  initialSrc?: string | null;
  title?: string;
}) {
  const displayTitle = title || path || "Image";
  const [revision, setRevision] = useState(0);
  const [src, setSrc] = useState<string | null>(initialSrc);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path && !initialSrc));
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<{
    mode: "none" | "pan" | "pinch";
    startScale: number;
    startPanX: number;
    startPanY: number;
    startX: number;
    startY: number;
    startDist: number;
    lastTapAt: number;
  }>({
    mode: "none",
    startScale: 1,
    startPanX: 0,
    startPanY: 0,
    startX: 0,
    startY: 0,
    startDist: 1,
    lastTapAt: 0,
  });

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [sessionId, path, initialSrc]);

  useEffect(() => {
    if (!path || (initialSrc && revision === 0)) {
      setSrc(initialSrc);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .readSessionImage({ session_id: sessionId, path })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.media_type && res.base64_data) {
          setSrc(`data:${res.media_type};base64,${res.base64_data}`);
          setError(null);
        } else {
          setSrc(null);
          setError(res.error ?? "Image could not be opened.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSrc(null);
          setError("Image could not be opened. Try Refresh.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, initialSrc, revision]);

  // Support trackpad pinch (`event.ctrlKey`) and mouse-wheel zoom centered on the cursor.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cx = event.clientX - (rect.left + rect.width / 2);
      const cy = event.clientY - (rect.top + rect.height / 2);
      const delta = event.ctrlKey || event.metaKey ? -event.deltaY * 0.01 : -event.deltaY * 0.0025;
      const factor = Math.exp(delta);
      setScale((prevScale) => {
        const nextScale = clampScale(prevScale * factor);
        const ratio = nextScale / prevScale;
        setPan((prevPan) => ({
          x: cx - (cx - prevPan.x) * ratio,
          y: cy - (cy - prevPan.y) * ratio,
        }));
        return nextScale;
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const resetZoom = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const stepZoom = (factor: number) => {
    setScale((prev) => {
      const next = clampScale(prev * factor);
      if (Math.abs(next - 1) < 0.02) {
        setPan({ x: 0, y: 0 });
        return 1;
      }
      return next;
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const stage = stageRef.current;
    if (!stage) return;
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {}
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pts = Array.from(pointersRef.current.values());
    const g = gestureRef.current;

    if (pts.length === 1) {
      const now = Date.now();
      if (now - g.lastTapAt < 280) {
        g.lastTapAt = 0;
        if (scale > 1.05) {
          resetZoom();
        } else {
          const rect = stage.getBoundingClientRect();
          const cx = event.clientX - (rect.left + rect.width / 2);
          const cy = event.clientY - (rect.top + rect.height / 2);
          const targetScale = 2.25;
          setScale(targetScale);
          setPan({ x: -cx * (targetScale - 1), y: -cy * (targetScale - 1) });
        }
        return;
      }
      g.lastTapAt = now;
      g.mode = "pan";
      g.startX = event.clientX;
      g.startY = event.clientY;
      g.startPanX = pan.x;
      g.startPanY = pan.y;
      setDragging(true);
    } else if (pts.length >= 2) {
      const [p1, p2] = pts;
      const dist = Math.max(8, Math.hypot(p2!.x - p1!.x, p2!.y - p1!.y));
      const midX = (p1!.x + p2!.x) / 2;
      const midY = (p1!.y + p2!.y) / 2;
      g.mode = "pinch";
      g.startDist = dist;
      g.startScale = scale;
      g.startX = midX;
      g.startY = midY;
      g.startPanX = pan.x;
      g.startPanY = pan.y;
      setDragging(true);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pts = Array.from(pointersRef.current.values());
    const g = gestureRef.current;
    const stage = stageRef.current;
    if (!stage) return;

    if (g.mode === "pinch" && pts.length >= 2) {
      const [p1, p2] = pts;
      const dist = Math.max(8, Math.hypot(p2!.x - p1!.x, p2!.y - p1!.y));
      const midX = (p1!.x + p2!.x) / 2;
      const midY = (p1!.y + p2!.y) / 2;
      const nextScale = clampScale(g.startScale * (dist / g.startDist));
      const rect = stage.getBoundingClientRect();
      const anchorX = g.startX - (rect.left + rect.width / 2);
      const anchorY = g.startY - (rect.top + rect.height / 2);
      const ratio = nextScale / g.startScale;
      setScale(nextScale);
      setPan({
        x: anchorX - (anchorX - g.startPanX) * ratio + (midX - g.startX),
        y: anchorY - (anchorY - g.startPanY) * ratio + (midY - g.startY),
      });
    } else if (g.mode === "pan" && pts.length === 1) {
      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;
      setPan({ x: g.startPanX + dx, y: g.startPanY + dy });
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    const pts = Array.from(pointersRef.current.values());
    const g = gestureRef.current;
    if (pts.length === 1) {
      g.mode = "pan";
      g.startX = pts[0]!.x;
      g.startY = pts[0]!.y;
      g.startPanX = pan.x;
      g.startPanY = pan.y;
    } else if (pts.length === 0) {
      g.mode = "none";
      setDragging(false);
    }
  };

  const download = () => {
    if (!src) return;
    const link = document.createElement("a");
    link.href = src;
    link.download = displayTitle.split("/").at(-1) || "image.png";
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  };

  return (
    <div className="file-tab-view image-tab-view">
      <div className="file-tab-toolbar">
        <span title={displayTitle}>{displayTitle}</span>
        <div className="file-tab-actions image-tab-actions">
          <button
            type="button"
            onClick={() => stepZoom(1 / 1.25)}
            disabled={loading || !src || scale <= MIN_SCALE}
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="image-zoom-readout"
            onClick={resetZoom}
            disabled={loading || !src}
            aria-label="Reset zoom"
            title="Reset zoom (100%)"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => stepZoom(1.25)}
            disabled={loading || !src || scale >= MAX_SCALE}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          {path && (
            <button
              type="button"
              onClick={() => setRevision((v) => v + 1)}
              disabled={loading}
              aria-label="Refresh image"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
          )}
          <button
            type="button"
            onClick={download}
            disabled={loading || !src}
            aria-label="Download image"
            title="Download"
          >
            <DownloadIcon />
          </button>
        </div>
      </div>
      {loading && <p role="status">Opening image…</p>}
      {error && !loading && <p role="alert">{error}</p>}
      {!loading && src && (
        <div
          ref={stageRef}
          className={`image-viewer-stage${dragging ? " dragging" : ""}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <img
            className="image-viewer-img"
            src={src}
            alt={displayTitle}
            draggable={false}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
            }}
          />
        </div>
      )}
    </div>
  );
}

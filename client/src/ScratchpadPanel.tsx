import { memo, useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";

export type ScratchpadTool = "pen" | "highlighter" | "line" | "arrow" | "rect" | "circle" | "eraser";
export type ScratchpadBackground = "grid" | "dots" | "blank";

export type ScratchpadPoint = {
  x: number;
  y: number;
  pressure: number;
};

export type ScratchpadStroke = {
  tool: ScratchpadTool;
  color: string;
  size: number;
  points: ScratchpadPoint[];
};

export type ScratchpadTargetStep = {
  userInputId: string;
  questionId: string;
  header: string;
};

export type ScratchpadBaseImage = {
  src: string;
  name: string;
  attachmentId?: string | null;
};

export type ScratchpadAttachmentPayload = {
  name: string;
  mediaType: string;
  base64Data: string;
  dataUrl: string;
};

const PALETTE = [
  { id: "ink", label: "Ink", color: "#1e2326" },
  { id: "blue", label: "Blue", color: "#1d74f5" },
  { id: "green", label: "Green", color: "#18a957" },
  { id: "amber", label: "Amber", color: "#e08b18" },
  { id: "red", label: "Red", color: "#e03e3e" },
  { id: "purple", label: "Purple", color: "#8a4fff" },
  { id: "white", label: "White", color: "#ffffff" },
] as const;

const SIZES = [
  { id: "fine", label: "Fine", size: 2.25 },
  { id: "medium", label: "Medium", size: 4.5 },
  { id: "bold", label: "Bold", size: 8.5 },
] as const;

const sessionStrokesCache = new Map<string, {
  strokes: ScratchpadStroke[];
  redo: ScratchpadStroke[];
  background: ScratchpadBackground;
  baseImage: ScratchpadBaseImage | null;
}>();

export function ScratchpadTabIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 5H6a2.5 2.5 0 0 0-2.5 2.5v11A2.5 2.5 0 0 0 6 21h11a2.5 2.5 0 0 0 2.5-2.5V11" />
      <path d="M9.5 15.5l1.2-4.2L17.8 4.2a2.12 2.12 0 0 1 3 3l-7.1 7.1-4.2 1.2z" />
    </svg>
  );
}

export function NewScratchpadButton({
  active = false,
  onOpen,
}: {
  active?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`terminal-toggle${active ? " active" : ""}`}
      onClick={onOpen}
      aria-label="Open scratchpad"
      title="Scratchpad — draw or annotate images with touch or Apple Pencil"
    >
      <ScratchpadTabIcon />
    </button>
  );
}

function computeContainRect(
  stageW: number,
  stageH: number,
  imgW: number,
  imgH: number,
  pad = 16,
): { x: number; y: number; w: number; h: number } {
  const availW = Math.max(40, stageW - pad * 2);
  const availH = Math.max(40, stageH - pad * 2);
  const safeImgW = Math.max(1, imgW);
  const safeImgH = Math.max(1, imgH);
  const scale = Math.min(availW / safeImgW, availH / safeImgH);
  const w = Math.round(safeImgW * scale);
  const h = Math.round(safeImgH * scale);
  const x = Math.round((stageW - w) / 2);
  const y = Math.round((stageH - h) / 2);
  return { x, y, w, h };
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  background: ScratchpadBackground,
  imageEl: HTMLImageElement | null = null,
) {
  ctx.save();
  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(0, 0, width, height);

  if (background === "grid") {
    const step = 24;
    ctx.strokeStyle = "rgba(20, 26, 31, 0.075)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = step; x < width; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = step; y < height; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();
  } else if (background === "dots") {
    const step = 24;
    ctx.fillStyle = "rgba(20, 26, 31, 0.16)";
    for (let x = step; x < width; x += step) {
      for (let y = step; y < height; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, 1.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (imageEl && imageEl.complete && (imageEl.naturalWidth > 0 || imageEl.width > 0)) {
    const natW = imageEl.naturalWidth || imageEl.width || 300;
    const natH = imageEl.naturalHeight || imageEl.height || 200;
    const rect = computeContainRect(width, height, natW, natH, 16);
    ctx.drawImage(imageEl, rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: ScratchpadStroke) {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.lineWidth = stroke.size * 3.2;
  } else if (stroke.tool === "highlighter") {
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size * 2.8;
  } else {
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
  }

  const first = pts[0]!;
  const last = pts[pts.length - 1]!;

  if (stroke.tool === "line" || stroke.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    if (stroke.tool === "arrow") {
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      const headLen = Math.max(10, stroke.size * 3.2);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(
        last.x - headLen * Math.cos(angle - Math.PI / 6),
        last.y - headLen * Math.sin(angle - Math.PI / 6),
      );
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(
        last.x - headLen * Math.cos(angle + Math.PI / 6),
        last.y - headLen * Math.sin(angle + Math.PI / 6),
      );
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (stroke.tool === "rect") {
    ctx.beginPath();
    ctx.strokeRect(
      Math.min(first.x, last.x),
      Math.min(first.y, last.y),
      Math.abs(last.x - first.x),
      Math.abs(last.y - first.y),
    );
    ctx.restore();
    return;
  }

  if (stroke.tool === "circle") {
    const rx = Math.abs(last.x - first.x) / 2;
    const ry = Math.abs(last.y - first.y) / 2;
    const cx = (first.x + last.x) / 2;
    const cy = (first.y + last.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (pts.length === 1) {
    const r = Math.max(1, (stroke.size * (0.65 + first.pressure * 0.7)) / 2);
    ctx.beginPath();
    ctx.arc(first.x, first.y, r, 0, Math.PI * 2);
    if (stroke.tool === "eraser") {
      ctx.fill();
    } else {
      ctx.fillStyle = stroke.color;
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  const avgPressure = pts.reduce((acc, p) => acc + p.pressure, 0) / pts.length;
  if (stroke.tool === "pen") {
    ctx.lineWidth = stroke.size * (0.65 + avgPressure * 0.7);
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const curr = pts[i]!;
    const next = pts[i + 1]!;
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
  }
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();
}

export const ScratchpadView = memo(function ScratchpadView({
  sessionId,
  active,
  targetStep = null,
  initialBackground = "grid",
  initialBaseImage = null,
  onClearBaseImage,
  onAttachToStep,
  onAttachToComposer,
  onUpdateComposerAttachment,
}: {
  sessionId: string;
  active: boolean;
  targetStep?: ScratchpadTargetStep | null;
  initialBackground?: ScratchpadBackground;
  initialBaseImage?: ScratchpadBaseImage | null;
  onClearBaseImage?: () => void;
  onAttachToStep?: (target: ScratchpadTargetStep, attachment: ScratchpadAttachmentPayload) => void;
  onAttachToComposer?: (attachment: ScratchpadAttachmentPayload) => void;
  onUpdateComposerAttachment?: (attachmentId: string, attachment: ScratchpadAttachmentPayload) => void;
}) {
  const cached = sessionStrokesCache.get(sessionId);
  const [strokes, setStrokes] = useState<ScratchpadStroke[]>(() => cached?.strokes ?? []);
  const [redoStack, setRedoStack] = useState<ScratchpadStroke[]>(() => cached?.redo ?? []);
  const [tool, setTool] = useState<ScratchpadTool>("pen");
  const [color, setColor] = useState<string>(PALETTE[4].color); // Red default when annotating, or Ink
  const [size, setSize] = useState<number>(SIZES[1].size);
  const [background, setBackground] = useState<ScratchpadBackground>(() => cached?.background ?? initialBackground);
  const [baseImage, setBaseImage] = useState<ScratchpadBaseImage | null>(() => initialBaseImage ?? cached?.baseImage ?? null);
  const [loadedImageEl, setLoadedImageEl] = useState<HTMLImageElement | null>(null);
  const [penOnly, setPenOnly] = useState(false);
  const [penDetected, setPenDetected] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const fileInputId = useId();

  const stageRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeStrokeRef = useRef<ScratchpadStroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const prevBaseSrcRef = useRef<string | null>(baseImage?.src ?? null);
  const canvasSizeRef = useRef<{ width: number; height: number; dpr: number }>({
    width: 640,
    height: 440,
    dpr: 1,
  });

  useEffect(() => {
    setBackground((curr) => (initialBackground && initialBackground !== curr ? initialBackground : curr));
  }, [initialBackground]);

  useEffect(() => {
    if (!initialBaseImage) return;
    if (initialBaseImage.src !== prevBaseSrcRef.current) {
      prevBaseSrcRef.current = initialBaseImage.src;
      setBaseImage(initialBaseImage);
      setStrokes([]);
      setRedoStack([]);
    } else {
      setBaseImage(initialBaseImage);
    }
  }, [initialBaseImage]);

  useEffect(() => {
    if (!baseImage?.src) {
      setLoadedImageEl(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setLoadedImageEl(img);
    };
    img.onerror = () => {
      if (!cancelled) setLoadedImageEl(null);
    };
    img.src = baseImage.src;
    return () => {
      cancelled = true;
    };
  }, [baseImage?.src]);

  useEffect(() => {
    sessionStrokesCache.set(sessionId, { strokes, redo: redoStack, background, baseImage });
  }, [sessionId, strokes, redoStack, background, baseImage]);

  const redrawAll = useCallback(() => {
    const bgCanvas = bgCanvasRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!bgCanvas || !inkCanvas) return;
    const { width, height, dpr } = canvasSizeRef.current;
    const bgCtx = bgCanvas.getContext("2d");
    const inkCtx = inkCanvas.getContext("2d");
    if (!bgCtx || !inkCtx) return;

    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground(bgCtx, width, height, background, loadedImageEl);

    inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    inkCtx.clearRect(0, 0, width, height);
    for (const s of strokes) {
      drawStroke(inkCtx, s);
    }
    if (activeStrokeRef.current) {
      drawStroke(inkCtx, activeStrokeRef.current);
    }
  }, [strokes, background, loadedImageEl]);

  useEffect(() => {
    const stage = stageRef.current;
    const bgCanvas = bgCanvasRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!stage || !bgCanvas || !inkCanvas) return;

    const updateSize = () => {
      const rect = stage.getBoundingClientRect();
      const width = Math.max(280, Math.floor(rect.width));
      const height = Math.max(240, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvasSizeRef.current = { width, height, dpr };
      for (const canvas of [bgCanvas, inkCanvas]) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      redrawAll();
    };

    updateSize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateSize) : null;
    ro?.observe(stage);
    window.addEventListener("resize", updateSize);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, [redrawAll, active]);

  useEffect(() => {
    redrawAll();
  }, [redrawAll]);

  const undo = useCallback(() => {
    setStrokes((curr) => {
      if (curr.length === 0) return curr;
      const last = curr[curr.length - 1]!;
      setRedoStack((r) => [...r, last]);
      return curr.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((curr) => {
      if (curr.length === 0) return curr;
      const next = curr[curr.length - 1]!;
      setStrokes((s) => [...s, next]);
      return curr.slice(0, -1);
    });
  }, []);

  const clearCanvas = () => {
    if (strokes.length === 0) return;
    setRedoStack([]);
    setStrokes([]);
  };

  const removeBaseImage = () => {
    prevBaseSrcRef.current = null;
    setBaseImage(null);
    setLoadedImageEl(null);
    onClearBaseImage?.();
  };

  const loadFileAsBaseImage = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) return;
      prevBaseSrcRef.current = result;
      setBaseImage({ src: result, name: file.name || "image.png", attachmentId: null });
      setStrokes([]);
      setRedoStack([]);
    };
    reader.readAsDataURL(file);
  };

  const handleLoadImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) loadFileAsBaseImage(file);
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (event.shiftKey) {
          event.preventDefault();
          redo();
        } else {
          event.preventDefault();
          undo();
        }
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files[0]) {
        event.preventDefault();
        loadFileAsBaseImage(files[0]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, [active, undo, redo]);

  const pointFromEvent = (
    canvas: HTMLCanvasElement,
    e: { clientX: number; clientY: number; pressure?: number; pointerType?: string },
  ): ScratchpadPoint => {
    const rect = canvas.getBoundingClientRect();
    const pressure =
      e.pointerType === "pen" && typeof e.pressure === "number" && e.pressure > 0
        ? e.pressure
        : 0.5;
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure,
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (event.pointerType === "pen" && !penDetected) {
      setPenDetected(true);
    }
    if (penOnly && event.pointerType === "touch") {
      return;
    }
    event.preventDefault();
    const canvas = inkCanvasRef.current;
    if (!canvas) return;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch { /* ignore */ }
    activePointerIdRef.current = event.pointerId;
    const pt = pointFromEvent(canvas, event);
    activeStrokeRef.current = {
      tool,
      color,
      size,
      points: [pt],
    };
    redrawAll();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId || !activeStrokeRef.current) return;
    event.preventDefault();
    const canvas = inkCanvasRef.current;
    if (!canvas) return;
    const stroke = activeStrokeRef.current;
    const nativeEvent = event.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const coalesced = typeof nativeEvent.getCoalescedEvents === "function" ? nativeEvent.getCoalescedEvents() : null;
    if (
      (stroke.tool === "pen" || stroke.tool === "highlighter" || stroke.tool === "eraser") &&
      coalesced &&
      coalesced.length > 0
    ) {
      for (const ce of coalesced) {
        stroke.points.push(pointFromEvent(canvas, ce));
      }
    } else if (stroke.tool === "line" || stroke.tool === "arrow" || stroke.tool === "rect" || stroke.tool === "circle") {
      stroke.points = [stroke.points[0]!, pointFromEvent(canvas, event)];
    } else {
      stroke.points.push(pointFromEvent(canvas, event));
    }
    redrawAll();
  };

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId || !activeStrokeRef.current) return;
    event.preventDefault();
    try {
      inkCanvasRef.current?.releasePointerCapture(event.pointerId);
    } catch { /* ignore */ }
    const finished = activeStrokeRef.current;
    activeStrokeRef.current = null;
    activePointerIdRef.current = null;
    setStrokes((curr) => [...curr.slice(-60), finished]);
    setRedoStack([]);
  };

  const exportCompositePng = (): ScratchpadAttachmentPayload | null => {
    const { width, height, dpr } = canvasSizeRef.current;
    const out = document.createElement("canvas");

    if (loadedImageEl && (loadedImageEl.naturalWidth > 0 || loadedImageEl.width > 0)) {
      const natW = Math.max(1, loadedImageEl.naturalWidth || loadedImageEl.width);
      const natH = Math.max(1, loadedImageEl.naturalHeight || loadedImageEl.height);
      const rect = computeContainRect(width, height, natW, natH, 16);
      out.width = natW;
      out.height = natH;
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(loadedImageEl, 0, 0, natW, natH);

      if (strokes.length > 0 && rect.w > 0 && rect.h > 0) {
        const inkLayer = document.createElement("canvas");
        inkLayer.width = natW;
        inkLayer.height = natH;
        const inkCtx = inkLayer.getContext("2d");
        if (inkCtx) {
          const scaleX = natW / rect.w;
          const scaleY = natH / rect.h;
          const strokeScale = (scaleX + scaleY) / 2;
          for (const s of strokes) {
            drawStroke(inkCtx, {
              ...s,
              size: s.size * strokeScale,
              points: s.points.map((pt) => ({
                x: (pt.x - rect.x) * scaleX,
                y: (pt.y - rect.y) * scaleY,
                pressure: pt.pressure,
              })),
            });
          }
          ctx.drawImage(inkLayer, 0, 0, natW, natH);
        }
      }
    } else {
      out.width = Math.floor(width * dpr);
      out.height = Math.floor(height * dpr);
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBackground(ctx, width, height, background, null);
      if (inkCanvasRef.current) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(inkCanvasRef.current, 0, 0);
      }
    }

    const dataUrl = out.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    const base64Data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
    if (!base64Data) return null;
    const baseStem = baseImage?.name ? baseImage.name.replace(/\.[^.]+$/, "") : "sketch";
    return {
      name: baseImage?.name || `${baseStem}-annotated-${Date.now()}.png`,
      mediaType: "image/png",
      base64Data,
      dataUrl,
    };
  };

  const hasContent = strokes.length > 0 || Boolean(loadedImageEl);

  const handleUseInStep = () => {
    if (!targetStep || !onAttachToStep) return;
    const payload = exportCompositePng();
    if (!payload) return;
    onAttachToStep(targetStep, payload);
    setStatusMessage(`Attached to "${targetStep.header}"`);
    window.setTimeout(() => setStatusMessage(null), 2200);
  };

  const handleUpdateExistingAttachment = () => {
    if (!baseImage?.attachmentId || !onUpdateComposerAttachment) return;
    const payload = exportCompositePng();
    if (!payload) return;
    prevBaseSrcRef.current = payload.dataUrl;
    setBaseImage((prev) => (prev ? { ...prev, src: payload.dataUrl } : prev));
    setStrokes([]);
    setRedoStack([]);
    onUpdateComposerAttachment(baseImage.attachmentId, payload);
    setStatusMessage(`Updated "${baseImage.name}" in message composer`);
    window.setTimeout(() => setStatusMessage(null), 2200);
  };

  const handleAttachToComposer = () => {
    if (!onAttachToComposer) return;
    const payload = exportCompositePng();
    if (!payload) return;
    onAttachToComposer(payload);
    setStatusMessage("Attached annotated image to message composer");
    window.setTimeout(() => setStatusMessage(null), 2200);
  };

  const handleDownload = () => {
    const payload = exportCompositePng();
    if (!payload) return;
    const a = document.createElement("a");
    a.href = payload.dataUrl;
    a.download = payload.name;
    a.click();
  };

  return (
    <div className="scratchpad-panel">
      <header className="scratchpad-toolbar" role="toolbar" aria-label="Scratchpad drawing tools">
        <div className="scratchpad-tool-group" role="group" aria-label="Drawing mode">
          {(
            [
              ["pen", "Pen"],
              ["highlighter", "Marker"],
              ["line", "Line"],
              ["arrow", "Arrow"],
              ["rect", "Box"],
              ["circle", "Oval"],
              ["eraser", "Eraser"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`scratchpad-tool-btn${tool === id ? " is-active" : ""}`}
              aria-pressed={tool === id}
              onClick={() => setTool(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="scratchpad-tool-group" role="group" aria-label="Stroke color">
          {PALETTE.map((swatch) => (
            <button
              key={swatch.id}
              type="button"
              className={`scratchpad-color-swatch${color === swatch.color && tool !== "eraser" ? " is-active" : ""}`}
              style={{ "--swatch-color": swatch.color } as React.CSSProperties}
              aria-label={`Color: ${swatch.label}`}
              title={swatch.label}
              onClick={() => {
                setColor(swatch.color);
                if (tool === "eraser") setTool("pen");
              }}
            />
          ))}
        </div>

        <div className="scratchpad-tool-group" role="group" aria-label="Stroke size">
          {SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`scratchpad-tool-btn${size === s.size ? " is-active" : ""}`}
              aria-pressed={size === s.size}
              onClick={() => setSize(s.size)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="scratchpad-tool-group" role="group" aria-label="Canvas guide">
          {(["grid", "dots", "blank"] as const).map((bg) => (
            <button
              key={bg}
              type="button"
              className={`scratchpad-tool-btn${background === bg ? " is-active" : ""}`}
              aria-pressed={background === bg}
              onClick={() => setBackground(bg)}
            >
              {bg === "grid" ? "Grid" : bg === "dots" ? "Dots" : "Blank"}
            </button>
          ))}
          <label htmlFor={fileInputId} className="scratchpad-tool-btn scratchpad-upload-label" title="Load an image onto the canvas to annotate">
            {baseImage ? "Change image…" : "Load image…"}
          </label>
          <input
            id={fileInputId}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleLoadImageChange}
          />
          {baseImage && (
            <button type="button" className="scratchpad-tool-btn" onClick={removeBaseImage} title={`Remove ${baseImage.name} from canvas`}>
              Remove image
            </button>
          )}
        </div>

        <div className="scratchpad-tool-group scratchpad-actions-right">
          <button
            type="button"
            className={`scratchpad-tool-btn${penOnly ? " is-active" : ""}`}
            aria-pressed={penOnly}
            title="Ignore finger touches while drawing with Apple Pencil or stylus"
            onClick={() => setPenOnly((v) => !v)}
          >
            Pen only{penDetected ? " ✎" : ""}
          </button>
          <button type="button" className="scratchpad-tool-btn" onClick={undo} disabled={strokes.length === 0} title="Undo (Cmd/Ctrl+Z)">
            Undo
          </button>
          <button type="button" className="scratchpad-tool-btn" onClick={redo} disabled={redoStack.length === 0} title="Redo (Cmd/Ctrl+Shift+Z)">
            Redo
          </button>
          <button type="button" className="scratchpad-tool-btn" onClick={clearCanvas} disabled={strokes.length === 0}>
            Clear ink
          </button>
          <button type="button" className="scratchpad-tool-btn" onClick={handleDownload} disabled={!hasContent}>
            Save PNG
          </button>
          {targetStep && onAttachToStep ? (
            <button
              type="button"
              className="scratchpad-primary-btn"
              onClick={handleUseInStep}
              disabled={!hasContent}
            >
              Use in {targetStep.header || "step"}
            </button>
          ) : baseImage?.attachmentId && onUpdateComposerAttachment ? (
            <>
              <button
                type="button"
                className="scratchpad-primary-btn"
                onClick={handleUpdateExistingAttachment}
                disabled={!hasContent}
              >
                Update attachment
              </button>
              {onAttachToComposer && (
                <button
                  type="button"
                  className="scratchpad-tool-btn"
                  onClick={handleAttachToComposer}
                  disabled={!hasContent}
                >
                  Attach as copy
                </button>
              )}
            </>
          ) : onAttachToComposer ? (
            <button
              type="button"
              className="scratchpad-primary-btn"
              onClick={handleAttachToComposer}
              disabled={!hasContent}
            >
              Attach to message
            </button>
          ) : null}
        </div>
      </header>

      {baseImage && (
        <div className="scratchpad-image-bar">
          <span>Annotating: <strong>{baseImage.name}</strong></span>
        </div>
      )}

      {statusMessage && (
        <div className="scratchpad-status-banner" role="status" aria-live="polite">
          {statusMessage}
        </div>
      )}

      <div ref={stageRef} className="scratchpad-stage">
        <canvas ref={bgCanvasRef} className="scratchpad-canvas scratchpad-bg-canvas" aria-hidden="true" />
        <canvas
          ref={inkCanvasRef}
          className="scratchpad-canvas scratchpad-ink-canvas"
          aria-label="Scratchpad drawing canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
        />
      </div>
    </div>
  );
});

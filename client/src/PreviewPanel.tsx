import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "./api";
import { applyCspNonceToSrcdocHtml } from "./previewServiceWorker";
import type { ScratchpadAttachmentPayload } from "./ScratchpadPanel";

export function PreviewTabIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.142.523a7.619 7.619 0 1 1 0 15.238 7.619 7.619 0 0 1 0-15.238zm-2.15 9.592c.14.996.383 1.874.691 2.567.25.562.529.97.799 1.227.266.253.488.329.66.329.173 0 .395-.076.661-.33.27-.256.549-.664.799-1.226.307-.693.55-1.57.69-2.565a17.405 17.405 0 0 1-4.3-.002zM2.103 8.964a6.099 6.099 0 0 0 3.331 4.64c-.05-.1-.097-.2-.143-.303-.427-.96-.728-2.154-.869-3.468-.265-.064-.52-.131-.765-.208a7.91 7.91 0 0 1-1.554-.661zm12.078 0c-.38.218-.81.408-1.276.57-.326.113-.675.214-1.043.303-.14 1.312-.442 2.504-.868 3.464a7.572 7.572 0 0 1-.144.302 6.098 6.098 0 0 0 3.331-4.638zM8.142 2.048c-.172 0-.394.076-.66.33-.27.256-.549.664-.799 1.226-.499 1.123-.826 2.727-.826 4.54 0 .14.002.28.006.418a15.63 15.63 0 0 0 2.28.164c.807 0 1.574-.059 2.278-.163.004-.138.007-.278.007-.42 0-1.812-.328-3.416-.826-4.539-.25-.562-.529-.97-.799-1.227-.266-.253-.488-.329-.66-.329zm2.708.634c.05.1.098.2.144.303.604 1.36.958 3.184.958 5.158l-.002.096c.159-.046.311-.093.457-.144.557-.193.999-.415 1.316-.642.2-.144.333-.277.417-.39a6.101 6.101 0 0 0-3.29-4.38zm-5.416 0a6.102 6.102 0 0 0-3.29 4.38c.262.353.9.774 1.97 1.11.072.023.145.042.22.064l-.001-.093c0-1.974.354-3.799.958-5.158a7.54 7.54 0 0 1 .143-.303z"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
      <path d="M13.476.516c.42 0 .762.34.762.762v2.744c0 .421-.341.762-.762.762H10.81a.762.762 0 1 1 0-1.524h.995a6.1 6.1 0 1 0 2.44 4.88.762.762 0 0 1 1.524 0 7.624 7.624 0 1 1-3.054-6.102v-.76c0-.421.341-.762.762-.762z" />
    </svg>
  );
}

function ScreenshotIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function FullFrameIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <rect x="3" y="4" width="18" height="16" rx="2" />
    </svg>
  );
}

function CropRectIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M6 2v4H2" />
      <path d="M18 22v-4h4" />
      <rect x="6" y="6" width="12" height="12" strokeDasharray="3 2" />
    </svg>
  );
}

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function parseCssRadius(raw: string | undefined, w: number, h: number): number {
  if (!raw) return 0;
  const first = raw.trim().split(/\s+/)[0] ?? "";
  if (first.endsWith("%")) {
    const pct = parseFloat(first);
    return Number.isFinite(pct) ? Math.min(w, h) * (pct / 100) : 0;
  }
  const px = parseFloat(first);
  return Number.isFinite(px) ? Math.min(Math.max(0, px), Math.min(w, h) / 2) : 0;
}

function isTransparentColor(color: string | undefined): boolean {
  if (!color) return true;
  const c = color.replace(/\s+/g, "").toLowerCase();
  return c === "transparent" || c === "rgba(0,0,0,0)";
}

function paintDomToCanvas(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  win: Window,
  viewW: number,
  viewH: number,
) {
  const htmlStyle = win.getComputedStyle(doc.documentElement);
  const bodyStyle = doc.body ? win.getComputedStyle(doc.body) : null;
  const pageBg =
    (!isTransparentColor(bodyStyle?.backgroundColor) ? bodyStyle?.backgroundColor : null) ??
    (!isTransparentColor(htmlStyle?.backgroundColor) ? htmlStyle?.backgroundColor : null) ??
    "#ffffff";
  ctx.fillStyle = pageBg;
  ctx.fillRect(0, 0, viewW, viewH);

  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "head" || tag === "meta" || tag === "link") {
        return;
      }
      const style = win.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") <= 0) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < viewH && rect.left < viewW) {
        const r = parseCssRadius(style.borderRadius, rect.width, rect.height);
        ctx.save();
        const alpha = parseFloat(style.opacity || "1");
        if (Number.isFinite(alpha) && alpha < 1) ctx.globalAlpha = alpha;

        if (!isTransparentColor(style.backgroundColor)) {
          ctx.fillStyle = style.backgroundColor;
          ctx.beginPath();
          if (r > 0 && typeof ctx.roundRect === "function") {
            ctx.roundRect(rect.left, rect.top, rect.width, rect.height, r);
          } else {
            ctx.rect(rect.left, rect.top, rect.width, rect.height);
          }
          ctx.fill();
        }

        const bw = parseFloat(style.borderTopWidth || "0");
        if (bw > 0 && style.borderTopStyle !== "none" && !isTransparentColor(style.borderTopColor)) {
          ctx.strokeStyle = style.borderTopColor;
          ctx.lineWidth = bw;
          ctx.beginPath();
          if (r > 0 && typeof ctx.roundRect === "function") {
            ctx.roundRect(rect.left + bw / 2, rect.top + bw / 2, Math.max(0, rect.width - bw), Math.max(0, rect.height - bw), Math.max(0, r - bw / 2));
          } else {
            ctx.rect(rect.left + bw / 2, rect.top + bw / 2, Math.max(0, rect.width - bw), Math.max(0, rect.height - bw));
          }
          ctx.stroke();
        }

        if (tag === "img") {
          const imgEl = el as HTMLImageElement;
          if (imgEl.complete && imgEl.naturalWidth > 0) {
            try {
              ctx.drawImage(imgEl, rect.left, rect.top, rect.width, rect.height);
            } catch { /* ignore cross-origin image */ }
          }
        } else if (tag === "canvas") {
          try {
            ctx.drawImage(el as HTMLCanvasElement, rect.left, rect.top, rect.width, rect.height);
          } catch { /* ignore tainted canvas */ }
        } else if (tag === "input" || tag === "textarea") {
          const val = (el as HTMLInputElement | HTMLTextAreaElement).value || (el as HTMLInputElement | HTMLTextAreaElement).placeholder || "";
          if (val) {
            ctx.fillStyle = (el as HTMLInputElement).value ? style.color : "rgba(120,120,120,0.75)";
            ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            ctx.textBaseline = "middle";
            const padL = parseFloat(style.paddingLeft || "8") || 8;
            ctx.fillText(val, rect.left + padL, rect.top + rect.height / 2, Math.max(0, rect.width - padL * 2));
          }
        }
        ctx.restore();
      }
      for (const child of Array.from(el.childNodes)) {
        walk(child);
      }
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? "";
      if (!text.trim()) return;
      const parent = node.parentElement;
      if (!parent) return;
      const style = win.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return;
      try {
        const range = doc.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        if (rects.length === 0) return;
        ctx.save();
        ctx.fillStyle = style.color || "#111111";
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        ctx.textBaseline = "Middle" as CanvasTextBaseline;
        ctx.textBaseline = "middle";
        const trimmed = text.replace(/\s+/g, " ").trim();
        if (rects.length === 1) {
          const r = rects[0]!;
          ctx.fillText(trimmed, r.left, r.top + r.height / 2, r.width + 4);
        } else {
          const words = trimmed.split(" ");
          const perLine = Math.max(1, Math.ceil(words.length / rects.length));
          rects.forEach((r, idx) => {
            const slice = words.slice(idx * perLine, (idx + 1) * perLine).join(" ");
            if (slice) ctx.fillText(slice, r.left, r.top + r.height / 2, r.width + 8);
          });
        }
        ctx.restore();
      } catch { /* ignore range measurement error */ }
    }
  };

  if (doc.body) {
    walk(doc.body);
  }
}

async function captureIframeScreenshot(
  iframe: HTMLIFrameElement,
  cropRect: CropRect | null,
  port: number | null,
): Promise<ScratchpadAttachmentPayload | null> {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return null;

  const iframeBounds = iframe.getBoundingClientRect();
  const viewW = Math.max(100, Math.floor(iframeBounds.width));
  const viewH = Math.max(100, Math.floor(iframeBounds.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = Math.floor(viewW * dpr);
  fullCanvas.height = Math.floor(viewH * dpr);
  const fullCtx = fullCanvas.getContext("2d");
  if (!fullCtx) return null;
  fullCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let renderedViaForeignObject = false;
  try {
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script").forEach((s) => s.remove());
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    const scrollX = win.scrollX || 0;
    const scrollY = win.scrollY || 0;
    if (scrollX || scrollY) {
      clone.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`;
    }
    const serialized = new XMLSerializer().serializeToString(clone);
    const svgXml = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewW}" height="${viewH}" viewBox="0 0 ${viewW} ${viewH}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgXml)}`;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const timer = window.setTimeout(() => reject(new Error("svg timeout")), 1500);
      image.onload = () => {
        window.clearTimeout(timer);
        resolve(image);
      };
      image.onerror = (err) => {
        window.clearTimeout(timer);
        reject(err);
      };
      image.src = svgDataUrl;
    });
    fullCtx.drawImage(img, 0, 0, viewW, viewH);
    // Probe whether canvas is tainted before committing to foreignObject output.
    void fullCanvas.toDataURL("image/png");
    renderedViaForeignObject = true;
  } catch {
    renderedViaForeignObject = false;
  }

  if (!renderedViaForeignObject) {
    fullCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fullCtx.clearRect(0, 0, viewW, viewH);
    paintDomToCanvas(fullCtx, doc, win, viewW, viewH);
  }

  let targetCanvas = fullCanvas;
  if (cropRect && cropRect.width >= 8 && cropRect.height >= 8) {
    const sx = Math.max(0, Math.min(viewW - 1, Math.floor(cropRect.x)));
    const sy = Math.max(0, Math.min(viewH - 1, Math.floor(cropRect.y)));
    const sw = Math.max(1, Math.min(viewW - sx, Math.floor(cropRect.width)));
    const sh = Math.max(1, Math.min(viewH - sy, Math.floor(cropRect.height)));
    const cropped = document.createElement("canvas");
    cropped.width = Math.floor(sw * dpr);
    cropped.height = Math.floor(sh * dpr);
    const cCtx = cropped.getContext("2d");
    if (cCtx) {
      cCtx.drawImage(
        fullCanvas,
        Math.floor(sx * dpr),
        Math.floor(sy * dpr),
        Math.floor(sw * dpr),
        Math.floor(sh * dpr),
        0,
        0,
        Math.floor(sw * dpr),
        Math.floor(sh * dpr),
      );
      targetCanvas = cropped;
    }
  }

  const dataUrl = targetCanvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  const base64Data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  if (!base64Data) return null;
  const suffix = cropRect ? "region" : "full";
  return {
    name: `preview-${port ?? "page"}-${suffix}-${Date.now()}.png`,
    mediaType: "image/png",
    base64Data,
    dataUrl,
  };
}

export function NewPreviewButton({ onOpen, active = false }: { onOpen: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      className={`terminal-toggle preview-toggle${active ? " active" : ""}`}
      onClick={onOpen}
      aria-label="Open web preview"
      title="Preview a dev server in the working directory"
    >
      <PreviewTabIcon />
    </button>
  );
}

function base64ToUtf8(base64: string): string {
  if (!base64) return "";
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

export function formatPreviewAddress(port: number | null): string {
  return port !== null ? `127.0.0.1:${port}` : "";
}

export function parsePreviewPortInput(
  raw: string,
): { port: number; path?: string } | { error: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bareMatch = trimmed.match(/^:?(\d{1,5})(\/.*)?$/);
  if (bareMatch) {
    const port = Number(bareMatch[1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { error: "Enter a port between 1024 and 65535." };
    }
    return { port, ...(bareMatch[2] ? { path: bareMatch[2] } : {}) };
  }
  const hostMatch = trimmed.match(/^(?:https?:\/\/)?([^/:]+):(\d{1,5})(\/.*)?$/i);
  if (hostMatch) {
    const host = hostMatch[1]!.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost") {
      return { error: "Only 127.0.0.1:<port> loopback addresses are supported." };
    }
    const port = Number(hostMatch[2]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { error: "Enter a port between 1024 and 65535." };
    }
    return { port, ...(hostMatch[3] ? { path: hostMatch[3] } : {}) };
  }
  return { error: "Enter 127.0.0.1:<port>, :<port>, or <port> (1024–65535)." };
}

export function PreviewView({
  sessionId,
  active,
  initialPort = null,
  onCaptureScreenshot,
}: {
  sessionId: string;
  active: boolean;
  initialPort?: number | null;
  onCaptureScreenshot?: (attachment: ScratchpadAttachmentPayload) => void;
}) {
  const [portInput, setPortInput] = useState(formatPreviewAddress(initialPort));
  const [portError, setPortError] = useState<string | null>(null);
  const [savingPort, setSavingPort] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [srcDocHtml, setSrcDocHtml] = useState<string | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [currentPath, setCurrentPath] = useState("/");
  const [screenshotMenuOpen, setScreenshotMenuOpen] = useState(false);
  const [selectingRect, setSelectingRect] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const screenshotWrapRef = useRef<HTMLDivElement>(null);
  const cropOverlayRef = useRef<HTMLDivElement>(null);
  const currentPathRef = useRef("/");
  currentPathRef.current = currentPath;

  const wasLiveRef = useRef(false);
  const manuallyDetachedRef = useRef(false);
  const autoAttachedSessionRef = useRef<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const openWsClientsRef = useRef<Set<string>>(new Set());
  const wsSinceRef = useRef<Record<string, number>>({});
  const cookieJarRef = useRef<Map<string, string>>(new Map());
  const loadSeqRef = useRef(0);

  const portsQuery = useQuery({
    queryKey: ["preview-ports", sessionId],
    queryFn: () => api.listPreviewPorts({ session_id: sessionId }),
    enabled: Boolean(sessionId),
    refetchInterval: active ? 2500 : false,
    retry: false,
  });

  const configuredPort = portsQuery.data?.configured_port ?? initialPort ?? null;
  const reachable = portsQuery.data?.reachable ?? null;
  const detectedPorts = portsQuery.data?.ports ?? [];

  useEffect(() => {
    if (configuredPort !== null) {
      setPortInput((current) => {
        const parsed = parsePreviewPortInput(current);
        if (current.trim() === "" || (parsed && "port" in parsed && parsed.port === configuredPort)) {
          return formatPreviewAddress(configuredPort);
        }
        return current;
      });
    }
  }, [configuredPort]);

  useEffect(() => {
    if (reachable === true) {
      wasLiveRef.current = true;
    }
  }, [reachable]);

  useEffect(() => {
    wasLiveRef.current = false;
    setSrcDocHtml(null);
    setCurrentPath("/");
    openWsClientsRef.current.clear();
    wsSinceRef.current = {};
    cookieJarRef.current.clear();
  }, [sessionId, configuredPort]);

  useEffect(() => {
    manuallyDetachedRef.current = false;
    autoAttachedSessionRef.current = null;
  }, [sessionId]);

  const recordCookies = (headers: Record<string, string>) => {
    const raw = headers["set-cookie"];
    if (!raw) return;
    for (const part of raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
      const firstSemi = part.split(";")[0]?.trim() ?? "";
      const eq = firstSemi.indexOf("=");
      if (eq > 0) {
        cookieJarRef.current.set(firstSemi.slice(0, eq).trim(), firstSemi.slice(eq + 1).trim());
      }
    }
  };

  const buildCookieHeader = (): string | null => {
    if (cookieJarRef.current.size === 0) return null;
    const pairs: string[] = [];
    cookieJarRef.current.forEach((v, k) => pairs.push(`${k}=${v}`));
    return pairs.join("; ");
  };

  const loadPreviewDocument = useCallback(
    async ({
      method = "GET",
      path = "/",
      headers = {},
      bodyBase64 = null,
    }: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      bodyBase64?: string | null;
    }) => {
      const seq = ++loadSeqRef.current;
      setLoadingDoc(true);
      try {
        const cookieHdr = buildCookieHeader();
        const res = await api.previewProxy({
          session_id: sessionId,
          method,
          path,
          headers: {
            accept: "text/html,application/xhtml+xml,*/*",
            ...headers,
            ...(cookieHdr ? { cookie: cookieHdr } : {}),
          },
          bodyBase64,
          previewBasePath: "__srcdoc__",
        });
        if (seq !== loadSeqRef.current) return;
        if (!res.reachable) {
          setSrcDocHtml(null);
          void portsQuery.refetch();
          return;
        }
        recordCookies(res.headers ?? {});
        const finalPath = res.headers?.["x-preview-final-path"] || path;
        setCurrentPath(finalPath);
        const rawHtml = base64ToUtf8(res.bodyBase64);
        setSrcDocHtml(applyCspNonceToSrcdocHtml(rawHtml));
      } catch {
        if (seq === loadSeqRef.current) {
          setSrcDocHtml(null);
        }
      } finally {
        if (seq === loadSeqRef.current) {
          setLoadingDoc(false);
        }
      }
    },
    [sessionId, portsQuery.refetch],
  );

  // Load the preview document when attached and reachable
  useEffect(() => {
    if (!configuredPort || reachable !== true) return;
    void loadPreviewDocument({ method: "GET", path: currentPathRef.current });
  }, [sessionId, configuredPort, reachable, reloadNonce, loadPreviewDocument]);

  // If no port is attached yet and the workspace has a listening dev server,
  // auto-attach to the first detected port when opening the Preview tab.
  useEffect(() => {
    if (
      !active ||
      savingPort ||
      portsQuery.isPending ||
      configuredPort !== null ||
      manuallyDetachedRef.current ||
      detectedPorts.length === 0 ||
      autoAttachedSessionRef.current === sessionId
    ) {
      return;
    }
    autoAttachedSessionRef.current = sessionId;
    void attachPort(detectedPorts[0]!.port);
  }, [active, savingPort, portsQuery.isPending, configuredPort, detectedPorts, sessionId]);

  // Bridge HTTP requests, multi-page navigation, HMR reloads, and WebSocket
  // frames from the preview iframe to `api.previewProxy` / `api.previewWs`.
  useEffect(() => {
    if (!active || !configuredPort || reachable !== true) return;
    let cancelled = false;
    let activeLoop = true;
    let wakeLoop: (() => void) | null = null;

    const notifyLoop = () => {
      if (wakeLoop) {
        const fn = wakeLoop;
        wakeLoop = null;
        fn();
      }
    };

    const onMessage = (event: MessageEvent) => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return;
      const d = event.data;
      if (!d || typeof d !== "object") return;

      if (d.type === "code-space:preview-http-req" && typeof d.reqId === "string") {
        const reqId = d.reqId;
        const cookieHdr = buildCookieHeader();
        void api
          .previewProxy({
            session_id: sessionId,
            method: typeof d.method === "string" ? d.method : "GET",
            path: typeof d.path === "string" ? d.path : "/",
            headers: {
              ...(d.headers && typeof d.headers === "object" ? d.headers : {}),
              ...(cookieHdr ? { cookie: cookieHdr } : {}),
            },
            bodyBase64: typeof d.bodyBase64 === "string" ? d.bodyBase64 : null,
            previewBasePath: "",
          })
          .then((res) => {
            if (cancelled) return;
            recordCookies(res.headers ?? {});
            iframeRef.current?.contentWindow?.postMessage(
              {
                type: "code-space:preview-http-res",
                reqId,
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
                bodyBase64: res.bodyBase64,
              },
              "*",
            );
          });
        return;
      }

      if (d.type === "code-space:preview-navigate") {
        void loadPreviewDocument({
          method: typeof d.method === "string" ? d.method : "GET",
          path: typeof d.path === "string" ? d.path : "/",
          headers: d.headers && typeof d.headers === "object" ? d.headers : {},
          bodyBase64: typeof d.bodyBase64 === "string" ? d.bodyBase64 : null,
        });
        return;
      }

      if (d.type === "code-space:preview-hmr-reload") {
        void loadPreviewDocument({
          method: "GET",
          path: currentPathRef.current,
        });
        return;
      }

      if (d.type === "code-space:preview-ws-cmd") {
        const clientId = typeof d.clientId === "string" ? d.clientId : "";
        if (!clientId) return;

        if (d.cmd === "open") {
          openWsClientsRef.current.add(clientId);
          void api
            .previewWs({
              session_id: sessionId,
              cmd: "open",
              clientId,
              path: typeof d.path === "string" ? d.path : "/",
              protocols: Array.isArray(d.protocols) ? d.protocols.map(String) : [],
            })
            .then(() => notifyLoop());
        } else if (d.cmd === "send") {
          void api.previewWs({
            session_id: sessionId,
            cmd: "send",
            clientId,
            data: typeof d.data === "string" ? d.data : "",
          });
        } else if (d.cmd === "close") {
          openWsClientsRef.current.delete(clientId);
          void api.previewWs({
            session_id: sessionId,
            cmd: "close",
            clientId,
          });
        }
      }
    };

    window.addEventListener("message", onMessage);

    const runPollLoop = async () => {
      while (!cancelled && activeLoop) {
        if (openWsClientsRef.current.size === 0) {
          await new Promise<void>((resolve) => {
            wakeLoop = resolve;
          });
          if (cancelled || !activeLoop) break;
        }
        try {
          const res = await api.previewWs({
            session_id: sessionId,
            cmd: "poll",
            since: wsSinceRef.current,
            waitMs: 8000,
          });
          if (cancelled || !activeLoop) break;
          if (res.ok) {
            if (res.nextSince) wsSinceRef.current = res.nextSince;
            const iframeWin = iframeRef.current?.contentWindow;
            if (iframeWin && Array.isArray(res.events)) {
              for (const ev of res.events) {
                if (ev.event === "close") openWsClientsRef.current.delete(ev.clientId);
                iframeWin.postMessage(
                  {
                    type: "code-space:preview-ws-event",
                    clientId: ev.clientId,
                    event: ev.event,
                    protocol: ev.protocol,
                    data: ev.data,
                    code: ev.code,
                    reason: ev.reason,
                  },
                  "*",
                );
              }
            }
          } else {
            await new Promise((r) => window.setTimeout(r, 1000));
          }
        } catch {
          if (cancelled || !activeLoop) break;
          await new Promise((r) => window.setTimeout(r, 1000));
        }
      }
    };

    void runPollLoop();

    return () => {
      cancelled = true;
      activeLoop = false;
      notifyLoop();
      window.removeEventListener("message", onMessage);
    };
  }, [active, sessionId, configuredPort, reachable, loadPreviewDocument]);

  const attachPort = async (port: number | null, initialSubpath = "/") => {
    setPortError(null);
    setSavingPort(true);
    try {
      const res = await api.setPreviewPort({ session_id: sessionId, port });
      if (!res.ok) {
        setPortError(res.error ?? "Could not attach to that port.");
        return;
      }
      if (port !== null) {
        manuallyDetachedRef.current = false;
        setPortInput(formatPreviewAddress(port));
        setCurrentPath(initialSubpath);
        setReloadNonce((n) => n + 1);
      } else {
        manuallyDetachedRef.current = true;
        setPortInput("");
        setSrcDocHtml(null);
      }
      await portsQuery.refetch();
    } catch {
      setPortError("Could not reach the server to attach the port.");
    } finally {
      setSavingPort(false);
    }
  };

  const handlePortSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parsePreviewPortInput(portInput);
    if (!parsed) {
      void attachPort(null);
      return;
    }
    if ("error" in parsed) {
      setPortError(parsed.error);
      return;
    }
    setPortInput(formatPreviewAddress(parsed.port));
    void attachPort(parsed.port, parsed.path ?? "/");
  };

  const reloadPreview = () => {
    const parsed = parsePreviewPortInput(portInput);
    if (parsed && "port" in parsed) {
      setPortInput(formatPreviewAddress(parsed.port));
      if (parsed.port !== configuredPort) {
        void attachPort(parsed.port, parsed.path ?? "/");
        return;
      }
    }
    setReloadNonce((n) => n + 1);
    void portsQuery.refetch();
  };

  useEffect(() => {
    if (!screenshotMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !screenshotWrapRef.current?.contains(event.target)) {
        setScreenshotMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setScreenshotMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [screenshotMenuOpen]);

  useEffect(() => {
    if (!selectingRect) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectingRect(false);
        setDragStart(null);
        setDragCurrent(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectingRect]);

  const canScreenshot = Boolean(srcDocHtml && reachable !== false && !capturing && onCaptureScreenshot);

  const runCapture = async (cropRect: CropRect | null) => {
    const iframe = iframeRef.current;
    if (!iframe || !onCaptureScreenshot) return;
    setCapturing(true);
    try {
      const payload = await captureIframeScreenshot(iframe, cropRect, configuredPort);
      if (payload) {
        onCaptureScreenshot(payload);
      }
    } finally {
      setCapturing(false);
      setSelectingRect(false);
      setDragStart(null);
      setDragCurrent(null);
    }
  };

  const activeCropRect: CropRect | null =
    dragStart && dragCurrent
      ? {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          width: Math.abs(dragCurrent.x - dragStart.x),
          height: Math.abs(dragCurrent.y - dragStart.y),
        }
      : null;

  const handleCropPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    const overlay = cropOverlayRef.current;
    if (!overlay) return;
    try {
      overlay.setPointerCapture(event.pointerId);
    } catch { /* ignore */ }
    const rect = overlay.getBoundingClientRect();
    const pt = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setDragStart(pt);
    setDragCurrent(pt);
  };

  const handleCropPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    event.preventDefault();
    const overlay = cropOverlayRef.current;
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    setDragCurrent({
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    });
  };

  const handleCropPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    event.preventDefault();
    try {
      cropOverlayRef.current?.releasePointerCapture(event.pointerId);
    } catch { /* ignore */ }
    if (activeCropRect && activeCropRect.width >= 12 && activeCropRect.height >= 12) {
      void runCapture(activeCropRect);
    } else {
      setDragStart(null);
      setDragCurrent(null);
    }
  };

  const statusKind: "unattached" | "connecting" | "live" | "exited" | "unreachable" =
    configuredPort === null
      ? "unattached"
      : reachable === null || (reachable === true && srcDocHtml === null && loadingDoc)
        ? "connecting"
        : reachable === true
          ? "live"
          : wasLiveRef.current
            ? "exited"
            : "unreachable";

  const statusText =
    statusKind === "unattached"
      ? "Not attached"
      : statusKind === "connecting"
        ? `Connecting · :${configuredPort}`
        : statusKind === "live"
          ? `Live · :${configuredPort}${currentPath !== "/" ? currentPath : ""}`
          : statusKind === "exited"
            ? `Exited · :${configuredPort}`
            : `No server · :${configuredPort}`;

  const trimmedPortInput = portInput.trim();

  return (
    <div className="preview-pane">
      <div className="preview-toolbar">
        <form className="preview-port-form" onSubmit={handlePortSubmit}>
          <label className="sr-only" htmlFor={`preview-port-${sessionId}`}>
            Preview address
          </label>
          <input
            id={`preview-port-${sessionId}`}
            type="text"
            className="preview-port-input"
            placeholder="127.0.0.1:port"
            value={portInput}
            disabled={savingPort}
            onChange={(event) => {
              setPortInput(event.target.value);
              setPortError(null);
            }}
          />
          <button
            type="button"
            className="preview-reload-btn"
            onClick={reloadPreview}
            disabled={savingPort || (configuredPort === null && trimmedPortInput === "")}
            aria-label="Reload preview"
            title="Reload preview"
          >
            <RefreshIcon />
          </button>
        </form>

        {detectedPorts.length > 0 && (
          <div className="preview-detected-ports" aria-label="Detected workspace ports">
            {detectedPorts.map((item) => {
              const activePort = item.port === configuredPort;
              return (
                <button
                  key={item.port}
                  type="button"
                  className={`preview-port-chip${activePort ? " active" : ""}`}
                  disabled={savingPort}
                  title={`Attach to 127.0.0.1:${item.port} (${item.command}, PID ${item.pid})`}
                  onClick={() => {
                    void attachPort(item.port);
                  }}
                >
                  :{item.port} <span>{item.command}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="preview-toolbar-right">
          {onCaptureScreenshot && (
            <div ref={screenshotWrapRef} className="preview-screenshot-wrap">
              <button
                type="button"
                className={`preview-screenshot-btn${screenshotMenuOpen || selectingRect ? " active" : ""}`}
                disabled={!canScreenshot}
                aria-haspopup="menu"
                aria-expanded={screenshotMenuOpen}
                aria-label="Take preview screenshot"
                title="Take screenshot of preview"
                onClick={() => setScreenshotMenuOpen((open) => !open)}
              >
                <ScreenshotIcon />
                <svg className="preview-screenshot-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 4.5 6 7.5 9 4.5" />
                </svg>
              </button>
              {screenshotMenuOpen && (
                <div className="preview-screenshot-menu" role="menu" aria-label="Screenshot options">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setScreenshotMenuOpen(false);
                      void runCapture(null);
                    }}
                  >
                    <FullFrameIcon />
                    <span>Full page</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setScreenshotMenuOpen(false);
                      setSelectingRect(true);
                      setDragStart(null);
                      setDragCurrent(null);
                    }}
                  >
                    <CropRectIcon />
                    <span>Rectangle</span>
                  </button>
                </div>
              )}
            </div>
          )}
          <span
            className={`preview-status-pill status-${statusKind}`}
            role="status"
            aria-live="polite"
            aria-label={statusText}
            title={statusText}
          >
            <i aria-hidden="true" />
          </span>
        </div>
      </div>

      {portError && (
        <p className="preview-error-banner" role="alert">
          {portError}
        </p>
      )}

      <div className="preview-body">
        {configuredPort === null ? (
          <div className="preview-empty-state">
            <p className="preview-empty-title">No preview port attached</p>
            <p className="preview-empty-copy">
              Start a dev server in the session terminal (Vite, Next, Astro,{" "}
              <code>python3 -m http.server</code>) and enter its loopback port above.
            </p>
            {detectedPorts.length > 0 && (
              <div className="preview-empty-detected">
                <span>Listening in this workspace:</span>
                <div className="preview-detected-ports">
                  {detectedPorts.map((item) => (
                    <button
                      key={item.port}
                      type="button"
                      className="preview-port-chip"
                      onClick={() => {
                        void attachPort(item.port);
                      }}
                    >
                      Attach to :{item.port} ({item.command})
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : reachable === false ? (
          <div className="preview-empty-state preview-dead-state" role="alert">
            <p className="preview-empty-title">
              {wasLiveRef.current
                ? `Server on 127.0.0.1:${configuredPort} exited`
                : `No server listening on 127.0.0.1:${configuredPort}`}
            </p>
            <p className="preview-empty-copy">
              Nothing is currently accepting connections on loopback port{" "}
              <code>{configuredPort}</code> in this session’s host environment. Start or restart your
              dev server on port <code>{configuredPort}</code> and it will connect automatically.
            </p>
            <button type="button" className="terminal-panel-button" onClick={reloadPreview}>
              Check again
            </button>
          </div>
        ) : srcDocHtml !== null ? (
          <div className="preview-iframe-stage">
            <iframe
              ref={iframeRef}
              key={`${sessionId}:${configuredPort}`}
              className="preview-iframe"
              srcDoc={srcDocHtml}
              title={`Preview 127.0.0.1:${configuredPort}`}
            />
            {selectingRect && (
              <div
                ref={cropOverlayRef}
                className="preview-crop-overlay"
                role="region"
                aria-label="Drag to capture a rectangle screenshot"
                onPointerDown={handleCropPointerDown}
                onPointerMove={handleCropPointerMove}
                onPointerUp={handleCropPointerUp}
                onPointerCancel={() => {
                  setDragStart(null);
                  setDragCurrent(null);
                }}
              >
                <div className="preview-crop-hint">
                  <span>Drag to capture a rectangle</span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      setSelectingRect(false);
                      setDragStart(null);
                      setDragCurrent(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {activeCropRect && activeCropRect.width > 2 && activeCropRect.height > 2 && (
                  <div
                    className="preview-crop-box"
                    style={{
                      left: `${activeCropRect.x}px`,
                      top: `${activeCropRect.y}px`,
                      width: `${activeCropRect.width}px`,
                      height: `${activeCropRect.height}px`,
                    }}
                  >
                    <span className="preview-crop-dims">
                      {Math.round(activeCropRect.width)} × {Math.round(activeCropRect.height)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="preview-empty-state" role="status">
            <p className="preview-empty-title">Connecting to 127.0.0.1:{configuredPort}…</p>
          </div>
        )}
      </div>
    </div>
  );
}

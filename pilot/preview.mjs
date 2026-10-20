// Dev-server preview proxy and workspace listening-port discovery for Code Space.
//
// Lets a session attach its Preview tab to an arbitrary HTTP/WebSocket server
// running on 127.0.0.1:<port> on the pilot host, rewriting redirects, cookies,
// and root-relative HTML/JS/CSS asset paths so stock Vite, Next, Astro, and
// static servers render and hot-reload inside the session's preview root
// without modifying the target project.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { join, resolve as resolvePath } from "node:path";

export const DEFAULT_FORBIDDEN_PREVIEW_PORTS = new Set([443, 4173, 18790, 18791, 18792]);

/** Validate that a port is a safe unprivileged loopback port and not a pilot/service port. */
export function isAllowedPreviewPort(port, forbiddenPorts = DEFAULT_FORBIDDEN_PREVIEW_PORTS) {
  const num = typeof port === "number" ? port : Number(port);
  if (!Number.isInteger(num) || num < 1024 || num > 65535) return false;
  if (forbiddenPorts && forbiddenPorts.has(num)) return false;
  return true;
}

/** Ensure a preview subpath starts with `/`, preserves query strings, and cannot smuggle an authority. */
export function normalizePreviewSubpath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return "/";
  const trimmed = rawPath.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "/";
  if (/^\/\/[^/]/.test(trimmed)) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/^\/+/, "/");
}

function cleanBasePath(previewBasePath) {
  if (typeof previewBasePath !== "string" || !previewBasePath.trim()) return "";
  return previewBasePath.trim().replace(/\/+$/, "");
}

/**
 * Rewrite an upstream `Location` redirect header so root-relative paths and
 * `http://127.0.0.1:<port>/...` or `http://localhost:<port>/...` URLs stay
 * inside `previewBasePath`.
 */
export function rewriteLocationHeader(location, port, previewBasePath) {
  if (typeof location !== "string" || !location) return location;
  const base = cleanBasePath(previewBasePath);
  if (!base) return location;
  if (location.startsWith(base + "/") || location === base) return location;
  if (location.startsWith("/") && !location.startsWith("//")) {
    return `${base}${location}`;
  }
  try {
    const parsed = new URL(location);
    const isLocalHost =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "0.0.0.0" ||
      parsed.hostname === "[::1]";
    const parsedPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (isLocalHost && (!port || parsedPort === Number(port))) {
      return `${base}${parsed.pathname || "/"}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Relative path like "sub/page" stays relative to the current preview URL.
  }
  return location;
}

/**
 * Scope a `Set-Cookie` header to `previewBasePath` and strip `Domain=` so
 * cookies from a previewed app can never leak into Code Space itself or other
 * session previews.
 */
export function rewriteSetCookieHeader(cookieHeader, previewBasePath) {
  const base = cleanBasePath(previewBasePath) || "/";
  const rewriteOne = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return raw;
    const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return raw;
    const [nameValue, ...attrs] = parts;
    const filteredAttrs = [];
    for (const attr of attrs) {
      if (/^domain\s*=/i.test(attr)) continue;
      if (/^path\s*=/i.test(attr)) continue;
      filteredAttrs.push(attr);
    }
    filteredAttrs.push(`Path=${base}/`);
    if (!filteredAttrs.some((a) => /^samesite\s*=/i.test(a))) {
      filteredAttrs.push("SameSite=Lax");
    }
    return [nameValue, ...filteredAttrs].join("; ");
  };
  if (Array.isArray(cookieHeader)) return cookieHeader.map(rewriteOne);
  return rewriteOne(cookieHeader);
}

/**
 * Build the client-side bootstrap `<script>` injected into previewed HTML
 * documents so dynamic `fetch("/...")`, `XMLHttpRequest`, `history.pushState`,
 * `EventSource`, and `WebSocket` (including Vite HMR `vite-hmr`) route through
 * the session's preview proxy.
 */
export function buildPreviewBootstrapScript(previewBasePath, sessionId, port) {
  const base = cleanBasePath(previewBasePath);
  const cfg = JSON.stringify({ base, sessionId: String(sessionId ?? ""), port: Number(port ?? 0) });
  return `<script data-code-space-preview="1">(() => {
  const CFG = ${cfg};
  const BASE = CFG.base;
  if (!BASE) return;
  const rewriteUrl = (input) => {
    if (typeof input !== "string") return input;
    if (input.startsWith(BASE + "/") || input === BASE) return input;
    if (input.startsWith("/") && !input.startsWith("//")) return BASE + input;
    try {
      const u = new URL(input, location.href);
      if ((u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "0.0.0.0") && (!CFG.port || Number(u.port || 80) === CFG.port)) {
        return BASE + u.pathname + u.search + u.hash;
      }
      if (u.origin === location.origin && !u.pathname.startsWith(BASE + "/") && u.pathname !== BASE && !u.pathname.startsWith("/actions")) {
        return BASE + u.pathname + u.search + u.hash;
      }
    } catch {}
    return input;
  };
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function(input, init) {
      if (typeof input === "string") input = rewriteUrl(input);
      else if (typeof URL !== "undefined" && input instanceof URL) input = rewriteUrl(input.toString());
      return origFetch.call(this, input, init);
    };
  }
  if (typeof XMLHttpRequest !== "undefined") {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return origOpen.call(this, method, typeof url === "string" ? rewriteUrl(url) : url, ...rest);
    };
  }
  if (typeof history !== "undefined") {
    for (const fn of ["pushState", "replaceState"]) {
      const orig = history[fn];
      if (typeof orig === "function") {
        history[fn] = function(state, unused, url) {
          return orig.call(this, state, unused, typeof url === "string" ? rewriteUrl(url) : url);
        };
      }
    }
  }
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    const raw = a.getAttribute("href");
    if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith(BASE + "/")) {
      a.setAttribute("href", BASE + raw);
    }
  }, true);
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form || typeof form.getAttribute !== "function") return;
    const raw = form.getAttribute("action");
    if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith(BASE + "/")) {
      form.setAttribute("action", BASE + raw);
    }
  }, true);
  if (window.parent && window.parent !== window && CFG.sessionId) {
    const NativeWS = window.WebSocket;
    class PreviewWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      CONNECTING = 0;
      OPEN = 1;
      CLOSING = 2;
      CLOSED = 3;
      readyState = 0;
      protocol = "";
      extensions = "";
      bufferedAmount = 0;
      binaryType = "blob";
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
      constructor(url, protocols) {
        super();
        const u = new URL(String(url), location.href);
        let wsPath = u.pathname + u.search;
        if (wsPath.startsWith(BASE + "/")) wsPath = wsPath.slice(BASE.length);
        else if (wsPath === BASE) wsPath = "/";
        this.url = String(url);
        this._id = "pws-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        const protoList = typeof protocols === "string" ? [protocols] : Array.isArray(protocols) ? protocols : [];
        this.protocol = protoList[0] || "";
        this._onMsg = (ev) => {
          const d = ev.data;
          if (!d || d.type !== "code-space:preview-ws-event" || d.clientId !== this._id) return;
          if (d.event === "open") {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            if (d.protocol) this.protocol = d.protocol;
            const openEv = new Event("open");
            this.dispatchEvent(openEv);
            if (typeof this.onopen === "function") this.onopen(openEv);
          } else if (d.event === "message") {
            if (this.readyState !== 1) return;
            const msgEv = new MessageEvent("message", { data: d.data });
            this.dispatchEvent(msgEv);
            if (typeof this.onmessage === "function") this.onmessage(msgEv);
          } else if (d.event === "close") {
            if (this.readyState === 3) return;
            this.readyState = 3;
            window.removeEventListener("message", this._onMsg);
            const closeEv = new CloseEvent("close", { code: d.code || 1000, reason: d.reason || "", wasClean: true });
            this.dispatchEvent(closeEv);
            if (typeof this.onclose === "function") this.onclose(closeEv);
          } else if (d.event === "error") {
            const errEv = new Event("error");
            this.dispatchEvent(errEv);
            if (typeof this.onerror === "function") this.onerror(errEv);
          }
        };
        window.addEventListener("message", this._onMsg);
        window.parent.postMessage({
          type: "code-space:preview-ws-cmd",
          cmd: "open",
          clientId: this._id,
          sessionId: CFG.sessionId,
          port: CFG.port,
          path: wsPath || "/",
          protocols: protoList,
        }, "*");
      }
      send(data) {
        if (this.readyState !== 1) return;
        window.parent.postMessage({
          type: "code-space:preview-ws-cmd",
          cmd: "send",
          clientId: this._id,
          sessionId: CFG.sessionId,
          data: typeof data === "string" ? data : String(data),
        }, "*");
      }
      close(code = 1000, reason = "") {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        window.parent.postMessage({
          type: "code-space:preview-ws-cmd",
          cmd: "close",
          clientId: this._id,
          sessionId: CFG.sessionId,
          code,
          reason,
        }, "*");
      }
    }
    window.WebSocket = function(url, protocols) {
      try {
        const u = new URL(String(url), location.href);
        const isTarget =
          u.origin === location.origin ||
          u.hostname === location.hostname ||
          u.hostname === "127.0.0.1" ||
          u.hostname === "localhost" ||
          u.hostname === "0.0.0.0";
        if (isTarget) return new PreviewWebSocket(url, protocols);
      } catch {}
      return new NativeWS(url, protocols);
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  }
})();</script>`;
}

/**
 * Rewrite root-relative asset URLs (`src="/..."`, `href="/..."`, `action="/..."`,
 * inline module imports) in an HTML document and inject the preview bootstrap
 * script so navigation, fetches, and HMR WebSockets stay inside `previewBasePath`.
 */
export function rewriteHtmlForPreview(html, previewBasePath, sessionId = "", port = 0) {
  if (typeof html !== "string") return "";
  const base = cleanBasePath(previewBasePath);
  if (!base) return html;
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/^\//, "");
  const attrRe = new RegExp(
    `(\\b(?:src|href|action|poster)\\s*=\\s*)(["'])\\/(?!\\/|${escapedBase}(?:\\/|$)|assets\\/__preview\\/|__preview\\/)([^"']*)\\2`,
    "gi",
  );
  let rewritten = html.replace(attrRe, `$1$2${base}/$3$2`);
  rewritten = rewriteJsForPreview(rewritten, base);
  const script = buildPreviewBootstrapScript(base, sessionId, port);
  if (/<head\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<head\b[^>]*>/i, (match) => `${match}${script}`);
  }
  if (/<html\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<html\b[^>]*>/i, (match) => `${match}<head>${script}</head>`);
  }
  return `${script}${rewritten}`;
}

/**
 * Rewrite root-relative ESM import/export specifiers and Vite client paths in
 * JavaScript modules so stock Vite / Next / ESM apps resolve modules under
 * `previewBasePath` without needing `--base`.
 */
export function rewriteJsForPreview(jsText, previewBasePath) {
  if (typeof jsText !== "string") return "";
  const base = cleanBasePath(previewBasePath);
  if (!base) return jsText;
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/^\//, "");
  const guard = `(?!\\/|${escapedBase}(?:\\/|$)|assets\\/__preview\\/|__preview\\/)`;
  return jsText
    .replace(new RegExp(`(\\b(?:from|import)\\s*)(["'])\\/${guard}([^"'\\r\\n]+)\\2`, "g"), `$1$2${base}/$3$2`)
    .replace(new RegExp(`(\\bimport\\s*\\(\\s*)(["'])\\/${guard}([^"'\\r\\n]+)\\2`, "g"), `$1$2${base}/$3$2`)
    .replace(
      new RegExp(`(["'])\\/(?:@vite\\/|@react-refresh\\b|@id\\/|@fs\\/|node_modules\\/|src\\/|_next\\/)([^"'\\r\\n]*)\\1`, "g"),
      (full, quote, rest) => {
        const inner = full.slice(1, -1);
        if (inner.startsWith(base + "/")) return full;
        return `${quote}${base}${inner}${quote}`;
      },
    );
}

/** Rewrite root-relative `url(/...)` and `@import "/..."` references in CSS. */
export function rewriteCssForPreview(cssText, previewBasePath) {
  if (typeof cssText !== "string") return "";
  const base = cleanBasePath(previewBasePath);
  if (!base) return cssText;
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/^\//, "");
  const guard = `(?!\\/|${escapedBase}(?:\\/|$)|assets\\/__preview\\/|__preview\\/)`;
  return cssText
    .replace(new RegExp(`(url\\(\\s*["']?)\\/${guard}([^)"']+)(["']?\\s*\\))`, "gi"), `$1${base}/$2$3`)
    .replace(new RegExp(`(@import\\s+["'])\\/${guard}([^"']+)(["'])`, "gi"), `$1${base}/$2$3`);
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output into `{ pid, command, port }`
 * entries.
 */
export function parseLsofListeningPorts(lsofOutput, forbiddenPorts = DEFAULT_FORBIDDEN_PREVIEW_PORTS) {
  if (typeof lsofOutput !== "string" || !lsofOutput.trim()) return [];
  const results = [];
  const seenPort = new Set();
  let currentPid = null;
  let currentCmd = "";
  for (const rawLine of lsofOutput.split(/\r?\n/)) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const value = rawLine.slice(1);
    if (tag === "p") {
      currentPid = Number(value);
      currentCmd = "";
    } else if (tag === "c") {
      currentCmd = value.trim();
    } else if (tag === "n" && currentPid) {
      const portMatch = value.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = Number(portMatch[1]);
      if (!isAllowedPreviewPort(port, forbiddenPorts) || seenPort.has(port)) continue;
      seenPort.add(port);
      results.push({ pid: currentPid, command: currentCmd || "server", port });
    }
  }
  return results.sort((a, b) => a.port - b.port);
}

function isInsideWorkspace(dir, workspaceRoot) {
  if (!dir || !workspaceRoot) return false;
  const cleanRoot = resolvePath(workspaceRoot);
  const cleanDir = resolvePath(dir);
  return cleanDir === cleanRoot || cleanDir.startsWith(`${cleanRoot}/`);
}

/**
 * Discover TCP ports currently listening on the host that belong to processes
 * running inside `workspaceRoot` (or descendant processes of a process in
 * `workspaceRoot`).
 */
export async function discoverWorkspaceListeningPorts({
  workspaceRoot,
  forbiddenPorts = DEFAULT_FORBIDDEN_PREVIEW_PORTS,
  exec = undefined,
}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) return [];
  const runExec =
    exec ??
    ((cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 3000, maxBuffer: 1_000_000 }, (err, stdout) => {
          resolve(err ? "" : String(stdout ?? ""));
        });
      }));

  const lsofOut = await runExec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
  const candidates = parseLsofListeningPorts(lsofOut, forbiddenPorts);
  if (candidates.length === 0) return [];

  // Map PIDs -> parent PIDs and cwds so child servers spawned from a shell in
  // the workspace are matched accurately.
  const psOut = await runExec("ps", ["-axo", "pid=,ppid="]);
  const parentByPid = new Map();
  for (const line of psOut.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parentByPid.set(Number(m[1]), Number(m[2]));
  }

  const allPids = new Set();
  for (const item of candidates) {
    let cur = item.pid;
    let depth = 0;
    while (cur && cur > 1 && depth < 12 && !allPids.has(cur)) {
      allPids.add(cur);
      cur = parentByPid.get(cur) ?? 0;
      depth++;
    }
  }

  const cwdByPid = new Map();
  for (const pid of allPids) {
    try {
      const target = readlinkSync(`/proc/${pid}/cwd`);
      if (target) cwdByPid.set(pid, target);
    } catch {
      // /proc is Linux-only; fallback to lsof -d cwd below.
    }
  }

  if (cwdByPid.size === 0 && allPids.size > 0) {
    const cwdOut = await runExec("lsof", ["-a", "-p", [...allPids].join(","), "-d", "cwd", "-Fn"]);
    let pid = null;
    for (const line of cwdOut.split(/\r?\n/)) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid) cwdByPid.set(pid, line.slice(1));
    }
  }

  return candidates.filter((item) => {
    let cur = item.pid;
    let depth = 0;
    while (cur && cur > 1 && depth < 12) {
      const cwd = cwdByPid.get(cur);
      if (cwd && isInsideWorkspace(cwd, workspaceRoot)) return true;
      cur = parentByPid.get(cur) ?? 0;
      depth++;
    }
    return false;
  });
}

/** Fast TCP connect check to `127.0.0.1:<port>`. */
export function probeLocalPort(port, timeoutMs = 1500) {
  if (!isAllowedPreviewPort(port, null)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "host",
]);

/**
 * Forward an HTTP request to `http://127.0.0.1:<port><path>` on the pilot host
 * and return `{ reachable, status, statusText, headers, bodyBase64, error }`.
 */
export function proxyPreviewHttpRequest({
  port,
  method = "GET",
  path = "/",
  headers = {},
  bodyBase64 = null,
  previewBasePath = "",
  sessionId = "",
  timeoutMs = 15_000,
}) {
  if (!isAllowedPreviewPort(port)) {
    return Promise.resolve({
      reachable: false,
      status: 400,
      statusText: "Bad Request",
      headers: {},
      bodyBase64: "",
      error: `Port ${port} is not an allowed preview port.`,
    });
  }
  const subpath = normalizePreviewSubpath(path);
  const reqHeaders = {};
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || lower === "accept-encoding") continue;
      if (typeof v === "string") reqHeaders[lower] = v;
    }
  }
  reqHeaders.host = `127.0.0.1:${port}`;
  reqHeaders.connection = "close";
  reqHeaders["accept-encoding"] = "identity";
  const bodyBuf = typeof bodyBase64 === "string" && bodyBase64.length > 0 ? Buffer.from(bodyBase64, "base64") : null;
  if (bodyBuf) reqHeaders["content-length"] = String(bodyBuf.length);

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(port),
        method: String(method || "GET").toUpperCase(),
        path: subpath,
        headers: reqHeaders,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const statusText = res.statusMessage ?? "";
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        const isEventStream = contentType.includes("text/event-stream");
        const outHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          const lower = k.toLowerCase();
          if (HOP_BY_HOP_HEADERS.has(lower) || lower === "x-frame-options" || lower === "content-security-policy") {
            continue;
          }
          if (lower === "location" && typeof v === "string") {
            outHeaders.location = rewriteLocationHeader(v, port, previewBasePath);
          } else if (lower === "set-cookie" && v !== undefined) {
            const rewritten = rewriteSetCookieHeader(v, previewBasePath);
            outHeaders["set-cookie"] = Array.isArray(rewritten) ? rewritten.join(", ") : String(rewritten);
          } else if (Array.isArray(v)) {
            outHeaders[lower] = v.join(", ");
          } else if (typeof v === "string") {
            outHeaders[lower] = v;
          }
        }

        const chunks = [];
        let total = 0;
        const maxBytes = 10 * 1024 * 1024;
        let sseTimer = null;
        const finishResponse = () => {
          if (sseTimer) clearTimeout(sseTimer);
          let buf = Buffer.concat(chunks);
          if (previewBasePath && buf.length > 0 && method.toUpperCase() !== "HEAD") {
            if (contentType.includes("text/html")) {
              const html = rewriteHtmlForPreview(buf.toString("utf8"), previewBasePath, sessionId, port);
              buf = Buffer.from(html, "utf8");
            } else if (
              contentType.includes("javascript") ||
              contentType.includes("ecmascript") ||
              contentType.includes("mp2t") ||
              /\.(?:[cm]?[jt]sx?)(?:\?|$)/i.test(subpath) ||
              subpath.startsWith("/@vite/") ||
              subpath.startsWith("/@id/") ||
              subpath.startsWith("/src/") ||
              subpath.startsWith("/node_modules/")
            ) {
              const js = rewriteJsForPreview(buf.toString("utf8"), previewBasePath);
              buf = Buffer.from(js, "utf8");
            } else if (contentType.includes("text/css") || /\.css(?:\?|$)/i.test(subpath)) {
              const css = rewriteCssForPreview(buf.toString("utf8"), previewBasePath);
              buf = Buffer.from(css, "utf8");
            }
          }
          done({
            reachable: true,
            status,
            statusText,
            headers: outHeaders,
            bodyBase64: buf.toString("base64"),
            error: null,
          });
        };

        if (isEventStream) {
          sseTimer = setTimeout(() => {
            res.destroy();
            finishResponse();
          }, 350);
        }

        res.on("data", (chunk) => {
          if (total + chunk.length <= maxBytes) {
            chunks.push(chunk);
            total += chunk.length;
          }
        });
        res.on("end", finishResponse);
        res.on("close", finishResponse);
        res.on("error", finishResponse);
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request to 127.0.0.1:${port} timed out`));
    });
    req.on("error", (err) => {
      const code = err?.code ?? "";
      const refused = code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH";
      done({
        reachable: false,
        status: 502,
        statusText: "Bad Gateway",
        headers: {},
        bodyBase64: "",
        error: refused
          ? `No server listening on 127.0.0.1:${port}.`
          : `Could not reach 127.0.0.1:${port}: ${String(err?.message ?? err).slice(0, 200)}`,
      });
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ---- RFC 6455 loopback WebSocket bridge for HMR ----

function encodeWsFrame(opcode, payloadBuffer) {
  const maskKey = randomBytes(4);
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
    maskKey.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    maskKey.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    maskKey.copy(header, 10);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payloadBuffer[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, masked]);
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (offset + headerLen + maskLen + len > buffer.length) break;
    let payload = buffer.subarray(offset + headerLen + maskLen, offset + headerLen + maskLen + len);
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
      payload = unmasked;
    }
    frames.push({ opcode, payload });
    offset += headerLen + maskLen + len;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

export function createPreviewWsManager() {
  const connections = new Map();
  /** @type {Map<string, Set<() => void>>} */
  const sessionWaiters = new Map();

  const notifySession = (sessionId) => {
    const waiters = sessionWaiters.get(sessionId);
    if (!waiters || waiters.size === 0) return;
    sessionWaiters.delete(sessionId);
    for (const wake of waiters) {
      try { wake(); } catch {}
    }
  };

  const pushEvent = (conn, ev) => {
    conn.seq += 1;
    conn.events.push({ seq: conn.seq, ...ev });
    if (conn.events.length > 200) conn.events.splice(0, conn.events.length - 200);
    notifySession(conn.sessionId);
  };

  return {
    open({ sessionId, clientId, port, path = "/", protocols = /** @type {string[]} */ ([]) }) {
      if (!isAllowedPreviewPort(port)) {
        return { ok: false, error: `Port ${port} is not allowed.` };
      }
      const key = `${sessionId}:${clientId}`;
      const existing = connections.get(key);
      if (existing) {
        try { existing.socket?.destroy(); } catch {}
        connections.delete(key);
      }

      const subpath = normalizePreviewSubpath(path);
      const wsKey = randomBytes(16).toString("base64");
      const headers = {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": wsKey,
      };
      if (Array.isArray(protocols) && protocols.length > 0) {
        headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
      }

      const conn = {
        key,
        sessionId,
        clientId,
        port: Number(port),
        seq: 0,
        events: [],
        socket: null,
        closed: false,
        buffer: Buffer.alloc(0),
      };
      connections.set(key, conn);

      const req = httpRequest({
        host: "127.0.0.1",
        port: Number(port),
        method: "GET",
        path: subpath,
        headers,
        timeout: 10_000,
        agent: false,
      });
      conn.req = req;

      req.on("upgrade", (res, socket, head) => {
        conn.socket = socket;
        const selectedProtocol = String(res.headers["sec-websocket-protocol"] ?? "");
        pushEvent(conn, { event: "open", protocol: selectedProtocol });
        const onData = (chunk) => {
          conn.buffer = Buffer.concat([conn.buffer, chunk]);
          const { frames, remaining } = decodeWsFrames(conn.buffer);
          conn.buffer = remaining;
          for (const frame of frames) {
            if (frame.opcode === 0x01 || frame.opcode === 0x02) {
              pushEvent(conn, { event: "message", data: frame.payload.toString("utf8") });
            } else if (frame.opcode === 0x08) {
              conn.closed = true;
              pushEvent(conn, { event: "close", code: 1000, reason: "" });
              socket.end();
            } else if (frame.opcode === 0x09) {
              try { socket.write(encodeWsFrame(0x0a, frame.payload)); } catch {}
            }
          }
        };
        if (head && head.length > 0) onData(head);
        socket.on("data", onData);
        socket.on("close", () => {
          if (!conn.closed) {
            conn.closed = true;
            pushEvent(conn, { event: "close", code: 1000, reason: "" });
          }
        });
        socket.on("error", () => {
          if (!conn.closed) {
            pushEvent(conn, { event: "error" });
            conn.closed = true;
            pushEvent(conn, { event: "close", code: 1006, reason: "" });
          }
        });
      });

      req.on("response", (res) => {
        res.destroy();
        if (!conn.closed) {
          pushEvent(conn, { event: "error" });
          conn.closed = true;
          pushEvent(conn, { event: "close", code: 1006, reason: `HTTP ${res.statusCode}` });
        }
      });

      req.on("error", () => {
        if (!conn.closed) {
          pushEvent(conn, { event: "error" });
          conn.closed = true;
          pushEvent(conn, { event: "close", code: 1006, reason: "" });
        }
      });

      req.end();
      return { ok: true };
    },

    send({ sessionId, clientId, data }) {
      const conn = connections.get(`${sessionId}:${clientId}`);
      if (!conn || conn.closed || !conn.socket) return { ok: false };
      try {
        const payload = Buffer.from(String(data ?? ""), "utf8");
        conn.socket.write(encodeWsFrame(0x01, payload));
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    poll({ sessionId, since = {} }) {
      const events = [];
      const nextSince = { ...since };
      for (const conn of connections.values()) {
        if (conn.sessionId !== sessionId) continue;
        const lastSeq = Number(since[conn.clientId] ?? 0);
        for (const ev of conn.events) {
          if (ev.seq > lastSeq) {
            events.push({ clientId: conn.clientId, ...ev });
            nextSince[conn.clientId] = ev.seq;
          }
        }
        if (conn.closed && (nextSince[conn.clientId] ?? 0) >= conn.seq) {
          connections.delete(conn.key);
        }
      }
      return { events, nextSince };
    },

    async pollAsync({ sessionId, since = {}, waitMs = 0 }) {
      const immediate = this.poll({ sessionId, since });
      const clampedWait = Math.max(0, Math.min(12_000, Number(waitMs) || 0));
      if (immediate.events.length > 0 || clampedWait <= 0) {
        return immediate;
      }
      await new Promise((resolveWake) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sessionWaiters.get(sessionId)?.delete(done);
          resolveWake(undefined);
        };
        const timer = setTimeout(done, clampedWait);
        let set = sessionWaiters.get(sessionId);
        if (!set) {
          set = new Set();
          sessionWaiters.set(sessionId, set);
        }
        set.add(done);
      });
      return this.poll({ sessionId, since });
    },

    close({ sessionId, clientId }) {
      const key = `${sessionId}:${clientId}`;
      const conn = connections.get(key);
      if (!conn) return { ok: true };
      conn.closed = true;
      try {
        conn.socket?.write(encodeWsFrame(0x08, Buffer.alloc(0)));
        conn.socket?.destroy();
        conn.req?.destroy();
      } catch {}
      connections.delete(key);
      return { ok: true };
    },

    closeAllForSession(sessionId) {
      for (const [key, conn] of connections.entries()) {
        if (conn.sessionId !== sessionId) continue;
        conn.closed = true;
        try {
          conn.socket?.destroy();
          conn.req?.destroy();
        } catch {}
        connections.delete(key);
      }
      notifySession(sessionId);
    },
  };
}

function escapeXmlText(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripHtmlTags(html) {
  return String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&rarr;|&#8594;/gi, "→")
    .replace(/&larr;|&#8592;/gi, "←")
    .replace(/&middot;|&#183;/gi, "·")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagTexts(html, tag, limit = 3) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const cleaned = stripHtmlTags(m[1]);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function buildPreviewSnapshotSvg({ url, headline, subtitle, paragraphs, actions }) {
  const safeUrl = escapeXmlText(url);
  const safeHeadline = escapeXmlText((headline || "Live Dev Server Preview").slice(0, 56));
  const safeSubtitle = escapeXmlText((subtitle || "").slice(0, 80));
  const p1 = escapeXmlText((paragraphs[0] || "").slice(0, 88));
  const p2 = escapeXmlText((paragraphs[1] || "").slice(0, 88));
  let btnX = 72;
  const actionRects = [];
  for (const act of actions.slice(0, 3)) {
    const label = act.slice(0, 28);
    const width = Math.max(96, Math.min(260, label.length * 8 + 32));
    if (btnX + width > 730) break;
    actionRects.push(
      `<rect x="${btnX}" y="294" width="${width}" height="36" rx="8" fill="#21262d" stroke="#30363d"/>` +
        `<text x="${btnX + 16}" y="317" fill="#e6edf3" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="500">${escapeXmlText(label)}</text>`,
    );
    btnX += width + 12;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 440" width="800" height="440">
  <rect width="800" height="440" rx="14" fill="#0f141c"/>
  <rect x="0" y="0" width="800" height="42" fill="#161b22"/>
  <circle cx="20" cy="21" r="6" fill="#ff5f56"/>
  <circle cx="40" cy="21" r="6" fill="#ffbd2e"/>
  <circle cx="60" cy="21" r="6" fill="#27c93f"/>
  <rect x="90" y="9" width="620" height="24" rx="6" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
  <text x="106" y="25" fill="#8b949e" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${safeUrl}</text>
  <rect x="44" y="72" width="712" height="332" rx="12" fill="#161b22" stroke="#30363d" stroke-width="1.5"/>
  <rect x="72" y="98" width="136" height="24" rx="12" fill="#1b3826"/>
  <text x="86" y="114" fill="#3fb950" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" font-weight="600">● LIVE PREVIEW</text>
  <text x="72" y="162" fill="#58a6ff" font-family="system-ui, -apple-system, sans-serif" font-size="25" font-weight="700">${safeHeadline}</text>
  ${safeSubtitle ? `<text x="72" y="196" fill="#8b949e" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14">${safeSubtitle}</text>` : ""}
  ${p1 ? `<text x="72" y="234" fill="#c9d1d9" font-family="system-ui, -apple-system, sans-serif" font-size="14">${p1}</text>` : ""}
  ${p2 ? `<text x="72" y="260" fill="#8b949e" font-family="system-ui, -apple-system, sans-serif" font-size="14">${p2}</text>` : ""}
  ${actionRects.join("\n  ")}
</svg>`;
}

/**
 * Capture a screenshot of `http://127.0.0.1:<port><path>` into `.code-space/`
 * inside `workspaceRoot` and return a clickable Markdown image link.
 */
export async function capturePreviewScreenshot({
  workspaceRoot,
  port,
  path = "/",
  title = "Live preview",
}) {
  const numPort = Number(port);
  if (!isAllowedPreviewPort(numPort)) {
    return {
      ok: false,
      error: `Port ${port} is not an allowed loopback preview port (expected 1024–65535).`,
    };
  }
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return { ok: false, error: "Session workspace directory does not exist." };
  }
  const reachable = await probeLocalPort(numPort);
  if (!reachable) {
    return {
      ok: false,
      error: `No server is currently listening on 127.0.0.1:${numPort}.`,
    };
  }
  const subpath = normalizePreviewSubpath(path);
  const targetUrl = `http://127.0.0.1:${numPort}${subpath}`;
  const outDir = join(workspaceRoot, ".code-space");
  mkdirSync(outDir, { recursive: true });
  const pngName = `preview-${numPort}.png`;
  const svgName = `preview-${numPort}.svg`;
  const pngPath = join(outDir, pngName);
  const svgPath = join(outDir, svgName);

  // 1. Try headless Chromium on Linux/VM hosts if available
  let wrotePng = false;
  if (process.platform === "linux") {
    for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      const ok = await new Promise((resolveDone) => {
        execFile(
          bin,
          [
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--hide-scrollbars",
            "--window-size=1280,720",
            `--screenshot=${pngPath}`,
            targetUrl,
          ],
          { timeout: 8000 },
          (err) => {
            try {
              resolveDone(!err && existsSync(pngPath) && statSync(pngPath).size > 0);
            } catch {
              resolveDone(false);
            }
          },
        );
      });
      if (ok) {
        wrotePng = true;
        break;
      }
    }
  }

  // 2. Fallback: fetch the live HTML from 127.0.0.1:<port> and render a
  //    snapshot SVG (converted to PNG via `sips` on macOS when available).
  let relImagePath = `.code-space/${pngName}`;
  if (!wrotePng) {
    const res = await proxyPreviewHttpRequest({
      port: numPort,
      method: "GET",
      path: subpath,
      headers: { accept: "text/html,*/*" },
    });
    const html = res.bodyBase64 ? Buffer.from(res.bodyBase64, "base64").toString("utf8") : "";
    const titles = extractTagTexts(html, "title", 1);
    const h1s = extractTagTexts(html, "h1", 2);
    const h2s = extractTagTexts(html, "h2", 2);
    const ps = extractTagTexts(html, "p", 3);
    const buttons = [
      ...extractTagTexts(html, "button", 3),
      ...extractTagTexts(html, "a", 3),
    ];
    const headline = h1s[0] || titles[0] || h2s[0] || `${title} (:${numPort})`;
    const subtitle = ps[0] && ps[0].length < 48 ? ps[0] : `127.0.0.1:${numPort}${subpath}`;
    const bodyParagraphs = ps[0] === subtitle ? ps.slice(1) : ps;
    const svg = buildPreviewSnapshotSvg({
      url: targetUrl,
      headline,
      subtitle,
      paragraphs: bodyParagraphs.length > 0 ? bodyParagraphs : [stripHtmlTags(html).slice(0, 120)],
      actions: buttons,
    });
    writeFileSync(svgPath, svg, "utf8");
    const converted = await new Promise((resolveDone) => {
      execFile("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { timeout: 5000 }, (err) => {
        try {
          resolveDone(!err && existsSync(pngPath) && statSync(pngPath).size > 0);
        } catch {
          resolveDone(false);
        }
      });
    });
    relImagePath = converted ? `.code-space/${pngName}` : `.code-space/${svgName}`;
  }

  const safeTitle = String(title || "Live preview").replace(/[\[\]]/g, "").trim() || "Live preview";
  const markdown = `[![${safeTitle} (:${numPort})](${relImagePath})](${targetUrl})`;
  return {
    ok: true,
    port: numPort,
    path: subpath,
    imagePath: relImagePath,
    previewUrl: targetUrl,
    markdown,
    text:
      `Captured preview screenshot of ${targetUrl} to \`${relImagePath}\`.\n` +
      `Include this Markdown in your reply so the user sees the screenshot and can click it to open the live Preview tab:\n\n` +
      markdown,
  };
}

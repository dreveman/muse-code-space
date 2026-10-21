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

export const DEFAULT_FORBIDDEN_PREVIEW_PORTS = new Set([443, 18790, 18791, 18792, 18793]);

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

function guessMimeType(subpath, contentTypeHeader = "") {
  const ct = String(contentTypeHeader || "").split(";")[0].trim().toLowerCase();
  if (ct && ct !== "application/octet-stream") return ct;
  const clean = String(subpath || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".svg")) return "image/svg+xml";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".ico")) return "image/x-icon";
  if (clean.endsWith(".woff2")) return "font/woff2";
  if (clean.endsWith(".woff")) return "font/woff";
  if (clean.endsWith(".ttf")) return "font/ttf";
  if (clean.endsWith(".css")) return "text/css";
  if (clean.endsWith(".js") || clean.endsWith(".mjs") || clean.endsWith(".jsx") || clean.endsWith(".ts") || clean.endsWith(".tsx")) {
    return "application/javascript";
  }
  return "application/octet-stream";
}

function resolveLocalPreviewPath(rawRef, baseSubpath, port) {
  if (typeof rawRef !== "string") return null;
  const trimmed = rawRef.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:") || trimmed.startsWith("mailto:") || trimmed.startsWith("javascript:") || trimmed.startsWith("#")) {
    return null;
  }
  try {
    const baseUrl = new URL(baseSubpath || "/", `http://127.0.0.1:${port}`);
    const resolved = new URL(trimmed, baseUrl);
    const isLocalHost =
      resolved.hostname === "127.0.0.1" ||
      resolved.hostname === "localhost" ||
      resolved.hostname === "0.0.0.0";
    const resolvedPort = resolved.port ? Number(resolved.port) : (resolved.protocol === "https:" ? 443 : 80);
    if (!isLocalHost || resolvedPort !== Number(port)) return null;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
}

function fetchRawLocalResource(port, subpath, extraHeaders = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(port),
        method: "GET",
        path: normalizePreviewSubpath(subpath),
        headers: {
          host: `127.0.0.1:${port}`,
          connection: "close",
          "accept-encoding": "identity",
          ...extraHeaders,
        },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const contentType = String(res.headers["content-type"] ?? "");
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          if (total + c.length <= 5 * 1024 * 1024) {
            chunks.push(c);
            total += c.length;
          }
        });
        const finish = () => {
          done({
            ok: status >= 200 && status < 300,
            status,
            contentType,
            buffer: Buffer.concat(chunks),
          });
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", () => done({ ok: false, status: 502, contentType: "", buffer: Buffer.alloc(0) }));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => done({ ok: false, status: 502, contentType: "", buffer: Buffer.alloc(0) }));
    req.end();
  });
}

async function inlineCssUrls(cssText, cssSubpath, port) {
  if (typeof cssText !== "string" || !cssText) return "";
  const urlRe = /url\(\s*(["']?)([^)"']+)\1\s*\)/gi;
  const matches = [...cssText.matchAll(urlRe)];
  if (matches.length === 0) return cssText;
  const replacements = new Map();
  await Promise.all(
    matches.map(async (m) => {
      const rawUrl = m[2]?.trim() ?? "";
      if (!rawUrl || replacements.has(rawUrl)) return;
      const localPath = resolveLocalPreviewPath(rawUrl, cssSubpath, port);
      if (!localPath) return;
      const res = await fetchRawLocalResource(port, localPath);
      if (res.ok && res.buffer.length > 0) {
        const mime = guessMimeType(localPath, res.contentType);
        replacements.set(rawUrl, `data:${mime};base64,${res.buffer.toString("base64")}`);
      }
    }),
  );
  if (replacements.size === 0) return cssText;
  return cssText.replace(urlRe, (full, _q, rawUrl) => {
    const rep = replacements.get(rawUrl?.trim() ?? "");
    return rep ? `url("${rep}")` : full;
  });
}

/**
 * Transform an ES module's static `import` / `export` / `import.meta` syntax
 * into a CommonJS-like factory body for `window.__cs_define(moduleId, fn)` so
 * module graphs execute inside `<iframe srcdoc>` under strict nonce CSP without
 * needing Service Workers or external module HTTP requests.
 */
export function transformEsModuleForSrcdoc(jsCode, modulePath, port) {
  const discoveredImports = new Set();
  const discoveredDynamicImports = new Set();
  let importCounter = 0;
  let reexportCounter = 0;
  const deferredExports = [];

  const resolveImport = (spec) => {
    if (spec === "/@vite/client" || spec.startsWith("/@vite/client?")) return "/@vite/client";
    const local = resolveLocalPreviewPath(spec, modulePath, port);
    if (local) {
      discoveredImports.add(local);
      return local;
    }
    return spec;
  };

  const parseNamedBindings = (braceContent, targetObjExpr) => {
    const parts = braceContent
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const decls = [];
    for (const part of parts) {
      const m = part.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
      if (!m) continue;
      const imported = m[1];
      const local = m[2] || m[1];
      if (imported === "default") {
        decls.push(`const ${local} = __cs_interopDefault(${targetObjExpr});`);
      } else {
        decls.push(`const ${local} = ${targetObjExpr}.${imported};`);
      }
    }
    return decls.join(" ");
  };

  let transformed = String(jsCode ?? "");

  // Replace import.meta.url / import.meta.hot / import.meta.env
  transformed = transformed.replace(/\bimport\.meta\b/g, "__cs_import_meta");

  // Transform dynamic import("..."). Literal specs that resolve to the local
  // server are collected for the eager crawl so `__cs_dynamic_import` finds
  // them bundled at runtime; anything else keeps its spec and falls back to
  // the (possibly empty) runtime miss path.
  transformed = transformed.replace(
    /\bimport\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/g,
    (_full, _q, spec) => {
      const local = resolveLocalPreviewPath(spec, modulePath, port);
      if (local) discoveredDynamicImports.add(local);
      return `__cs_dynamic_import(${JSON.stringify(local || spec)})`;
    },
  );

  // 1. Side-effect import: import "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*import\s*(["'])([^"'\r\n]+)\2\s*;?/g,
    (_full, prefix, _q, spec) => {
      const resolved = resolveImport(spec);
      return `${prefix}__cs_require(${JSON.stringify(resolved)});`;
    },
  );

  // 2. import * as ns from "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s+from\s*(["'])([^"'\r\n]+)\3\s*;?/g,
    (_full, prefix, ns, _q, spec) => {
      const resolved = resolveImport(spec);
      return `${prefix}const ${ns} = __cs_require(${JSON.stringify(resolved)});`;
    },
  );

  // 3. import def, { a, b as c } from "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*import\s+([A-Za-z0-9_$]+)\s*,\s*\{([^}]*)\}\s*from\s*(["'])([^"'\r\n]+)\4\s*;?/g,
    (_full, prefix, defName, named, _q, spec) => {
      const resolved = resolveImport(spec);
      const tmp = `__cs_imp_${importCounter++}`;
      return `${prefix}const ${tmp} = __cs_require(${JSON.stringify(resolved)}); const ${defName} = __cs_interopDefault(${tmp}); ${parseNamedBindings(named, tmp)}`;
    },
  );

  // 4. import def, * as ns from "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*import\s+([A-Za-z0-9_$]+)\s*,\s*\*\s*as\s+([A-Za-z0-9_$]+)\s+from\s*(["'])([^"'\r\n]+)\4\s*;?/g,
    (_full, prefix, defName, ns, _q, spec) => {
      const resolved = resolveImport(spec);
      return `${prefix}const ${ns} = __cs_require(${JSON.stringify(resolved)}); const ${defName} = __cs_interopDefault(${ns});`;
    },
  );

  // 5. import { a, b as c } from "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*import\s*\{([^}]*)\}\s*from\s*(["'])([^"'\r\n]+)\3\s*;?/g,
    (_full, prefix, named, _q, spec) => {
      const resolved = resolveImport(spec);
      const tmp = `__cs_imp_${importCounter++}`;
      return `${prefix}const ${tmp} = __cs_require(${JSON.stringify(resolved)}); ${parseNamedBindings(named, tmp)}`;
    },
  );

  // 6. import def from "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*import\s+([A-Za-z0-9_$]+)\s+from\s*(["'])([^"'\r\n]+)\3\s*;?/g,
    (_full, prefix, defName, _q, spec) => {
      const resolved = resolveImport(spec);
      return `${prefix}const ${defName} = __cs_interopDefault(__cs_require(${JSON.stringify(resolved)}));`;
    },
  );

  // 7. export * from "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*export\s*\*\s*from\s*(["'])([^"'\r\n]+)\2\s*;?/g,
    (_full, prefix, _q, spec) => {
      const resolved = resolveImport(spec);
      return `${prefix}Object.assign(__cs_exports, __cs_require(${JSON.stringify(resolved)}));`;
    },
  );

  // 8. export { a, b as c } from "spec";
  transformed = transformed.replace(
    /(^|[\r\n])\s*export\s*\{([^}]*)\}\s*from\s*(["'])([^"'\r\n]+)\3\s*;?/g,
    (_full, prefix, named, _q, spec) => {
      const resolved = resolveImport(spec);
      const tmp = `__cs_re_${reexportCounter++}`;
      const props = named
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((part) => {
          const m = part.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
          if (!m) return "";
          const orig = m[1];
          const exp = m[2] || m[1];
          return `Object.defineProperty(__cs_exports, ${JSON.stringify(exp)}, { enumerable: true, configurable: true, get: function() { return ${tmp}.${orig}; } });`;
        })
        .join(" ");
      return `${prefix}const ${tmp} = __cs_require(${JSON.stringify(resolved)}); ${props}`;
    },
  );

  // 9. export { a, b as c };
  transformed = transformed.replace(
    /(^|[\r\n])\s*export\s*\{([^}]*)\}\s*;?/g,
    (_full, prefix, named) => {
      const props = named
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((part) => {
          const m = part.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
          if (!m) return "";
          const local = m[1];
          const exp = m[2] || m[1];
          return `Object.defineProperty(__cs_exports, ${JSON.stringify(exp)}, { enumerable: true, configurable: true, get: function() { return ${local}; } });`;
        })
        .join(" ");
      return `${prefix}${props}`;
    },
  );

  // 10. export default function name / class name / expression
  transformed = transformed.replace(
    /(^|[\r\n])\s*export\s+default\s+((?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+))/g,
    (_full, prefix, decl, fnName, clsName) => {
      const id = fnName || clsName;
      deferredExports.push(`__cs_exports.default = ${id};`);
      return `${prefix}${decl}`;
    },
  );
  transformed = transformed.replace(
    /(^|[\r\n])\s*export\s+default\s+/g,
    "$1__cs_exports.default = ",
  );

  // 11. export async function name / export function name / export class name
  transformed = transformed.replace(
    /(^|[\r\n])\s*export\s+((?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+))/g,
    (_full, prefix, decl, fnName, clsName) => {
      const id = fnName || clsName;
      deferredExports.push(
        `Object.defineProperty(__cs_exports, ${JSON.stringify(id)}, { enumerable: true, configurable: true, get: function() { return ${id}; } });`,
      );
      return `${prefix}${decl}`;
    },
  );

  // 12. export const/let/var name = ...
  transformed = transformed.replace(
    /(^|[\r\n])\s*export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/g,
    (_full, prefix, kw, id) => {
      deferredExports.push(
        `Object.defineProperty(__cs_exports, ${JSON.stringify(id)}, { enumerable: true, configurable: true, get: function() { return ${id}; } });`,
      );
      return `${prefix}${kw} ${id}`;
    },
  );

  if (deferredExports.length > 0) {
    transformed += `\n${deferredExports.join("\n")}`;
  }

  return {
    code: transformed,
    imports: [...discoveredImports],
    dynamicImports: [...discoveredDynamicImports],
  };
}

function buildSrcdocBootstrapScript({ sessionId, port, subpath, hasViteClient }) {
  const cfg = JSON.stringify({
    sessionId: String(sessionId || ""),
    port: Number(port) || 0,
    subpath: String(subpath || "/"),
    hasViteClient: Boolean(hasViteClient),
  }).replace(/</g, "\\u003c");
  return `<script nonce="__CS_CSP_NONCE__">(() => {
  if (window.__codeSpacePreviewBootstrapped) return;
  window.__codeSpacePreviewBootstrapped = true;
  const CFG = ${cfg};
  const VIRTUAL_ORIGIN = "http://127.0.0.1:" + CFG.port;
  const VIRTUAL_HREF = VIRTUAL_ORIGIN + (CFG.subpath || "/");

  // Patch window.URL so relative URLs resolved against about:srcdoc or blob:null
  // (such as @hatch/space-sdk's resolveEndpoint("./actions")) resolve against VIRTUAL_HREF.
  const OrigURL = window.URL;
  function PatchedURL(url, base) {
    if (base !== undefined) {
      const baseStr = String(base);
      if (baseStr === "about:srcdoc" || baseStr.startsWith("about:") || baseStr.startsWith("blob:")) {
        return new OrigURL(url, VIRTUAL_HREF);
      }
      return new OrigURL(url, base);
    }
    const urlStr = String(url);
    if (urlStr === "about:srcdoc" || urlStr.startsWith("blob:null")) {
      return new OrigURL(VIRTUAL_HREF);
    }
    return new OrigURL(url);
  }
  PatchedURL.createObjectURL = OrigURL.createObjectURL.bind(OrigURL);
  PatchedURL.revokeObjectURL = OrigURL.revokeObjectURL.bind(OrigURL);
  if (OrigURL.canParse) PatchedURL.canParse = OrigURL.canParse.bind(OrigURL);
  PatchedURL.prototype = OrigURL.prototype;
  window.URL = PatchedURL;

  function toServerPath(rawUrl) {
    if (typeof rawUrl !== "string") return null;
    const t = rawUrl.trim();
    if (!t || t.startsWith("data:") || t.startsWith("blob:") || t.startsWith("mailto:") || t.startsWith("javascript:") || t.startsWith("#")) return null;
    if (t.startsWith("/") && !t.startsWith("//")) return t;
    try {
      const u = new OrigURL(t, VIRTUAL_HREF);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "0.0.0.0") {
        if (!u.port || Number(u.port) === CFG.port) {
          return u.pathname + u.search;
        }
      }
    } catch {}
    return null;
  }

  // ---- HTTP bridge via window.parent.postMessage (works inside cvm-frame blob:null) ----
  const pendingHttp = new Map();
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "code-space:preview-http-res" && typeof d.reqId === "string") {
      const entry = pendingHttp.get(d.reqId);
      if (entry) {
        pendingHttp.delete(d.reqId);
        entry.resolve(d);
      }
    } else if (d.type === "code-space:preview-dom-patch" && typeof d.html === "string") {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(d.html, "text/html");
        doc.querySelectorAll("style[data-preview-href]").forEach((newStyle) => {
          const href = newStyle.getAttribute("data-preview-href");
          const existing = document.querySelector('style[data-preview-href="' + href + '"]');
          if (existing) existing.textContent = newStyle.textContent;
          else document.head.appendChild(newStyle.cloneNode(true));
        });
        if (doc.body && document.body && !window.__cs_has_custom_hmr) {
          document.body.innerHTML = doc.body.innerHTML;
        }
      } catch {}
    }
  });

  function requestViaParent({ method = "GET", path = "/", headers = {}, bodyBase64 = null }) {
    return new Promise((resolve, reject) => {
      const reqId = "req-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => {
        pendingHttp.delete(reqId);
        reject(new Error("Preview request timed out: " + path));
      }, 15000);
      pendingHttp.set(reqId, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
      });
      window.parent.postMessage({
        type: "code-space:preview-http-req",
        reqId,
        sessionId: CFG.sessionId,
        port: CFG.port,
        method,
        path,
        headers,
        bodyBase64,
      }, "*");
    });
  }

  function base64ToUint8Array(b64) {
    if (!b64) return new Uint8Array(0);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function uint8ArrayToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function(input, init) {
    const rawUrl = typeof input === "string" ? input : (input instanceof URL ? input.toString() : (input && typeof input.url === "string" ? input.url : ""));
    const srvPath = toServerPath(rawUrl);
    if (!srvPath) {
      if (origFetch) return origFetch(input, init);
      throw new Error("fetch unavailable");
    }
    const method = (init && init.method) || (input && input.method) || "GET";
    const headers = {};
    if (init && init.headers) {
      new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    }
    let bodyBase64 = null;
    if (init && init.body != null && method !== "GET" && method !== "HEAD") {
      if (typeof init.body === "string") {
        bodyBase64 = uint8ArrayToBase64(new TextEncoder().encode(init.body));
      } else if (init.body instanceof Uint8Array) {
        bodyBase64 = uint8ArrayToBase64(init.body);
      } else if (init.body instanceof ArrayBuffer) {
        bodyBase64 = uint8ArrayToBase64(new Uint8Array(init.body));
      }
    }
    const res = await requestViaParent({ method, path: srvPath, headers, bodyBase64 });
    const bytes = base64ToUint8Array(res.bodyBase64 || "");
    const status = res.status >= 100 && res.status <= 599 ? res.status : 200;
    return new Response(status === 204 || status === 304 || method === "HEAD" ? null : bytes, {
      status,
      statusText: res.statusText || "",
      headers: res.headers || {},
    });
  };

  // ---- Intercept dynamic <img> / Image() relative URLs inside about:srcdoc ----
  const imgDataCache = new Map();
  function fetchImageDataUri(srvPath) {
    if (imgDataCache.has(srvPath)) return imgDataCache.get(srvPath);
    const p = requestViaParent({ method: "GET", path: srvPath }).then((res) => {
      if (!res || !res.bodyBase64 || res.status >= 400) return null;
      const ct = (res.headers && res.headers["content-type"]) || (srvPath.endsWith(".webp") ? "image/webp" : srvPath.endsWith(".svg") ? "image/svg+xml" : "image/png");
      return "data:" + ct.split(";")[0] + ";base64," + res.bodyBase64;
    }).catch(() => null);
    imgDataCache.set(srvPath, p);
    return p;
  }

  const imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (imgSrcDesc && imgSrcDesc.set && imgSrcDesc.get) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: true,
      get() { return imgSrcDesc.get.call(this); },
      set(val) {
        const srvPath = toServerPath(String(val || ""));
        if (srvPath) {
          fetchImageDataUri(srvPath).then((uri) => {
            if (uri) imgSrcDesc.set.call(this, uri);
          });
          return;
        }
        imgSrcDesc.set.call(this, val);
      },
    });
  }

  function rewriteImgElement(el) {
    if (!el || el.tagName !== "IMG") return;
    const raw = el.getAttribute("src");
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return;
    const srvPath = toServerPath(raw);
    if (!srvPath) return;
    fetchImageDataUri(srvPath).then((uri) => {
      if (uri && el.getAttribute("src") === raw) {
        el.setAttribute("src", uri);
      }
    });
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.target && m.target.tagName === "IMG") {
        rewriteImgElement(m.target);
      } else if (m.type === "childList") {
        m.addedNodes.forEach((n) => {
          if (n && n.nodeType === 1) {
            if (n.tagName === "IMG") rewriteImgElement(n);
            else if (typeof n.querySelectorAll === "function") {
              n.querySelectorAll("img[src]").forEach(rewriteImgElement);
            }
          }
        });
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });

  // Shim EventSource for local paths (e.g. /__dev/events) inside about:srcdoc
  const OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    window.EventSource = function(url, dict) {
      const srvPath = toServerPath(String(url || ""));
      if (srvPath) {
        const dummy = new EventTarget();
        dummy.readyState = 1;
        dummy.url = VIRTUAL_ORIGIN + srvPath;
        dummy.close = function() { this.readyState = 2; };
        return dummy;
      }
      return new OrigEventSource(url, dict);
    };
  }

  // ---- Intercept link clicks and form submissions for multi-page navigation ----
  document.addEventListener("click", (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const anchor = ev.target && typeof ev.target.closest === "function" ? ev.target.closest("a[href]") : null;
    if (!anchor) return;
    const rawHref = anchor.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#") || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const srvPath = toServerPath(rawHref);
    if (!srvPath) return;
    ev.preventDefault();
    window.parent.postMessage({
      type: "code-space:preview-navigate",
      sessionId: CFG.sessionId,
      method: "GET",
      path: srvPath,
    }, "*");
  });

  document.addEventListener("submit", (ev) => {
    if (ev.defaultPrevented) return;
    const form = ev.target;
    if (!form || form.tagName !== "FORM") return;
    const rawAction = form.getAttribute("action") || CFG.subpath || "/";
    const srvPath = toServerPath(rawAction);
    if (!srvPath) return;
    ev.preventDefault();
    const method = String(form.method || "GET").toUpperCase();
    const fd = new FormData(form);
    const params = new URLSearchParams();
    fd.forEach((v, k) => { if (typeof v === "string") params.append(k, v); });
    if (method === "GET") {
      const sep = srvPath.includes("?") ? "&" : "?";
      const qs = params.toString();
      window.parent.postMessage({
        type: "code-space:preview-navigate",
        sessionId: CFG.sessionId,
        method: "GET",
        path: qs ? srvPath + sep + qs : srvPath,
      }, "*");
    } else {
      const bodyBytes = new TextEncoder().encode(params.toString());
      window.parent.postMessage({
        type: "code-space:preview-navigate",
        sessionId: CFG.sessionId,
        method,
        path: srvPath,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        bodyBase64: uint8ArrayToBase64(bodyBytes),
      }, "*");
    }
  });

  // ---- WebSocket bridge via window.parent.postMessage ----
  const NativeWS = window.WebSocket;
  class PreviewWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.CONNECTING = 0;
      this.OPEN = 1;
      this.CLOSING = 2;
      this.CLOSED = 3;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.extensions = "";
      this.binaryType = "blob";
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      const wsPath = toServerPath(String(url).replace(/^wss?:/i, "http:")) || "/";
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
        path: wsPath,
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
    return new PreviewWebSocket(url, protocols);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // ---- ES Module Registry & Vite HMR shim ----
  const factories = Object.create(null);
  const cache = Object.create(null);
  const hotModules = Object.create(null);

  window.__cs_interopDefault = function(mod) {
    return mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
  };

  window.__cs_updateStyle = function(id, content) {
    let el = document.querySelector('style[data-vite-dev-id="' + id + '"]');
    if (!el) {
      el = document.createElement("style");
      el.setAttribute("data-vite-dev-id", id);
      document.head.appendChild(el);
    }
    el.textContent = content;
  };

  window.__cs_removeStyle = function(id) {
    const el = document.querySelector('style[data-vite-dev-id="' + id + '"]');
    if (el) el.remove();
  };

  window.__cs_createHotContext = function(ownerPath) {
    const key = String(ownerPath || "").split("?")[0];
    if (!hotModules[key]) {
      hotModules[key] = { data: {}, callbacks: [], disposeCallbacks: [] };
    }
    const entry = hotModules[key];
    return {
      get data() { return entry.data; },
      accept(deps, cb) {
        window.__cs_has_custom_hmr = true;
        if (typeof deps === "function") entry.callbacks.push(deps);
        else if (typeof cb === "function") entry.callbacks.push(cb);
      },
      dispose(cb) {
        if (typeof cb === "function") entry.disposeCallbacks.push(cb);
      },
      prune() {},
      invalidate() {
        window.parent.postMessage({ type: "code-space:preview-hmr-reload", sessionId: CFG.sessionId }, "*");
      },
      on() {},
      off() {},
      send() {},
    };
  };

  cache["/@vite/client"] = {
    createHotContext: window.__cs_createHotContext,
    updateStyle: window.__cs_updateStyle,
    removeStyle: window.__cs_removeStyle,
    injectQuery: (u) => u,
  };

  window.__cs_define = function(id, factory) {
    const cleanId = String(id).split("?")[0];
    factories[id] = factory;
    factories[cleanId] = factory;
  };

  window.__cs_require = function(id, forceReload = false) {
    const cleanId = String(id).split("?")[0];
    if (!forceReload) {
      if (cache[id]) return cache[id];
      if (cache[cleanId]) return cache[cleanId];
    }
    const fn = factories[id] || factories[cleanId];
    if (!fn) {
      console.warn("[Preview] Module not found:", id);
      return {};
    }
    const exportsObj = {};
    cache[id] = exportsObj;
    cache[cleanId] = exportsObj;
    const meta = {
      url: VIRTUAL_ORIGIN + cleanId,
      env: { DEV: true, PROD: false, MODE: "development", BASE_URL: "/" },
      hot: window.__cs_createHotContext(cleanId),
    };
    fn(window.__cs_require, exportsObj, meta);
    return exportsObj;
  };

  window.__cs_dynamic_import = async function(id) {
    const cleanId = String(id).split("?")[0];
    if (factories[id] || factories[cleanId]) {
      return window.__cs_require(id);
    }
    console.warn("[Preview] Dynamically imported module was not bundled:", id);
    return {};
  };

  if (CFG.hasViteClient) {
    const hmrWs = new PreviewWebSocket("ws://127.0.0.1:" + CFG.port + "/", "vite-hmr");
    hmrWs.addEventListener("message", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.type === "update" || payload.type === "full-reload") {
          window.parent.postMessage({
            type: "code-space:preview-hmr-reload",
            sessionId: CFG.sessionId,
            payload,
          }, "*");
        }
      } catch {}
    });
  }
})();</script>`;
}

export async function bundleHtmlForSrcdocPreview(html, { port, subpath = "/", sessionId = "" }) {
  if (typeof html !== "string" || !html) return "";
  let out = html;
  let hasViteClient = false;

  // 1. Inline local <link rel="stylesheet" href="...">
  const linkRe = /<link\b[^>]*>/gi;
  const linkMatches = [...out.matchAll(linkRe)];
  for (const m of linkMatches) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(tag)) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
    if (!hrefMatch) continue;
    const localPath = resolveLocalPreviewPath(hrefMatch[2], subpath, port);
    if (!localPath) continue;
    const res = await fetchRawLocalResource(port, localPath, { accept: "text/css,*/*" });
    if (res.ok && !isHtmlResponse(res.contentType)) {
      const cssWithAssets = await inlineCssUrls(res.buffer.toString("utf8"), localPath, port);
      out = out.replace(tag, `<style data-preview-href="${localPath.replace(/"/g, "&quot;")}">${cssWithAssets}</style>`);
    }
  }

  // 2. Inline local <img src="..."> as data: URIs
  const imgRe = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
  const imgMatches = [...out.matchAll(imgRe)];
  const imgMap = new Map();
  await Promise.all(
    imgMatches.map(async (m) => {
      const rawSrc = m[3];
      if (!rawSrc || imgMap.has(rawSrc)) return;
      const localPath = resolveLocalPreviewPath(rawSrc, subpath, port);
      if (!localPath) return;
      const res = await fetchRawLocalResource(port, localPath);
      if (res.ok && res.buffer.length > 0) {
        const mime = guessMimeType(localPath, res.contentType);
        imgMap.set(rawSrc, `data:${mime};base64,${res.buffer.toString("base64")}`);
      }
    }),
  );
  if (imgMap.size > 0) {
    out = out.replace(imgRe, (full, prefix, quote, rawSrc) => {
      const dataUri = imgMap.get(rawSrc);
      return dataUri ? `${prefix}${quote}${dataUri}${quote}` : full;
    });
  }

  // 3. Process <script> tags and crawl local ES module graph
  const moduleDefinitions = new Map();
  const moduleCrawlQueue = [];

  const enqueueModule = (modPath) => {
    const clean = modPath.split("?")[0];
    if (clean === "/@vite/client") {
      hasViteClient = true;
      return;
    }
    if (!moduleDefinitions.has(modPath) && moduleDefinitions.size < 80) {
      moduleDefinitions.set(modPath, null);
      moduleCrawlQueue.push(modPath);
    }
  };

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const scriptMatches = [...out.matchAll(scriptRe)];
  const scriptReplacements = [];

  for (const m of scriptMatches) {
    const fullTag = m[0];
    const attrs = m[1] || "";
    const inlineBody = m[2] || "";
    const isModule = /\btype\s*=\s*(["']?)module\1/i.test(attrs);
    const srcMatch = attrs.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i);
    const rawSrc = srcMatch ? srcMatch[2] : null;

    if (rawSrc) {
      const localPath = resolveLocalPreviewPath(rawSrc, subpath, port);
      if (!localPath) continue;
      if (localPath === "/@vite/client" || localPath.startsWith("/@vite/client?")) {
        hasViteClient = true;
        scriptReplacements.push({ from: fullTag, to: "" });
        continue;
      }
      if (isModule) {
        enqueueModule(localPath);
        scriptReplacements.push({
          from: fullTag,
          to: `\x00CS_MODULE_ENTRY:${localPath}\x00`,
        });
      } else {
        const res = await fetchRawLocalResource(port, localPath, { accept: "application/javascript,*/*" });
        if (res.ok && !isHtmlResponse(res.contentType)) {
          scriptReplacements.push({
            from: fullTag,
            to: `<script nonce="__CS_CSP_NONCE__">\n${escapeClosingScriptTag(res.buffer.toString("utf8"))}\n</script>`,
          });
        }
      }
    } else if (isModule && inlineBody.trim()) {
      const inlineId = `/__inline_module_${scriptReplacements.length}.js`;
      const transformed = transformEsModuleForSrcdoc(inlineBody, subpath, port);
      moduleDefinitions.set(inlineId, transformed.code);
      for (const imp of transformed.imports) enqueueModule(imp);
      for (const imp of transformed.dynamicImports) enqueueModule(imp);
      scriptReplacements.push({
        from: fullTag,
        to: `\x00CS_MODULE_ENTRY:${inlineId}\x00`,
      });
    } else if (inlineBody.trim() && !/\bnonce\s*=/i.test(attrs)) {
      scriptReplacements.push({
        from: fullTag,
        to: `<script nonce="__CS_CSP_NONCE__"${attrs}>${inlineBody}</script>`,
      });
    }
  }

  // Crawl queued ES modules on 127.0.0.1:<port>
  while (moduleCrawlQueue.length > 0) {
    const batch = moduleCrawlQueue.splice(0, 12);
    await Promise.all(
      batch.map(async (modPath) => {
        const res = await fetchRawLocalResource(port, modPath, { accept: "application/javascript,text/javascript,*/*" });
        if (!res.ok) {
          moduleDefinitions.set(modPath, "");
          return;
        }
        const ct = String(res.contentType || "").toLowerCase();
        if (isHtmlResponse(res.contentType)) {
          // Extensionless specifiers (e.g. a lazy chunk id) can resolve to an
          // SPA fallback document instead of JS. Never bundle HTML as a
          // module: it parses as a factory body and throws `Unexpected
          // token '<'`, killing the whole preview. Leave it for the runtime
          // miss path instead.
          moduleDefinitions.set(modPath, "");
          return;
        }
        const rawText = res.buffer.toString("utf8");
        if (ct.includes("text/css") || (modPath.split("?")[0].endsWith(".css") && !rawText.includes("updateStyle") && !rawText.includes("export "))) {
          const inlinedCss = await inlineCssUrls(rawText, modPath, port);
          moduleDefinitions.set(
            modPath,
            `window.__cs_updateStyle(${JSON.stringify(modPath)}, ${JSON.stringify(inlinedCss)});`,
          );
          return;
        }
        const transformed = transformEsModuleForSrcdoc(rawText, modPath, port);
        moduleDefinitions.set(modPath, transformed.code);
        for (const imp of transformed.imports) enqueueModule(imp);
        for (const imp of transformed.dynamicImports) enqueueModule(imp);
      }),
    );
  }

  for (const rep of scriptReplacements) {
    out = out.replace(rep.from, rep.to);
  }

  // Emit defined ES modules before the first __CS_MODULE_ENTRY placeholder
  let modulesEmitted = false;
  const buildModulesBlock = () => {
    const lines = [];
    for (const [modId, code] of moduleDefinitions.entries()) {
      if (typeof code !== "string") continue;
      lines.push(
        `window.__cs_define(${JSON.stringify(modId)}, function(__cs_require, __cs_exports, __cs_import_meta) {\n${escapeClosingScriptTag(code)}\n});`,
      );
    }
    return lines.join("\n");
  };

  out = out.replace(/\x00CS_MODULE_ENTRY:([^\x00]+)\x00/g, (_full, entryId) => {
    const prefix = !modulesEmitted ? ((modulesEmitted = true), buildModulesBlock() + "\n") : "";
    return `<script nonce="__CS_CSP_NONCE__">\n${prefix}window.__cs_require(${JSON.stringify(entryId)});\n</script>`;
  });

  const bootstrap = buildSrcdocBootstrapScript({ sessionId, port, subpath, hasViteClient });
  if (/<head\b[^>]*>/i.test(out)) {
    return out.replace(/<head\b[^>]*>/i, (match) => `${match}${bootstrap}`);
  }
  if (/<html\b[^>]*>/i.test(out)) {
    return out.replace(/<html\b[^>]*>/i, (match) => `${match}<head>${bootstrap}</head>`);
  }
  return `${bootstrap}${out}`;
}

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
        const finishResponse = async () => {
          if (sseTimer) clearTimeout(sseTimer);
          let buf = Buffer.concat(chunks);
          if (previewBasePath === "__srcdoc__") {
            if (
              status >= 300 &&
              status <= 399 &&
              typeof res.headers.location === "string"
            ) {
              const targetPath = resolveLocalPreviewPath(res.headers.location, subpath, port);
              if (targetPath) {
                const redirected = await proxyPreviewHttpRequest({
                  port,
                  method: status === 307 || status === 308 ? method : "GET",
                  path: targetPath,
                  headers,
                  bodyBase64: status === 307 || status === 308 ? bodyBase64 : null,
                  previewBasePath: "__srcdoc__",
                  sessionId,
                  timeoutMs,
                });
                done(redirected);
                return;
              }
            }
            outHeaders["x-preview-final-path"] = subpath;
            if (buf.length > 0 && method.toUpperCase() !== "HEAD" && contentType.includes("text/html")) {
              const bundledHtml = await bundleHtmlForSrcdocPreview(buf.toString("utf8"), {
                port,
                subpath,
                sessionId,
              });
              buf = Buffer.from(bundledHtml, "utf8");
            }
          } else if (previewBasePath && buf.length > 0 && method.toUpperCase() !== "HEAD") {
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
 * Escape `</script` sequences in JavaScript that is inlined into an HTML
 * `<script>` block (srcdoc bundling). The HTML parser terminates a script
 * element at the first case-insensitive `</script`, even one inside a JS
 * string literal (e.g. `innerHTML = "<script></script>"`), which truncates
 * the block and surfaces as `Uncaught SyntaxError` with the app never
 * booting. `<\/script` is equivalent inside string/regex literals and keeps
 * the block intact.
 */
function escapeClosingScriptTag(jsText) {
  return String(jsText ?? "").replace(/<\/script/gi, "<\\/script");
}

/** True when a fetched preview resource is an HTML document (e.g. an SPA
 * fallback served for an extensionless module path) rather than the JS/CSS
 * the bundler asked for. */
function isHtmlResponse(contentType) {
  return String(contentType || "")
    .toLowerCase()
    .includes("text/html");
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
  if (DEFAULT_FORBIDDEN_PREVIEW_PORTS.has(numPort)) {
    return {
      ok: false,
      error: `Port ${port} is reserved by Code Space background services (18790–18793). Use another loopback port (e.g. 4173, 5173, 3000, 8000).`,
    };
  }
  if (!isAllowedPreviewPort(numPort)) {
    return {
      ok: false,
      error: `Port ${port} is not an allowed loopback preview port (expected an integer between 1024 and 65535).`,
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
            "--virtual-time-budget=2500",
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

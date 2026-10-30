// Local dev server for Muse Code Space — a stand-in for the Hatch runtime.
//
//   bun run dev            # http://127.0.0.1:4173
//
// What it does (and what the real host does instead):
// - Builds client/index.html with Bun.build (development mode, sourcemaps)
//   into .dev/dist and rebuilds on every change under client/src. It does NOT
//   use the SDK's buildClient() and never touches client/dist — publishing is
//   still only via the web-artifact builder's plan/build/audit/submit flow.
// - Serves POST /actions exactly like the host's action bridge: body
//   {action, args, actionCallId} → {data} | {error}.
// - Runs server/src/actions.ts handlers in-process with a mock ctx:
//     ctx.db                 drizzle over bun:sqlite at .dev/app.db, with the
//                            drizzle/ migrations applied on start
//     ctx.executePrivileged  runs server/src/privileged.ts handlers in-process
//                            (pilot URL = $MUSE_CODE_SPACE_PILOT_URL, default :18791)
//     ctx.invalidateQueries  pushes a refetch to open tabs over SSE
//     ctx.agent.spawnTask    returns {ok:false} (no supervisor fallback locally)
//     ctx.emit               no-op; ctx.blobs/inference/tool throw
// - Live-reloads the page after each client rebuild. Server-side changes
//   restart the process (`bun --watch`).
//
// The app DB here is a throwaway local file, never the artifact's app.db.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import tailwindPlugin from "bun-plugin-tailwind";
import {
  createPrivilegedExecutor,
  isAction,
  isPrivilegedHandlers,
  type PrivilegedContract,
  type PrivilegedHandler,
} from "@hatch/space-sdk";
import * as schema from "../server/src/schema";

const ROOT = resolve(import.meta.dir, "..");
function resolveSpaceSlug(): string {
  for (const candidate of ["space.json", "space.json.template"]) {
    const filePath = join(ROOT, candidate);
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { slug?: unknown };
      if (typeof parsed.slug === "string" && parsed.slug && parsed.slug !== "__ARTIFACT_SLUG__") {
        return parsed.slug;
      }
    } catch { /* fall through */ }
  }
  return "muse-code-space";
}
const SPACE_SLUG = resolveSpaceSlug();
// MUSE_CODE_SPACE_DEV_DIR keeps a second instance from sharing the
// build output and DB of the one you're using.
const DEV_DIR = resolve(process.env.MUSE_CODE_SPACE_DEV_DIR ?? join(ROOT, ".dev"));
const OUT_DIR = join(DEV_DIR, "dist");
const DB_PATH = process.env.MUSE_CODE_SPACE_DEV_DB ?? join(DEV_DIR, "app.db");
const PORT = Number(process.env.MUSE_CODE_SPACE_DEV_PORT ?? 4173);
const HOST = process.env.MUSE_CODE_SPACE_DEV_HOST ?? "127.0.0.1";

mkdirSync(DEV_DIR, { recursive: true });

// ---- pilot + host paths ----
// Workspace paths are paths on the pilot's machine. actions.ts reads
// MUSE_CODE_SPACE_HOME_ROOT at import time, so ask the pilot for its home first
// (pilots that predate the `home` field, and the fake pilot, keep the VM's
// /home/hatch default).
async function resolveDefaultDevPilotUrl(): Promise<string> {
  if (process.env.MUSE_CODE_SPACE_PILOT_URL) {
    return process.env.MUSE_CODE_SPACE_PILOT_URL.replace(/\/+$/, "");
  }
  for (const candidate of ["http://127.0.0.1:18793", "http://127.0.0.1:18792"]) {
    try {
      const res = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(600) });
      if (res.ok) return candidate;
    } catch {
      // candidate not running
    }
  }
  // On a live Muse VM (/home/hatch exists), 18791 is the production pilot;
  // default local dev to the fake-pilot port (18793) unless explicitly overridden.
  return existsSync("/home/hatch") ? "http://127.0.0.1:18793" : "http://127.0.0.1:18791";
}
const pilotUrl = await resolveDefaultDevPilotUrl();
process.env.MUSE_CODE_SPACE_PILOT_URL = pilotUrl;
const homeCachePath = join(DEV_DIR, "pilot-home.json");
let cachedHome: string | null = null;
try {
  const saved = JSON.parse(readFileSync(homeCachePath, "utf8")) as { pilotUrl?: string; home?: string };
  if (saved.pilotUrl === pilotUrl && saved.home?.startsWith("/")) cachedHome = saved.home;
} catch { /* no pilot home cached yet */ }
let pilotHealth: Record<string, unknown> | null = null;
try {
  const res = await fetch(`${pilotUrl}/health`, { signal: AbortSignal.timeout(2000) });
  pilotHealth = (await res.json()) as Record<string, unknown>;
} catch {
  pilotHealth = null;
}
const liveHome = typeof pilotHealth?.home === "string" && pilotHealth.home.startsWith("/") ? pilotHealth.home : null;
if (liveHome) writeFileSync(homeCachePath, JSON.stringify({ pilotUrl, home: liveHome }));
const defaultHome = !process.env.MUSE_CODE_SPACE_DEV_DIR && !existsSync("/home/hatch") && process.env.HOME?.startsWith("/")
  ? process.env.HOME
  : "/home/hatch";
if (!process.env.MUSE_CODE_SPACE_HOME_ROOT) {
  process.env.MUSE_CODE_SPACE_HOME_ROOT = liveHome ?? cachedHome ?? defaultHome;
}
// A fake pilot never owns real transcripts: force the dev pilot-state dir
// even when the environment already carries the production state dir (a
// Code Space session's shell exports it, and inheriting it would make the
// dev app import — and resurrect on every delete — real session history).
if (pilotHealth?.fake === true) {
  process.env.MUSE_CODE_SPACE_PILOT_STATE_DIR = join(DEV_DIR, "pilot-state");
} else if (!process.env.MUSE_CODE_SPACE_PILOT_STATE_DIR && process.env.MUSE_CODE_SPACE_DEV_DIR) {
  process.env.MUSE_CODE_SPACE_PILOT_STATE_DIR = join(DEV_DIR, "pilot-state");
}
(globalThis as { __MUSE_CODE_SPACE_HOME_ROOT__?: string }).__MUSE_CODE_SPACE_HOME_ROOT__ =
  process.env.MUSE_CODE_SPACE_HOME_ROOT;
const { Actions } = await import("../server/src/actions");
const { privilegedHandlers } = await import("../server/src/privileged");

// ---- database ----
const sqlite = new Database(DB_PATH, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: join(ROOT, "drizzle") });
const activeHomeRoot = process.env.MUSE_CODE_SPACE_HOME_ROOT;
if (activeHomeRoot && activeHomeRoot !== "/home/hatch" && !existsSync("/home/hatch")) {
  sqlite.run(
    "UPDATE sessions SET workspace_root = ? || substr(workspace_root, length('/home/hatch') + 1) WHERE workspace_root LIKE '/home/hatch/%'",
    [activeHomeRoot],
  );
}

// ---- privileged functions ----
if (!isPrivilegedHandlers(privilegedHandlers)) {
  throw new Error("server/src/privileged.ts did not export privilegedHandlers");
}
const privilegedByName = new Map<string, PrivilegedHandler>(
  privilegedHandlers.entries.map((entry) => [entry.contract.name, entry.handler]),
);

// ---- live reload / invalidation channel ----
const listeners = new Set<ReadableStreamDefaultController<string>>();
function broadcast(event: "reload" | "invalidate", payload: Record<string, unknown> = {}) {
  const data = JSON.stringify(payload);
  for (const controller of listeners) {
    try {
      controller.enqueue(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      listeners.delete(controller);
    }
  }
}
const sseHeartbeat = setInterval(() => {
  for (const controller of listeners) {
    try {
      controller.enqueue(": ping\n\n");
    } catch {
      listeners.delete(controller);
    }
  }
}, 25_000);
sseHeartbeat.unref?.();

// Same-origin postMessage is what the SDK's query-invalidation listener
// accepts when the page is top-level (not framed by the Hatch host).
function buildDevClientScript(webToken: string): string {
  return `<script>
(() => {
  const tok = new URLSearchParams(location.search).get("token") || ${JSON.stringify(webToken)} || "";
  window.__MUSE_CODE_SPACE_TOKEN__ = tok;
  if (tok && typeof window.fetch === "function") {
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        if (!headers.has("authorization")) headers.set("authorization", "Bearer " + tok);
        return origFetch(input, { ...init, headers });
      } catch {
        return origFetch(input, init);
      }
    };
  }
  if (typeof EventSource === "undefined") return;
  const esUrl = tok ? "/__dev/events?token=" + encodeURIComponent(tok) : "/__dev/events";
  const es = new EventSource(esUrl);
  es.addEventListener("reload", () => location.reload());
  es.addEventListener("invalidate", (e) => {
    let payload = { queryKeys: [] };
    try { payload = JSON.parse(e.data); } catch {}
    window.postMessage(
      { type: "hatch:space:query-invalidated", payload },
      location.origin,
    );
  });
})();
</script>`;
}

// ---- client build ----
let building: Promise<boolean> | null = null;
let rebuildQueued = false;
async function buildClient(): Promise<boolean> {
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [join(ROOT, "client/index.html")],
    outdir: OUT_DIR,
    splitting: true,
    minify: false,
    sourcemap: "linked",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [tailwindPlugin],
  });
  if (!result.success) {
    console.error("[dev] client build failed:");
    for (const log of result.logs) console.error(log);
    return false;
  }
  console.log(`[dev] client built in ${Math.round(performance.now() - started)}ms`);
  return true;
}
function scheduleBuild() {
  if (building) {
    rebuildQueued = true;
    return;
  }
  building = buildClient().finally(() => {
    building = null;
    if (rebuildQueued) {
      rebuildQueued = false;
      scheduleBuild();
    } else {
      broadcast("reload");
    }
  });
}

await buildClient();
let debounce: Timer | undefined;
for (const dir of ["client/src", "client/index.html"]) {
  watch(join(ROOT, dir), { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(scheduleBuild, 50);
  });
}

// ---- action dispatch ----
const unavailable = (what: string) => () => {
  throw new Error(`${what} is not available in the local dev server`);
};

function makeCtx(actionCallId: string, declared: readonly PrivilegedContract[] | undefined) {
  const executor = createPrivilegedExecutor(declared, async (contract, args) => {
    const handler = privilegedByName.get(contract.name);
    if (!handler) throw new Error(`no privileged handler for ${contract.name}`);
    return handler(args);
  });
  return {
    slug: SPACE_SLUG,
    invocationId: actionCallId,
    spaceDir: ROOT,
    db: () => db,
    viewer: {
      source: "local" as const,
      authenticated: true as const,
      spaceSlug: SPACE_SLUG,
      userId: "local-dev",
      ownerUserId: "local-dev",
      isOwner: true,
    },
    blobs: {
      put: unavailable("ctx.blobs"),
      getUrl: unavailable("ctx.blobs"),
      delete: unavailable("ctx.blobs"),
      head: unavailable("ctx.blobs"),
      list: unavailable("ctx.blobs"),
    },
    agent: {
      spawnTask: async () => ({ ok: false as const, error: "ctx.agent is not available locally" }),
      send: async () => ({ ok: false as const, error: "ctx.agent is not available locally" }),
      status: async (taskId: string) => ({ taskId, status: "not_found" as const }),
    },
    inference: { complete: unavailable("ctx.inference") },
    tool: new Proxy({}, { get: (_t, name) => unavailable(`ctx.tool.${String(name)}`) }),
    emit() {},
    invalidateQueries(invalidation?: unknown) {
      const queryKeys = Array.isArray(invalidation)
        ? [invalidation]
        : invalidation && typeof invalidation === "object" && "queryKey" in invalidation
          ? [(invalidation as { queryKey: unknown }).queryKey]
          : invalidation && typeof invalidation === "object" && "queryKeys" in invalidation
            ? (invalidation as { queryKeys: unknown[] }).queryKeys
            : [];
      broadcast("invalidate", { originActionCallId: actionCallId, queryKeys });
    },
    executePrivileged: executor.executePrivileged,
  };
}

const actions = Actions as Record<string, unknown>;

async function handleAction(req: Request): Promise<Response> {
  let body: { action?: unknown; args?: unknown; actionCallId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.action === "string" ? body.action : "";
  const action = actions[name];
  if (!isAction(action)) {
    return Response.json({ error: `unknown action: ${name}` }, { status: 404 });
  }
  const parsed = action.request.safeParse(body.args ?? {});
  if (!parsed.success) {
    return Response.json({ error: `invalid args for ${name}: ${parsed.error.message}` }, { status: 400 });
  }
  const actionCallId = typeof body.actionCallId === "string" ? body.actionCallId : crypto.randomUUID();
  const started = performance.now();
  try {
    // The mock ctx matches the runtime Ctx shape closely enough for these
    // actions; the cast avoids re-declaring every SDK client type here.
    const ctx = makeCtx(actionCallId, action.privileged) as unknown as Parameters<typeof action.handler>[0];
    const result = await action.handler(ctx, parsed.data);
    const data = action.response.parse(result);
    if (data && typeof data === "object" && "ok" in data && (data as { ok?: unknown }).ok === false) {
      console.warn(`[dev] action ${name} returned ok:false:`, (data as { error?: unknown }).error);
    }
    if (process.env.MUSE_CODE_SPACE_DEV_LOG_ACTIONS === "1") {
      console.log(`[dev] ${name} ${Math.round(performance.now() - started)}ms`);
    }
    return Response.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev] action ${name} failed:`, error);
    return Response.json({ error: message }, { status: 500 });
  }
}

function parseDevPreviewTarget(req: Request, url: URL): { sessionId: string; basePath: string; subpath: string } | null {
  const match = url.pathname.match(/^(.*?\/(?:assets\/)?__preview\/([^/]+))(\/.*)?$/);
  if (match) {
    try {
      const sessionId = decodeURIComponent(match[2]!);
      if (sessionId) return { sessionId, basePath: match[1]!, subpath: match[3] || "/" };
    } catch {
      return null;
    }
  }
  const ref = req.headers.get("referer");
  if (ref) {
    try {
      const refUrl = new URL(ref);
      const refMatch = refUrl.pathname.match(/^(.*?\/(?:assets\/)?__preview\/([^/]+))(\/.*)?$/);
      if (
        refMatch &&
        !url.pathname.endsWith("/actions") &&
        url.pathname !== "/__dev/events" &&
        !/\/chunk-[a-z0-9]+\.(?:js|css)$/i.test(url.pathname)
      ) {
        const sessionId = decodeURIComponent(refMatch[2]!);
        if (sessionId) return { sessionId, basePath: refMatch[1]!, subpath: url.pathname };
      }
    } catch {
      // ignore invalid referer
    }
  }
  return null;
}

async function handlePreviewRoute(
  req: Request,
  url: URL,
  target: { sessionId: string; basePath: string; subpath: string },
): Promise<Response> {
  const previewProxy = actions.previewProxy;
  if (!isAction(previewProxy)) {
    return new Response("previewProxy action unavailable", { status: 500 });
  }
  let bodyBase64: string | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length > 0) bodyBase64 = buf.toString("base64");
    } catch {
      bodyBase64 = null;
    }
  }
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const ctx = makeCtx(`dev-preview-${crypto.randomUUID()}`, previewProxy.privileged) as unknown as Parameters<typeof previewProxy.handler>[0];
  const parsedArgs = previewProxy.request.parse({
    session_id: target.sessionId,
    method: req.method,
    path: `${target.subpath}${url.search}`,
    headers,
    bodyBase64,
    previewBasePath: target.basePath,
  });
  const result = (await previewProxy.handler(ctx, parsedArgs)) as {
    reachable: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyBase64: string;
    error: string | null;
  };
  if (!result.reachable && result.error) {
    return new Response(result.error, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const resHeaders = new Headers();
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    try {
      resHeaders.set(k, v);
    } catch {
      // ignore restricted headers
    }
  }
  resHeaders.set("cache-control", "no-store");
  const status = result.status >= 100 && result.status <= 599 ? result.status : 200;
  const bodyBytes = result.bodyBase64 ? Buffer.from(result.bodyBase64, "base64") : new Uint8Array(0);
  return new Response(status === 204 || status === 304 || req.method === "HEAD" ? null : bodyBytes, {
    status,
    statusText: result.statusText || "",
    headers: resHeaders,
  });
}

// ---- static files ----
function mimeTypeFor(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function isStaticBuildAssetPathname(pathname: string): boolean {
  return /\.(?:js|mjs|css|map|png|webp|svg|jpg|jpeg|gif|ico|woff2?)$/i.test(pathname);
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^\/+/, "");
  const path = join(OUT_DIR, rel);
  if (!path.startsWith(OUT_DIR)) return new Response("forbidden", { status: 403 });
  if (!existsSync(path)) {
    // SPA fallback: anything without an extension gets the app shell.
    if (/\.[a-z0-9]+$/i.test(rel)) return new Response("not found", { status: 404 });
    return serveStatic("/");
  }
  if (rel === "index.html") {
    const html = readFileSync(path, "utf8").replace("</body>", `${buildDevClientScript(WEB_TOKEN)}</body>`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const isHashedAsset = /-[a-z0-9]{8}\.(?:png|webp|js|css)$/i.test(rel);
  const bytes = readFileSync(path);
  return new Response(bytes, {
    headers: {
      "content-type": mimeTypeFor(rel),
      "content-length": String(bytes.byteLength),
      "cache-control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}

const TLS_PEM = process.env.MUSE_CODE_SPACE_TLS_PEM?.trim() || "";
const TLS_CERT = process.env.MUSE_CODE_SPACE_TLS_CERT?.trim() || TLS_PEM;
const TLS_KEY = process.env.MUSE_CODE_SPACE_TLS_KEY?.trim() || TLS_PEM;
const WEB_TOKEN = process.env.MUSE_CODE_SPACE_WEB_TOKEN?.trim() || "";
const AUTH_COOKIE = "muse_code_space_token";

function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function isLoopbackHostHeader(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").trim().toLowerCase();
  const bare = host.replace(/:\d+$/, "");
  return bare === "127.0.0.1" || bare === "localhost" || bare === "[::1]" || bare === "::1";
}

function checkWebTokenAuth(req: Request, url: URL): { authorized: boolean; setCookie?: string } {
  if (!WEB_TOKEN || isLoopbackHostHeader(req)) return { authorized: true };
  if ((req.method === "GET" || req.method === "HEAD") && isStaticBuildAssetPathname(url.pathname)) {
    return { authorized: true };
  }
  const queryToken = url.searchParams.get("token");
  if (queryToken === WEB_TOKEN) {
    const secure = TLS_CERT ? "; Secure" : "";
    return {
      authorized: true,
      setCookie: `${AUTH_COOKIE}=${encodeURIComponent(WEB_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
    };
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${WEB_TOKEN}`) return { authorized: true };
  const cookieToken = parseCookieValue(req.headers.get("cookie"), AUTH_COOKIE);
  if (cookieToken === WEB_TOKEN) return { authorized: true };
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).searchParams.get("token") === WEB_TOKEN) return { authorized: true };
    } catch {}
  }
  return { authorized: false };
}

process.on("uncaughtException", (err) => {
  console.error("[dev] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[dev] unhandledRejection:", reason);
});

const tlsConfig =
  TLS_CERT && TLS_KEY && existsSync(TLS_CERT) && existsSync(TLS_KEY)
    ? { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }
    : undefined;

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  ...(tlsConfig ? { tls: tlsConfig } : {}),
  async fetch(req) {
    try {
      const url = new URL(req.url);
      const auth = checkWebTokenAuth(req, url);
      if (!auth.authorized) {
        console.warn(`[dev] 401 unauthorized: ${req.method} ${url.pathname}`);
        return new Response("Unauthorized — provide a valid ?token= parameter.", { status: 401 });
      }
      const attachAuthCookie = (res: Response): Response => {
        if (!auth.setCookie) return res;
        const headers = new Headers(res.headers);
        headers.append("set-cookie", auth.setCookie);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      };
      if (url.pathname.endsWith("/actions") && req.method === "POST") {
        return attachAuthCookie(await handleAction(req));
      }
      const previewTarget = parseDevPreviewTarget(req, url);
      if (previewTarget) return attachAuthCookie(await handlePreviewRoute(req, url, previewTarget));
      if (url.pathname === "/__dev/events") {
        server.timeout(req, 0);
        let ctl: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(controller) {
            ctl = controller;
            listeners.add(controller);
            controller.enqueue(": connected\n\n");
          },
          cancel() {
            listeners.delete(ctl);
          },
        });
        return attachAuthCookie(new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
        }));
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
      return attachAuthCookie(await serveStatic(url.pathname));
    } catch (err) {
      console.error("[dev] request handler error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});

const scheme = tlsConfig ? "https" : "http";
console.log(`[dev] Muse Code Space dev server: ${scheme}://${server.hostname}:${server.port}`);
console.log(`[dev] db: ${DB_PATH}`);
console.log(`[dev] pilot: ${pilotUrl} (set MUSE_CODE_SPACE_PILOT_URL to change)`);
// On the VM something outside the app calls syncModels; locally, seed the
// picker from the pilot's live catalog the same way.
async function syncModelsFromPilot() {
  const res = await fetch(`${pilotUrl}/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`/models ${res.status}`);
  const catalog = (await res.json()) as { models?: Array<{ modelId?: string; displayLabel?: string }> };
  const models = (catalog.models ?? [])
    .filter((m) => m.modelId)
    .map((m) => ({ id: m.modelId!, display_name: m.displayLabel || m.modelId! }));
  const syncModels = actions.syncModels;
  if (!isAction(syncModels) || models.length === 0) return;
  const ctx = makeCtx("dev-sync-models", syncModels.privileged) as unknown as Parameters<typeof syncModels.handler>[0];
  await syncModels.handler(ctx, syncModels.request.parse({ models }));
  console.log(`[dev] synced ${models.length} models from pilot`);
}

// With a fake pilot, seed a couple of demo projects so project surfaces
// (assign picker, sidebar groups) have something realistic to show. Only
// seeds when the projects table is completely empty.
const FAKE_PROJECTS = [
  {
    project_id: "fake-project-website",
    name: "Website Redesign",
    description: "Rebuild the marketing site.",
    color: "#0090ff",
    briefing: "# Goals\n\nRebuild the marketing site.\n\n## Constraints\n\n- Keep the current stack.\n\n## Working notes\n\nDesign mockups live in Figma.",
  },
  {
    project_id: "fake-project-mobile",
    name: "Mobile App",
    description: "Ship the iOS beta.",
    color: "#46a758",
    briefing: "# Goals\n\nShip the iOS beta.\n\n## Constraints\n\n- Offline first.\n\n## Working notes\n\nTestFlight build every Friday.",
  },
];
async function seedFakeProjects() {
  const listProjects = actions.listProjects;
  const createProject = actions.createProject;
  if (!isAction(listProjects) || !isAction(createProject)) return;
  const listCtx = makeCtx("dev-seed-projects", listProjects.privileged) as unknown as Parameters<typeof listProjects.handler>[0];
  const { projects } = (await listProjects.handler(listCtx, {})) as { projects: unknown[] };
  if (projects.length > 0) return;
  for (const project of FAKE_PROJECTS) {
    const ctx = makeCtx(`dev-seed-project-${project.project_id}`, createProject.privileged) as unknown as Parameters<typeof createProject.handler>[0];
    await createProject.handler(ctx, createProject.request.parse(project));
  }
  console.log(`[dev] seeded ${FAKE_PROJECTS.length} fake projects`);
}

console.log(`[dev] workspace home: ${process.env.MUSE_CODE_SPACE_HOME_ROOT ?? "/home/hatch"} (pilot's machine; MUSE_CODE_SPACE_HOME_ROOT overrides)`);
if (pilotHealth) {
  console.log("[dev] pilot health:", JSON.stringify(pilotHealth));
  syncModelsFromPilot().catch((e) => console.warn("[dev] model sync failed:", String(e)));
  if (pilotHealth.fake === true) {
    seedFakeProjects().catch((e) => console.warn("[dev] fake project seed failed:", String(e)));
  }
} else {
  console.warn(
    `[dev] pilot not reachable at ${pilotUrl} — the UI will load but sessions won't run.\n` +
      "      Local pilot: MUSE_CODE_SPACE_MUSE_BIN=$(which muse) MUSE_CODE_SPACE_RELAY_URL=none node pilot/pilot.mjs\n" +
      "      VM pilot:    ssh -L 18791:127.0.0.1:18791 <vm-host>\n" +
      "      (restart the dev server after the pilot is up so it picks up the pilot's home folder)",
  );
}

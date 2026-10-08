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
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
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
import spaceJson from "../space.json";

const ROOT = resolve(import.meta.dir, "..");
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
const pilotUrl = (process.env.MUSE_CODE_SPACE_PILOT_URL ?? "http://127.0.0.1:18791").replace(/\/+$/, "");
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
if (!process.env.MUSE_CODE_SPACE_HOME_ROOT) {
  process.env.MUSE_CODE_SPACE_HOME_ROOT = liveHome ?? cachedHome ?? "/home/hatch";
}
const { Actions } = await import("../server/src/actions");
const { privilegedHandlers } = await import("../server/src/privileged");

// ---- database ----
const sqlite = new Database(DB_PATH, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: join(ROOT, "drizzle") });

// ---- privileged functions ----
if (!isPrivilegedHandlers(privilegedHandlers)) {
  throw new Error("server/src/privileged.ts did not export privilegedHandlers");
}
const privilegedByName = new Map<string, PrivilegedHandler>(
  privilegedHandlers.entries.map((entry) => [entry.contract.name, entry.handler]),
);

// ---- live reload / invalidation channel ----
const listeners = new Set<ReadableStreamDefaultController<string>>();
function broadcast(event: "reload" | "invalidate") {
  for (const controller of listeners) {
    try {
      controller.enqueue(`event: ${event}\ndata: {}\n\n`);
    } catch {
      listeners.delete(controller);
    }
  }
}

// Same-origin postMessage is what the SDK's query-invalidation listener
// accepts when the page is top-level (not framed by the Hatch host).
const DEV_CLIENT_SCRIPT = `<script>
(() => {
  if (typeof EventSource === "undefined") return;
  const es = new EventSource("/__dev/events");
  es.addEventListener("reload", () => location.reload());
  es.addEventListener("invalidate", () => window.postMessage(
    { type: "hatch:space:query-invalidated", payload: { queryKeys: [] } },
    location.origin,
  ));
})();
</script>`;

// ---- client build ----
let building: Promise<boolean> | null = null;
let rebuildQueued = false;
async function buildClient(): Promise<boolean> {
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [join(ROOT, "client/index.html")],
    outdir: OUT_DIR,
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
    slug: spaceJson.slug,
    invocationId: actionCallId,
    spaceDir: ROOT,
    db: () => db,
    viewer: {
      source: "local" as const,
      authenticated: true as const,
      spaceSlug: spaceJson.slug,
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
    invalidateQueries() {
      broadcast("invalidate");
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

// ---- static files ----
async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^\/+/, "");
  const path = join(OUT_DIR, rel);
  if (!path.startsWith(OUT_DIR)) return new Response("forbidden", { status: 403 });
  const file = Bun.file(path);
  if (!(await file.exists())) {
    // SPA fallback: anything without an extension gets the app shell.
    if (/\.[a-z0-9]+$/i.test(rel)) return new Response("not found", { status: 404 });
    return serveStatic("/");
  }
  if (rel === "index.html") {
    const html = (await file.text()).replace("</body>", `${DEV_CLIENT_SCRIPT}</body>`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(file, { headers: { "cache-control": "no-store" } });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/actions") && req.method === "POST") return handleAction(req);
    if (url.pathname === "/__dev/events") {
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
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
      });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    return serveStatic(url.pathname);
  },
});

console.log(`[dev] Muse Code Space dev server: http://${server.hostname}:${server.port}`);
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

console.log(`[dev] workspace home: ${process.env.MUSE_CODE_SPACE_HOME_ROOT ?? "/home/hatch"} (pilot's machine; MUSE_CODE_SPACE_HOME_ROOT overrides)`);
if (pilotHealth) {
  console.log("[dev] pilot health:", JSON.stringify(pilotHealth));
  syncModelsFromPilot().catch((e) => console.warn("[dev] model sync failed:", String(e)));
} else {
  console.warn(
    `[dev] pilot not reachable at ${pilotUrl} — the UI will load but sessions won't run.\n` +
      "      Local pilot: MUSE_CODE_SPACE_MUSE_BIN=$(which muse) MUSE_CODE_SPACE_RELAY_URL=none node pilot/pilot.mjs\n" +
      "      VM pilot:    ssh -L 18791:127.0.0.1:18791 <vm-host>\n" +
      "      (restart the dev server after the pilot is up so it picks up the pilot's home folder)",
  );
}

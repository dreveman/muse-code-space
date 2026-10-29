// Muse Code pilot daemon.
// Long-lived Node service that owns one `muse serve` host (pinned 1.3.0 binary
// matching @muse-code/sdk 1.3.0) and exposes a localhost HTTP API for the
// Muse Code Space worker. The worker remains the only app-DB writer: it calls
// this API and streams session events back into the app.
//
// Disable the tbh-reminders plugin's reminders at the process level so the
// spawned `muse serve` backend inherits them: the skill-reminder spawns a
// reminderChild at turn end that wedges inProgress for 20min-9h with the
// backend idle (2026-10-01 root cause). Set before any spawn.
for (const v of ["SKILL_REMINDER", "SCOPE_REMINDER", "GOAL_REMINDER", "VERIFY_REMINDER"]) {
  process.env[`MUSE_EXPERIMENTAL_${v}`] = "0";
}
// Agent-to-agent peer messaging between sessions (muse 1.4: list_peer_sessions
// / session-message, addressed by agent name) is experimental and off unless
// both gates are set. On by default for the pilot's muse serve; set either
// to "0" in the pilot's environment to turn it off.
for (const v of ["LOCAL_SESSION_MESSAGING", "EXTERNAL_AGENT_INGRESS"]) {
  process.env[`MUSE_EXPERIMENTAL_${v}`] ??= "1";
}
//
// API:
//   GET  /health                      -> { ok, sessions }
//   GET  /models                      -> live MSP model/list catalog
//   GET  /repos                        -> { enabled, repos: [{ slug, name, owner, private, ... }] } (GitHub repos the broker can see)
//   GET  /repos/search?q=...           -> { enabled, repos: [...] } (GitHub search/exact lookup beyond that list)
//   POST /sessions                     { title?, name?, prompt?, modelId?, reasoningEffort?, workspaceName?, workspaceRoot?, repo? } -> { sessionId, turnId, modelId, name }

//                                      (modelId omitted -> the serve host catalog's default model)
//   POST /sessions/:id/turns          { text, ifBusy?, reasoningEffort?, modelId? } -> { turnId, admitMs, modelSwitched, modelId } (fast; ms)
//   POST /sessions/:id/turns/interrupt -> { ok, turnId? } (priority lane; the turn ends on turn/completed with terminal cancelled)
//   POST /sessions/:id/recover        recreate an unknown backend session from its transcript, same id -> { sessionId, recovered }
//   GET  /sessions/:id/poll?since=N   JSON poll for the worker -> { events: [{seq, type, ...}], latestSeq }
//   GET  /sessions/:id/events         SSE stream of { type, ... } events
//   GET  /sessions                    -> [{ sessionId, backendSessionId, title, name, modelId }]
//   POST /sessions/:id/rename {name}   rename the agent in Muse (session/rename) -> { name }
//   DELETE /sessions/:id              permanently forget a session + its transcript -> { ok, sessionId, existed }
//
// Session registry persists at state/sessions.json; sessions are resumed on boot.
// Event logs persist as state/events-<sessionId>.jsonl so a pilot crash loses
// nothing the worker hasn't polled yet; sequence numbers continue across restarts.

import { MuseClient, spawnMspConnection, readSessionDurability } from "@muse-code/sdk";
import { createServer } from "node:http";
import { get as httpsGet, request as httpsRequest } from "node:https";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { createHash, randomFillSync } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTerminalManager, handleTerminalRoute, terminalErrorStatus } from "./terminals.mjs";
import { readWorkspaceFile, readWorkspaceImage } from "./files.mjs";
import { attachSessionMcp, handleMcpRequest, requireSessionMcp } from "./mcp.mjs";
import { createGitHubToolset } from "./githubTools.mjs";
import { runGithubAppSetup } from "./githubAppSetup.mjs";
import { createSpotifyClient } from "./spotify.mjs";
import { CLONE_MAX_DURATION_MS, CLONE_STALL_TIMEOUT_MS, cloneTimeoutReason, ensureRepoCloned, listGitHubRepos, parseGitCloneProgress, parseRepoInput, searchGitHubRepos } from "./repoSetup.mjs";
import { readGitVcsStatus } from "./vcsSmartlog.mjs";
import {
  createPreviewWsManager,
  discoverWorkspaceListeningPorts,
  isAllowedPreviewPort,
  probeLocalPort,
  proxyPreviewHttpRequest,
} from "./preview.mjs";
import { createPrMonitorRegistry } from "./prMonitor.mjs";
import { validateAssistantAvatar } from "./assistant-avatar.mjs";
import {
  mergeGitIdentityIntoGitconfig,
  parseGitIdentity,
  readGitIdentityFile,
  readGitconfigIdentity,
  writeGitIdentityFile,
} from "./gitIdentity.mjs";

const HOME = process.env.HOME;
const PORT = Number(process.env.MUSE_CODE_SPACE_PILOT_PORT ?? 18791);
// The host must grant sessionMcp; a legacy pinned CLI cannot run Code Space.
const MUSE_BIN = process.env.MUSE_CODE_SPACE_MUSE_BIN ?? "muse";
// Overridable so a second pilot (e.g. dev/restart-test.ts) can run beside
// the real one without sharing its registry, transcripts or workspaces.
const STATE_DIR = process.env.MUSE_CODE_SPACE_PILOT_STATE_DIR ?? `${HOME}/workspace/muse-code-space-pilot/state`;
const REGISTRY_PATH = `${STATE_DIR}/sessions.json`;
const ALIASES_PATH = `${STATE_DIR}/aliases.json`;
const WORKSPACES = process.env.MUSE_CODE_SPACE_WORKSPACES ?? `${HOME}/workspace/code`;
const MAX_BUFFERED = 500;
// The credential relay `muse serve` needs for model calls. The pilot waits
// for it at boot and refuses to admit turns while it is unreachable, so a
// missing relay surfaces as an explicit error instead of a hung turn.
// MUSE_CODE_SPACE_RELAY_URL=none (or off/disabled) turns every relay check off, for
// hosts where `muse` reaches the model API itself (e.g. a Mac on AI Gateway).
// The VM must keep the relay: there it is the only route to the model API.
const RELAY_SETTING = (process.env.MUSE_CODE_SPACE_RELAY_URL ?? "http://127.0.0.1:18790").trim();
const RELAY_ENABLED = !/^(none|off|disabled)$/i.test(RELAY_SETTING);
const RELAY_URL = RELAY_ENABLED ? RELAY_SETTING.replace(/\/+$/, "") : null;

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(WORKSPACES, { recursive: true });

// ---- egress proxy fallback ----
// Agent shells need the VM's egress proxy for git/curl (direct egress fails
// with TLS errors), but the pilot's own environment often lacks it: systemd
// units don't inherit the login shell, and watchdog/direct starts bypass the
// unit's EnvironmentFile. Fill only missing vars — explicit env always wins,
// and hosts without a proxy (e.g. a Mac) simply find no file. Sources in
// priority order: the install-time capture next to the state dir (it carries
// the proxy credentials the relay uses), then the system environment file.
// Values are never logged: proxy URLs may embed credentials.
const PROXY_VARS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"];
const PROXY_VAR_SET = new Set(PROXY_VARS);

function parseProxyAssignments(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !PROXY_VAR_SET.has(m[1])) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value) out[m[1]] = value;
  }
  return out;
}

// Pure merge: `env` plus any proxy vars it lacks, taken from `fileTexts` in
// order (first source wins). Non-proxy vars are never adopted.
function withProxyFallback(env, fileTexts) {
  const out = { ...env };
  for (const text of fileTexts) {
    for (const [key, value] of Object.entries(parseProxyAssignments(text))) {
      if (!out[key]) out[key] = value;
    }
  }
  return out;
}

function applyProxyFallback(target = process.env) {
  const paths = [join(dirname(STATE_DIR), "proxy.env"), "/etc/environment"];
  const texts = [];
  for (const p of paths) {
    try { texts.push(readFileSync(p, "utf8")); } catch { /* no proxy file on this host */ }
  }
  const filled = withProxyFallback(target, texts);
  for (const key of PROXY_VARS) {
    if (filled[key] && !target[key]) target[key] = filled[key];
  }
  return target;
}
applyProxyFallback();

const log = (m, ...a) => console.log(new Date().toISOString(), "[pilot]", m, ...a);

const safeJson = (v) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));

const EFFORTS = {
  none: "none", minimal: "minimal", low: "low", medium: "medium",
  high: "high", xhigh: "xhigh", max: "max", ultra: "ultra",
};
const normEffort = (e) =>
  e == null ? undefined : (EFFORTS[String(e).toLowerCase()] ?? "high");

// ---- wire debug log ----
// Ring buffer of pilot<->backend JSON-RPC traffic. ALWAYS captured (2026-10-01:
// overhead is negligible — 500 short summaries — and retroactive visibility is
// essential when a turn wedges with debug off). The UI toggle only controls
// whether the log panel is shown, not whether traffic is recorded.
const WIRE_LOG_MAX = 500;
const wireLog = [];
function wire(entry) {
  wireLog.push({ at: new Date().toISOString(), ...entry });
  if (wireLog.length > WIRE_LOG_MAX) wireLog.splice(0, wireLog.length - WIRE_LOG_MAX);
}
function wireSummary(params) {
  try {
    const s = JSON.stringify(params ?? null);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch { return "?"; }
}

// ---- state ----
let client = null;
// HTTP must listen before resuming sessions so their required MCP servers
// can connect. Report unhealthy (and refuse normal traffic) until ready.
let bootReady = true; // tests import the module without calling boot()
let connection = null; // raw SDK Connection for verbs the facade doesn't surface (session/setModel)

// Model to use when a caller doesn't pick one. Catalog IDs can differ across
// hosts, so ask the serve host for its default instead of hard-coding an id.
const LAST_RESORT_MODEL_ID = "muse-spark-1.3";
const DEFAULT_MODEL_TTL_MS = 5 * 60 * 1000;
let defaultModelCache = null; // { id, at }
function pickDefaultModelId(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models.filter((m) => typeof m?.modelId === "string" && m.modelId) : [];
  return (models.find((m) => m.isDefault) ?? models[0])?.modelId ?? null;
}
async function defaultModelId(request = (method, params) => connection.request(method, params)) {
  if (defaultModelCache && Date.now() - defaultModelCache.at < DEFAULT_MODEL_TTL_MS) return defaultModelCache.id;
  try {
    const id = pickDefaultModelId(await request("model/list", {}));
    if (id) {
      defaultModelCache = { id, at: Date.now() };
      return id;
    }
  } catch (e) {
    log("model/list for the default model failed:", String(e?.message ?? e).slice(0, 200));
  }
  return LAST_RESORT_MODEL_ID;
}
let serveHandshake = null; // MspHandshake for the live serve host; used to force-kill on stall
let shuttingDown = false;
const sessions = new Map(); // backend sessionId -> { session, meta, logId }
// Serialize concurrent starts of the same app session. The registry also
// stores appSessionId so a retry after a lost response or pilot restart
// reuses the same backend session instead of repeating the first prompt.
const sessionCreates = new Map();
// logId is the stable app-visible id: the registry key under which the session
// was first created. After a backend restart the live backend session id
// differs, and endpoints resolve the original id through `aliases`, so the UI
// keeps showing one continuous session.
const aliases = new Map(); // original sessionId -> live backend sessionId
const pendingSeeds = new Map(); // logId -> recovery context, prepended to the next turn
const subscribers = new Map(); // sessionId -> Set<res>
const eventLog = new Map(); // sessionId -> Array<event>
let eventSeq = 0; // global monotonically increasing event sequence
// Registry ids whose backend session could not be resumed or recreated.
// Reported in /health so the watchdog treats them as unhealthy; cleared as
// soon as the session recovers.
const unrecovered = new Set(); // stable logId -> present while unrecovered

function loadAliases() {
  try {
    const obj = JSON.parse(readFileSync(ALIASES_PATH, "utf8"));
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v) aliases.set(k, v);
    }
  } catch { /* no aliases yet */ }
}
function saveAliases() {
  writeFileSync(ALIASES_PATH, JSON.stringify(Object.fromEntries(aliases), null, 2));
}
function resolveEntry(id) {
  // Direct hit (sessions created since boot, or never restarted), else alias,
  // else scan by stable logId (covers the instant between wireSession and
  // the alias write during recovery).
  const direct = sessions.get(id);
  if (direct) return direct;
  const backendId = aliases.get(id);
  if (backendId) {
    const aliased = sessions.get(backendId);
    if (aliased) return aliased;
  }
  for (const entry of sessions.values()) if (entry.logId === id) return entry;
  return undefined;
}

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveRegistry() {
  // Keyed by stable logId so the registry (and the app DB rows pointing at
  // it) survives backend restarts; the live backend id rides in aliases.json
  // plus meta.backendSessionId for debuggability.
  // Keep registered sessions that have not been recovered into memory yet.
  // Rewriting from sessions alone silently dropped them when another agent
  // was created during a partial backend restart.
  const obj = loadRegistry();
  for (const { meta, logId } of sessions.values()) obj[logId] = meta;
  writeFileSync(REGISTRY_PATH, JSON.stringify(obj, null, 2));
}
const eventPath = (id) => `${STATE_DIR}/events-${id}.jsonl`;
const appendCounts = new Map(); // sessionId -> appends since last compaction

function loadEventLog(sessionId) {
  const buf = [];
  try {
    for (const line of readFileSync(eventPath(sessionId), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        buf.push(ev);
        if (typeof ev.seq === "number" && ev.seq > eventSeq) eventSeq = ev.seq;
      } catch { /* skip corrupt line */ }
    }
  } catch { /* no log yet */ }
  while (buf.length > MAX_BUFFERED) buf.shift();
  return buf;
}

function broadcast(sessionId, event) {
  const buf = eventLog.get(sessionId) ?? [];
  const row = { ...event, seq: ++eventSeq, at: new Date().toISOString() };
  buf.push(row);
  while (buf.length > MAX_BUFFERED) buf.shift();
  eventLog.set(sessionId, buf);
  // Persist every event so a pilot crash loses nothing the worker hasn't polled.
  try {
    appendFileSync(eventPath(sessionId), safeJson(row) + "\n");
    const n = (appendCounts.get(sessionId) ?? 0) + 1;
    appendCounts.set(sessionId, n);
    if (n % 500 === 0) {
      // Compact: rewrite from the in-memory (capped) buffer.
      writeFileSync(eventPath(sessionId), buf.map((e) => safeJson(e)).join("\n") + "\n");
    }
  } catch (e) {
    log("event persist failed:", String(e).slice(0, 120));
  }
  const subs = subscribers.get(sessionId);
  if (!subs) return;
  const line = `data: ${safeJson(event)}\n\n`;
  for (const res of subs) {
    try { res.write(line); } catch { /* drop on flush */ }
  }
}

// ---- serve host lifecycle ----
// The handshake is wired manually (instead of MuseClient.spawn) so the pilot
// keeps a reference to the SDK Connection. The facade doesn't surface
// session/setModel, but Connection.command() is the SDK's own framed transport
// (single commandId minter shared with the client), so model switches go
// through it rather than hand-rolled JSON-RPC.
// Folders agents may write to. On a Mac, `muse` is Meta's launcher, which
// runs the CLI in a macOS sandbox whose writable roots don't include agent
// workspaces under ~/workspace (writes there fail with EPERM, "Operation not
// permitted"). The launcher takes extra roots from
// META_3PAI_ADDITIONAL_WRITABLE_DIRS (newline-separated, granted exactly);
// a plain CLI binary (the VM's) ignores the variable. Default: ~/workspace,
// where the app puts every agent workspace. MUSE_CODE_SPACE_WRITABLE_DIRS
// (newline- or colon-separated) overrides.
function writableDirs(source = process.env) {
  const configured = source.MUSE_CODE_SPACE_WRITABLE_DIRS;
  const dirs = configured ? configured.split(/[\n:]/).map((d) => d.trim()).filter(Boolean) : [`${HOME}/workspace`];
  for (const dir of dirs) mkdirSync(dir, { recursive: true }); // the launcher requires existing dirs
  return dirs;
}

// Global commit identity for sessions (gitIdentity.mjs): a JSON file in
// the runtime dir is the source of truth; it is merged into the generated
// gitconfig's [user] section so agent shells and terminals inherit it.
// Without an identity file, a [user] section set by hand in the generated
// gitconfig (e.g. `git config --global` in a session terminal) is kept.
const GIT_IDENTITY_PATH = process.env.MUSE_CODE_SPACE_GIT_IDENTITY_PATH
  ?? join(dirname(STATE_DIR), "git-identity.json");
function syncGitIdentityToGitconfig() {
  const runtime = dirname(STATE_DIR);
  const gitconfig = join(runtime, "gitconfig");
  if (!existsSync(gitconfig)) return;
  try {
    const identity = readGitIdentityFile(GIT_IDENTITY_PATH);
    const current = readFileSync(gitconfig, "utf8");
    const merged = mergeGitIdentityIntoGitconfig(current, identity);
    if (merged !== current) writeFileSync(gitconfig, merged);
  } catch { /* identity sync must never block session startup */ }
}
function effectiveGitIdentity() {
  const fromFile = readGitIdentityFile(GIT_IDENTITY_PATH);
  if (fromFile) return fromFile;
  const gitconfig = join(dirname(STATE_DIR), "gitconfig");
  try {
    if (existsSync(gitconfig)) {
      const parsed = readGitconfigIdentity(readFileSync(gitconfig, "utf8"));
      if (parsed) return parsed;
    }
    if (useDirectGhCli() && HOME && existsSync(join(HOME, ".gitconfig"))) {
      return readGitconfigIdentity(readFileSync(join(HOME, ".gitconfig"), "utf8"));
    }
    return null;
  } catch { return null; }
}

// GitHub broker wiring for spawned sessions only (install.sh generates the
// files in the runtime dir; the host's own ~/.gitconfig is never touched).
// Sessions get the broker gitconfig (insteadOf rewrite + sentinel), a scoped
// gh config (api_host -> broker), and a CA bundle that trusts the broker's
// loopback cert alongside the system roots. Absent files (broker not
// installed) mean no wiring — sessions behave exactly as before.
function githubSessionEnv() {
  const runtime = dirname(STATE_DIR);
  const gitconfig = join(runtime, "gitconfig");
  if (!existsSync(gitconfig)) return {};
  const env = { GIT_CONFIG_GLOBAL: gitconfig, GIT_TERMINAL_PROMPT: "0" };
  const ghConfig = join(runtime, "gh-config");
  if (existsSync(ghConfig)) env.GH_CONFIG_DIR = ghConfig;
  const caBundle = join(runtime, "github-broker-ca.pem");
  if (existsSync(caBundle)) env.SSL_CERT_FILE = caBundle;
  // GIT_SSL_CAINFO overrides the gitconfig's broker-scoped sslCAInfo, and
  // login profiles on this host set it to the egress bundle (which lacks
  // the broker cert) — pin it to the broker cert for sessions.
  const brokerCert = join(runtime, "github-broker-cert.pem");
  if (existsSync(brokerCert)) env.GIT_SSL_CAINFO = brokerCert;
  return env;
}

function museServeEnv(source = process.env) {
  const extra = [
    ...(source.META_3PAI_ADDITIONAL_WRITABLE_DIRS ?? "").split("\n").map((d) => d.trim()).filter(Boolean),
    ...writableDirs(source),
  ];
  return {
    ...source,
    XDG_CONFIG_HOME: `${HOME}/.config/muse-code-space-pilot`,
    MUSE_AUTH_PATH: `${HOME}/.config/muse-code-space-pilot/muse/auth.json`,
    META_3PAI_ADDITIONAL_WRITABLE_DIRS: [...new Set(extra)].join("\n"),
    ...githubSessionEnv(),
  };
}

async function spawnHost() {
  const authPath = `${HOME}/.config/muse-code-space-pilot/muse/auth.json`;
  if (!RELAY_ENABLED && HOME) {
    try {
      let validAuth = false;
      if (existsSync(authPath)) {
        const parsed = JSON.parse(readFileSync(authPath, "utf8"));
        validAuth = Boolean(parsed && typeof parsed === "object" && typeof parsed.schema_version === "number");
      }
      if (!validAuth) {
        mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
        writeFileSync(
          authPath,
          '{"schema_version": 1, "providers": {"meta": {"api_key": "relay-provided-sentinel"}}}\n',
          { mode: 0o600 },
        );
      }
    } catch { /* ignore on read-only test fs */ }
  }
  const env = museServeEnv();
  const handshake = spawnMspConnection({
    command: MUSE_BIN,
    // --disable-sandbox: the CLI's bwrap tool sandbox cannot mount /proc in
    // this container, so every bash tool call fails. Sessions already run
    // with approvalMode allowAll (standing --yolo authorization), matching
    // the old muse exec path which never sandboxed.
    args: ["serve", "--disable-sandbox"],
    env,
    onStderr: (chunk) => log("serve stderr:", chunk.toString().trim().slice(0, 200)),
  });
  let spawned;
  try {
    spawned = await handshake.initialize({
      clientInfo: { name: "muse_pilot", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestedCapabilities: ["sessionMcp"] },
    });
  } catch (e) {
    await handshake.close().catch(() => undefined);
    throw e;
  }
  try {
    requireSessionMcp(spawned.initializeResult);
  } catch (error) {
    await handshake.close().catch(() => undefined);
    throw error;
  }
  serveHandshake = handshake; // retained so stall recovery can force-kill the host
  connection = spawned.connection;
  // The CLI runs a "goal-reminder" plugin agent at the end of turns, which
  // holds turn.completed open for 30-60s after the visible answer is done
  // (the UI spinner keeps spinning). These headless dashboard sessions have
  // no CLI-local goals for it to check, so suppress it on turn/start via the
  // CLI's own payload fields. The SDK facade (1.3.0) doesn't forward them, so
  // interpose on the SDK's framed transport instead of hand-rolling JSON-RPC.
  const wrappedConnection = new Proxy(connection, {
    get(target, prop) {
      // See every host notification too (MuseClient claims the connection's
      // single handler): turns the HOST starts — workflow results, finished
      // background tasks, cron — and item updates that land after their turn
      // ended would otherwise never reach the app.
      if (prop === "onNotification") {
        return (handler) => target.onNotification((notification) => {
          try {
            onHostNotification(notification);
          } catch (e) {
            log("notification tap failed:", String(e?.message ?? e).slice(0, 200));
          }
          handler(notification);
        });
      }
      if (prop === "command") {
        return async (method, params, ...rest) => {
          // The SDK facade doesn't forward per-session MCP config. Boot
          // already verified sessionMcp was granted; messaging is required
          // for every session, not an optional best-effort feature.
          const mcp = attachSessionMcp(method, params, `http://127.0.0.1:${PORT}`);
          params = mcp.params;
          const mcpToken = mcp.token;
          if (method === "turn/start" && params && typeof params === "object") {
            // turnId == commandId for our own submits: remember them so the
            // tap never mistakes one of our turns for a host-started one.
            if (typeof params.commandId === "string") followedTurns.add(params.commandId);
            params = {
              ...params,
              suppress_generic_goal_reminders: true,
              suppress_reminder_roster: true,
            };
          }
          wire({ dir: "→", method, params: wireSummary(params) });
          const t0 = Date.now();
          try {
            const result = await target.command(method, params, ...rest);
            wire({ dir: "←", method, ms: Date.now() - t0, ok: true });
            if (mcpToken) {
              const sessionId = method === "session/resume" ? params.sessionId : (result?.session?.sessionId ?? result?.sessionId);
              if (typeof sessionId === "string") mcpTokens.set(mcpToken, sessionId);
            }
            return result;
          } catch (e) {
            wire({ dir: "←", method, ms: Date.now() - t0, ok: false, error: String(e?.message ?? e).slice(0, 200) });
            throw e;
          }
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const c = new MuseClient(wrappedConnection, {
    durability: readSessionDurability(spawned.initializeResult),
    host: spawned,
  });
  return c;
}

// After a pilot restart, a turn that was in-flight is invisible to the new
// process: openTurns is empty, so no watchdog is armed and the stop button
// has nothing to target. Check the events file: if the last event is a
// stream item (not turn_completed/turn_error/etc.), arm a one-shot watchdog.
// If no new items arrive within the idle budget, treat it as wedged and
// run stall recovery. New turns started after the restart are tracked
// normally via pumpTurn/openTurns and are unaffected.
function watchResumedTurn(sessionId) {
  let lastAt = 0;
  let lastSeq = 0;
  try {
    const path = eventPath(sessionId);
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (typeof ev.seq === "number" && ev.seq > lastSeq) {
        lastSeq = ev.seq;
        if (ev.type === "item") {
          const t = Date.parse(ev.at ?? ev.ts ?? "");
          if (Number.isFinite(t)) lastAt = t;
        } else if (ev.type === "turn_completed" || ev.type === "turn_error" ||
                   ev.type === "turn_cancelled" || ev.type === "host_restarted" ||
                   ev.type === "session_recovered") {
          // Turn already settled — nothing to watch.
          return;
        }
      }
    }
  } catch {
    return; // no events file — nothing to watch
  }
  if (!lastAt) return; // no items ever — nothing in flight
  const idleBudget = turnIdleMs();
  const elapsed = Date.now() - lastAt;
  if (elapsed >= idleBudget) {
    log("resumed turn already idle past budget, recovering:", sessionId);
    broadcast(sessionId, { type: "turn_error", error: "Turn stalled across pilot restart with no output. The turn was released — send a new message to retry." });
    broadcast(sessionId, { type: "backend_resetting", reason: "resumed turn stall" });
    resetBackendOnStall(sessionId, null).catch((e) =>
      log("resumed-turn recovery failed:", String(e).slice(0, 160))
    );
    return;
  }
  // Re-check when the budget expires; if items arrived meanwhile, the
  // events file will show a newer item and we'll stand down.
  setTimeout(() => {
    let cur = 0;
    try {
      const lines = readFileSync(eventPath(sessionId), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "item") {
          const t = Date.parse(ev.at ?? ev.ts ?? "");
          if (Number.isFinite(t) && t > cur) cur = t;
        } else if (ev.type === "turn_completed" || ev.type === "turn_error" ||
                   ev.type === "turn_cancelled" || ev.type === "host_restarted") {
          return; // settled meanwhile
        }
      }
    } catch { return; }
    if (cur > lastAt) return; // progress happened — turn is alive
    // Also stand down if pumpTurn picked it up (a new turn started).
    if (openTurns.size > 0) return;
    log("resumed turn went idle with no progress, recovering:", sessionId);
    broadcast(sessionId, { type: "turn_error", error: "Turn stalled with no output. The turn was released — send a new message to retry." });
    broadcast(sessionId, { type: "backend_resetting", reason: "resumed turn stall" });
    resetBackendOnStall(sessionId, null).catch((e) =>
      log("resumed-turn recovery failed:", String(e).slice(0, 160))
    );
  }, idleBudget - elapsed).unref?.();
}

async function resumeAll() {
  loadAliases();
  const registry = loadRegistry();
  unrecovered.clear();
  for (const [id, meta] of Object.entries(registry)) {
    // After a backend restart (VM replacement) the old backend session ids
    // are unknown to the fresh `muse serve`. Try the aliased live id first,
    // then the original id (covers registries written before aliasing).
    const candidates = [];
    if (aliases.get(id)) candidates.push(aliases.get(id));
    candidates.push(id);
    let resumed = false;
    for (const sid of candidates) {
      try {
        const session = await client.resumeSession({ sessionId: sid });
        wireSession(session, meta, id);
        if (session.sessionId !== id) {
          aliases.set(id, session.sessionId);
          saveAliases();
        }
        log("resumed session", id, sid === id ? "" : `(backend ${sid})`);
        resumed = true;
        // If the events file shows an in-flight turn (last event is an item,
        // not a turn_completed/turn_error), the pilot restart lost track of
        // it. Arm a watchdog so it can't sit wedged forever with no one
        // watching (2026-10-02: 6-hour silent turn survived a restart).
        watchResumedTurn(id);
        break;
      } catch (e) {
        log("resume failed for", sid, "-", String(e).slice(0, 160));
      }
    }
    // The transcript file is the session: recreate the backend session from
    // it automatically instead of requiring manual recovery. The original id
    // stays valid via the alias, so the UI shows one continuous session.
    if (!resumed) {
      unrecovered.add(id);
      const ok = await recoverSession(id, meta);
      if (ok) unrecovered.delete(id);
    }
  }
}

// Compact recovery context built from the surviving transcript file. It is
// prepended to the next user turn (not auto-run), so a restarted session
// picks up where it left off without firing surprise turns on boot.
function buildRecoverySeed(id) {
  let originalPrompt = "";
  const assistantTexts = [];
  try {
    for (const line of readFileSync(eventPath(id), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const item = ev.item;
      if (!item || item.status === "inProgress") continue;
      if (item.kind === "userMessage" && !originalPrompt) {
        originalPrompt = (item.text ?? item.fallbackText ?? "").trim().slice(0, 2000);
      } else if (item.kind === "agentMessage" && (item.text ?? "").trim()) {
        assistantTexts.push(item.text.trim());
        while (assistantTexts.length > 3) assistantTexts.shift();
      }
    }
  } catch {
    return null; // no transcript file — recover the session, just without context
  }
  if (!originalPrompt && assistantTexts.length === 0) return null;
  const parts = [
    "[Recovered context — the backend restarted and this is a replacement backend session. Continue seamlessly; the workspace is intact.]",
  ];
  if (originalPrompt) parts.push(`Original task:\n${originalPrompt}`);
  if (assistantTexts.length) {
    parts.push(`Recent progress (most recent last):\n${assistantTexts.map((t) => t.slice(0, 1200)).join("\n---\n")}`);
  }
  return parts.join("\n\n").slice(0, 4000);
}

async function recoverSession(id, meta) {
  try {
    const wsDir = meta?.workspaceRoot ?? defaultWorkspacePath(meta?.appSessionId ?? id);
    mkdirSync(wsDir, { recursive: true });
    const session = await client.startSession({
      workspaceRoot: wsDir,
      modelId: meta?.modelId ?? (await defaultModelId()),
      approvalMode: "allowAll",
    });
    const recoveredMeta = { ...(meta ?? {}), backendSessionId: session.sessionId };
    wireSession(session, recoveredMeta, id);
    aliases.set(id, session.sessionId);
    saveAliases();
    // The replacement backend session keeps the agent's name, so agents
    // that message it by name still reach it.
    if (recoveredMeta.name) void renameBackendSession(session.sessionId, recoveredMeta.name);
    const seed = buildRecoverySeed(id);
    const soulSeed = soulBlock(recoveredMeta.soul);
    const briefingSeed = cleanSoul(recoveredMeta.projectBriefing);
    const soulAndBriefing = [soulSeed, briefingSeed].filter(Boolean).join("\n\n") || null;
    const combinedSeed = soulAndBriefing && seed ? `${soulAndBriefing}\n\n${seed}` : soulAndBriefing ?? seed;
    if (combinedSeed) pendingSeeds.set(id, combinedSeed);
    // Visible in the transcript as a small notice; the app-visible session
    // id never changes, so this reads as one continuous conversation.
    broadcast(id, {
      type: "session_recovered",
      text: "Backend restarted; this session was resumed from its transcript. Continuing where it left off.",
    });
    log("recovered session", id, "-> backend", session.sessionId);
    return true;
  } catch (e) {
    const reason = String(e).slice(0, 300);
    log("recovery failed for", id, "-", reason);
    // A failed recovery must land in the transcript, never vanish into a
    // log line: the worker polls this id's file-backed log even when the
    // backend session is unknown, so the error reaches the UI.
    try {
      broadcast(id, { type: "recovery_failed", error: reason });
    } catch { /* file errors must not mask the failure */ }
    return false;
  }
}

function wireSession(session, meta, logId = session.sessionId) {
  sessions.set(session.sessionId, { session, meta, logId });
  if (!eventLog.has(logId)) eventLog.set(logId, loadEventLog(logId));
  session.onApproval(async (req) => {
    // allowAll mode should never ask; defensively approve if it ever does.
    wire({ dir: "←", method: "approval/request", params: wireSummary({ tool: req.toolName, choices: (req.availableChoices ?? []).length }) });
    log("approval requested (auto-approving):", req.toolName);
    const choices = req.availableChoices ?? [];
    const pick =
      choices.find((c) => /approv|allow|yes/i.test(c.choiceId ?? c.id ?? "")) ??
      choices[0];
    const result = { choiceId: pick?.choiceId ?? pick?.id };
    wire({ dir: "→", method: "approval/response", params: wireSummary(result) });
    return result;
  });
  saveRegistry();
}

// Open turns under pump: turnId -> { logId, turnId, startedAt, lastItemAt,
// items, inProgress }. Feeds /health readiness (fix 3) and the idle watchdog
// below (fix 1). Cleared on settle OR on idle release, whichever first.
const openTurns = new Map();

// Idle budget: a turn that produces no new stream items for this long is
// wedged (observed 2026-10-01: a stuck skill-reminder child held turns open
// 20min and 9h with the backend idle). Applies ONLY when no tool is actively
// running — a tool call that takes a long time without streaming output is
// legitimate work, not a wedge. Overrides for tests/slow runners.
function turnIdleMs() {
  const raw = Number(process.env.MUSE_CODE_SPACE_TURN_IDLE_TIMEOUT_MS ?? 5 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}
// Idle budget while a tool call is actively in progress: much longer, because
// long-running tools (builds, tests, large edits) are normal. Only kills
// truly wedged tools.
function turnToolIdleMs() {
  const raw = Number(process.env.MUSE_CODE_SPACE_TURN_TOOL_TIMEOUT_MS ?? 60 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
}
// Admission grace: a queued turn may wait for its first item this long.
function turnStartMs() {
  const raw = Number(process.env.MUSE_CODE_SPACE_TURN_START_TIMEOUT_MS ?? 10 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

// One-line descriptor for an in-progress stream item, used to name the
// stuck child in the timeout error (e.g. "toolCall skill-reminder …").
function describeStuckItem(item) {
  if (!item || typeof item !== "object") return "unknown item";
  const parts = [item.kind ?? "item"];
  if (typeof item.tool === "string" && item.tool) parts.push(item.tool);
  const text = item.text ?? item.fallbackText ?? "";
  if (typeof text === "string" && text.trim()) {
    parts.push(text.trim().replace(/\s+/g, " ").slice(0, 80));
  }
  return parts.join(" ").slice(0, 120);
}

const TURN_RELEASED = Symbol("turn-released");

// Turns whose items reach the app through pumpTurn: ours (from turn/start,
// recorded before the host can announce them) and host-started ones we
// picked up. Anything else is "outside a followed turn".
const followedTurns = new Set();
// Item kinds that keep changing after their turn has ended (a workflow runs
// its child agents in the background).
const LONG_LIVED_ITEM_KINDS = new Set(["workflow", "subagent"]);

function entryForBackendSession(backendSessionId) {
  return backendSessionId ? sessions.get(backendSessionId) : undefined;
}

// Give a backend session its agent name (the app's name for it). Muse
// normalizes and validates; returns the canonical name it settled, or null
// (rejected / not connected). That name is how other agents address it.
async function renameBackendSession(backendSessionId, name) {
  if (!connection || !name) return null;
  try {
    const result = await connection.command("session/rename", { commandId: uuidv7(), sessionId: backendSessionId, name });
    return typeof result?.name === "string" && result.name ? result.name : name;
  } catch (e) {
    log("session/rename failed:", backendSessionId, String(e?.message ?? e).slice(0, 200));
    return null;
  }
}

// The host's own notifications (see the tap in spawnHost).
function onHostNotification(notification) {
  const method = notification?.method;
  const params = notification?.params ?? {};
  if (method === "turn/started") {
    const entry = entryForBackendSession(params.sessionId);
    const turnId = params.turnId;
    if (!entry || typeof turnId !== "string" || followedTurns.has(turnId)) return;
    // A turn we didn't start: muse serve continued the session itself (a
    // workflow or background task finished and its results were delivered,
    // a cron fired, ...). Follow it exactly like one of ours. Deferred so the
    // SDK folds turn/started (the handler below us) before we take the handle.
    followedTurns.add(turnId);
    queueMicrotask(() => {
      log("following host-started turn", turnId, "in", entry.logId);
      broadcast(entry.logId, { type: "host_turn_started", turnId });
      void pumpTurn(entry.logId, entry.session.turn(turnId), { hostStarted: true });
    });
    return;
  }
  if (method === "session/nameChanged") {
    // Muse's own name for the session changed (our rename, Muse's automatic
    // name, a /name command): keep the registry and the app in step.
    const entry = entryForBackendSession(params.sessionId);
    if (!entry || typeof params.name !== "string" || !params.name || entry.meta.name === params.name) return;
    entry.meta.name = params.name;
    saveRegistry();
    broadcast(entry.logId, { type: "name_changed", name: params.name });
    return;
  }
  if (method === "item/started" || method === "item/updated" || method === "item/completed") {
    const item = params.item;
    const entry = entryForBackendSession(params.sessionId);
    if (!entry || !item || !LONG_LIVED_ITEM_KINDS.has(item.kind)) return;
    // Inside a followed turn pumpTurn already relays it.
    if (item.turnId && followedTurns.has(item.turnId) && openTurns.has(item.turnId)) return;
    broadcast(entry.logId, { type: "item", item });
  }
}

// Force-reset the serve host after a stall. The pilot's turn release only
// cleans up pilot-side state; a wedged backend keeps its agent loop blocked
// inside the hung tool call, so the next turn/start goes into a black hole.
// Escalation: try turn/interrupt first (graceful), then close the handshake
// (EOF → SIGTERM → SIGKILL via the SDK). The death-watch loop in boot()
// sees the exit and respawns + resumes automatically.
async function resetBackendOnStall(sessionId, turnId) {
  log("stall recovery: resetting backend for", sessionId, turnId);
  // 1. Try graceful turn interrupt (5s budget).
  try {
    if (connection && turnId) {
      await Promise.race([
        connection.command("turn/interrupt", { sessionId, turnId }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("interrupt timeout")), 5000)),
      ]);
      log("stall recovery: turn/interrupt admitted");
      // Give the backend a moment to settle; if the turn actually stops,
      // pumpTurn will see turn/completed and we avoid the kill.
      await new Promise((r) => setTimeout(r, 3000));
      if (!openTurns.has(turnId)) {
        log("stall recovery: backend recovered via interrupt, no kill needed");
        return;
      }
    }
  } catch (e) {
    log("stall recovery: interrupt failed:", String(e).slice(0, 120));
  }
  // 2. Force-kill the host. The death-watch loop respawns and resumeAll()
  // re-establishes sessions from the transcript.
  try {
    if (serveHandshake) {
      log("stall recovery: force-closing serve host");
      await serveHandshake.close();
      log("stall recovery: serve host closed");
    } else {
      log("stall recovery: no handshake reference, cannot kill host");
    }
  } catch (e) {
    log("stall recovery: host close failed:", String(e).slice(0, 160));
  }
}

// A turn the user (or runtime) cancelled instead of letting it finish. The
// SDK settles it as turn/completed with terminal "cancelled" (nested under
// params on the facade outcome); older shapes may carry status "cancelled".
function isCancelledOutcome(outcome) {
  if (typeof outcome === "string") return /^cancelled$|^canceled$/i.test(outcome.trim());
  if (!outcome || typeof outcome !== "object") return false;
  for (const key of ["status", "terminal"]) {
    const value = outcome[key];
    if (typeof value === "string" && /^cancelled$|^canceled$/i.test(value.trim())) return true;
  }
  const params = outcome.params;
  if (params && typeof params === "object") return isCancelledOutcome(params);
  return false;
}

async function pumpTurn(sessionId, turn, { hostStarted = false } = {}) {
  const state = {
    hostStarted,
    logId: sessionId,
    turnId: turn?.turnId ?? null,
    startedAt: Date.now(),
    lastItemAt: Date.now(),
    items: 0,
    inProgress: [],
  };
  if (state.turnId) openTurns.set(state.turnId, state);
  const idleMs = turnIdleMs();
  const startMs = turnStartMs();
  let timer = null;
  let release = null;
  const released = new Promise((resolve) => { release = resolve; });
  const failIdle = () => {
    // Timer context: never let a broadcast failure crash the daemon or
    // leave the turn awaited forever — release unconditionally.
    try {
      // Brief startup grace: an admitted turn gets 30s to produce its first
      // item before the idle budget applies. (The old 10-min "admission
      // grace" let admitted-but-silent turns sit wedged; pumpTurn only runs
      // after turn/start succeeds, so long grace here is wrong.)
      if (state.items === 0 && Date.now() - state.startedAt < 30000) {
        timer = setTimeout(failIdle, 30000 - (Date.now() - state.startedAt));
        return;
      }
      // A tool actively in progress gets the long tool budget, not the
      // short thinking budget: long-running tools without streaming output
      // are legitimate work (2026-10-01: a 5-min kill murdered a healthy
      // long tool call). Only re-arm with the tool timeout.
      const toolMs = turnToolIdleMs();
      if (state.inProgress.length > 0 && Date.now() - state.lastItemAt < toolMs) {
        timer = setTimeout(failIdle, toolMs - (Date.now() - state.lastItemAt));
        return;
      }
      if (state.turnId) openTurns.delete(state.turnId);
      const hint = state.inProgress.length > 0 ? state.inProgress.join(" | ") : "no in-progress detail";
      const mins = Math.max(1, Math.round((state.inProgress.length > 0 ? toolMs : idleMs) / 60000));
      const error =
        `Turn stalled: no output for ${mins} minute${mins === 1 ? "" : "s"} ` +
        `(stuck: ${hint}). The turn was released — send a new message to retry.`;
      broadcast(sessionId, { type: "turn_error", error: error.slice(0, 2000) });
      log("turn idle timeout:", sessionId, state.turnId, "-", hint.slice(0, 160));
      // The backend is wedged, not just the turn: reset it so the next
      // prompt doesn't spin forever. Respawn + resume happen automatically.
      broadcast(sessionId, { type: "backend_resetting", reason: "turn stall" });
      resetBackendOnStall(sessionId, state.turnId).catch((e) =>
        log("stall recovery failed:", String(e).slice(0, 160))
      );
    } catch (e) {
      log("turn idle timeout failed:", sessionId, "-", String(e).slice(0, 160));
    }
    release(TURN_RELEASED);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(failIdle, idleMs);
  };
  arm();
  try {
    const pump = (async () => {
      for await (const item of turn.items()) {
        state.lastItemAt = Date.now();
        state.items += 1;
        if (item?.status === "inProgress") {
          state.inProgress.push(describeStuckItem(item));
          while (state.inProgress.length > 3) state.inProgress.shift();
        }
        broadcast(sessionId, { type: "item", item });
        arm();
      }
      return await turn.completed;
    })();
    const outcome = await Promise.race([pump, released]);
    // Released: the wedge is already visible in the transcript; a late
    // settle stays quiet so it can't revive a failed turn.
    if (outcome === TURN_RELEASED) return;
    broadcast(sessionId, {
      type: "turn_completed",
      outcome,
      // A user-pressed stop lands here as terminal "cancelled": flag it so
      // the worker files the turn as stopped, not failed or succeeded.
      ...(isCancelledOutcome(outcome) ? { cancelled: true } : {}),
    });
  } catch (e) {
    broadcast(sessionId, { type: "turn_error", error: String(e).slice(0, 500) });
  } finally {
    clearTimeout(timer);
    if (state.turnId) {
      openTurns.delete(state.turnId);
      // Late revisions of this turn's long-lived items (a workflow still
      // running its children) now go through the notification tap.
      followedTurns.delete(state.turnId);
    }
  }
}

// A dedicated local route checks listener readiness without forwarding a
// health probe to the model API or filling the diagnostic ring.
async function relayUp() {
  if (!RELAY_ENABLED) return true;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2000);
  try {
    const response = await fetch(`${RELAY_URL}/__code_space/health`, { signal: ctl.signal });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// With the relay checks off, a muse config that still routes model calls
// through the relay would make every turn fail on transport. Say so at boot.
function relayDisabledConfigWarning(settingsPath = `${HOME}/.config/muse-code-space-pilot/muse/settings.json`) {
  if (RELAY_ENABLED || !existsSync(settingsPath)) return null;
  let baseUrl;
  try {
    baseUrl = JSON.parse(readFileSync(settingsPath, "utf8"))?.endpoint_transport?.base_url;
  } catch {
    return null;
  }
  if (typeof baseUrl !== "string" || !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl)) return null;
  return `${settingsPath} still sends model calls to ${baseUrl} (the relay); remove endpoint_transport or turns will fail`;
}

// Belt and suspenders with the project relay unit's systemd ordering:
// the watchdog's direct-start path bypasses systemd, so wait here too.
async function waitForRelay() {
  if (!RELAY_ENABLED) {
    log("credential relay checks disabled (MUSE_CODE_SPACE_RELAY_URL=none)");
    const warning = relayDisabledConfigWarning();
    if (warning) log("WARNING:", warning);
    return true;
  }
  for (let i = 0; i < 30; i++) {
    if (await relayUp()) {
      if (i > 0) log("relay became reachable after", i, "s");
      return true;
    }
    if (i % 10 === 0) log("waiting for credential relay on", RELAY_URL);
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("WARNING: relay still unreachable after 30s — turns will fail fast until it returns");
  return false;
}

function turnReadiness() {
  // Turn progress, not just process liveness: a wedged turn (no stream
  // items for the idle budget) flips healthy to false so the watchdog and
  // the app can tell "alive" from "wedged".
  const now = Date.now();
  const idleMs = turnIdleMs();
  let maxIdleMs = 0;
  const stuck = [];
  for (const [turnId, t] of openTurns) {
    const idle = now - t.lastItemAt;
    if (idle > maxIdleMs) maxIdleMs = idle;
    // Match pumpTurn: tools in progress get the long budget, thinking gets the short one.
    const budget = t.inProgress.length > 0 ? turnToolIdleMs() : idleMs;
    if (idle > budget) stuck.push(turnId);
  }
  return {
    open: openTurns.size,
    maxIdleMs: openTurns.size > 0 ? maxIdleMs : null,
    stuck,
  };
}

// GitHub broker liveness (loopback TLS with the install-generated cert;
// verification is skipped for this local health probe only — no credential
// ever travels over it, mirroring the relay's local-liveness check).
const BROKER_PORT = Number(process.env.MUSE_CODE_SPACE_GITHUB_BROKER_PORT ?? 443);
let brokerUpSyncCache = null;
async function brokerUp() {
  return new Promise((resolve) => {
    const req = httpsGet({ host: "127.0.0.1", port: BROKER_PORT, path: "/__code_space/health",
                      rejectUnauthorized: false, timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); }
        catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
const brokerProber = setInterval(async () => {
  try { brokerUpSyncCache = await brokerUp(); } catch { brokerUpSyncCache = false; }
}, 15000);
if (typeof brokerProber.unref === "function") brokerProber.unref();

// Session GitHub tools (githubTools.mjs) and repo picker (repoSetup.mjs)
// run through the loopback broker on the VM (`github-broker.json` present).
// For local development (`MUSE_CODE_SPACE_GITHUB_BROKER_URL=none`, or when
// `MUSE_CODE_SPACE_RELAY_URL=none` and no broker config exists), the pilot
// falls back to local `gh` and `git` commands unless explicitly disabled
// with `MUSE_CODE_SPACE_GITHUB_BROKER_URL=disconnected`.
const GITHUB_BROKER_CONFIG = process.env.MUSE_CODE_SPACE_GITHUB_BROKER_CONFIG ?? `${HOME}/.config/muse-code-space-pilot/github-broker.json`;
// Spotify companion music (spotify.mjs): host-local config holding only the
// client id + refresh token; install never creates or overwrites it.
const SPOTIFY_CONFIG = process.env.MUSE_CODE_SPACE_SPOTIFY_CONFIG ?? `${HOME}/.config/muse-code-space-pilot/spotify.json`;
const spotify = createSpotifyClient({ configFile: SPOTIFY_CONFIG, brokerCaFile: join(dirname(STATE_DIR), "github-broker-ca.pem") });
const GITHUB_BROKER_MODE = (process.env.MUSE_CODE_SPACE_GITHUB_BROKER_URL ?? "").trim().toLowerCase();
const GITHUB_DISCONNECTED = ["0", "false", "off", "disconnected", "disabled"].includes(GITHUB_BROKER_MODE);
const GITHUB_SENTINEL = "broker-provided-sentinel";

let ghCliReadyCache = null;
let ghCliCheckedAt = 0;
function checkGhCliReady() {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "status"], { timeout: 5000 }, (error) => {
      ghCliReadyCache = !error;
      ghCliCheckedAt = Date.now();
      resolve(ghCliReadyCache);
    });
  });
}
if (!GITHUB_DISCONNECTED && (GITHUB_BROKER_MODE === "none" || GITHUB_BROKER_MODE === "gh" || !RELAY_ENABLED)) {
  void checkGhCliReady();
}

function useDirectGhCli() {
  if (GITHUB_DISCONNECTED) return false;
  if (GITHUB_BROKER_MODE === "none" || GITHUB_BROKER_MODE === "gh") return true;
  return !RELAY_ENABLED && !existsSync(GITHUB_BROKER_CONFIG);
}

function isGitHubEnabled() {
  if (GITHUB_DISCONNECTED) return false;
  if (!useDirectGhCli() && existsSync(GITHUB_BROKER_CONFIG)) return true;
  if (useDirectGhCli()) {
    if (Date.now() - ghCliCheckedAt > 30_000) void checkGhCliReady();
    return ghCliReadyCache !== false;
  }
  return false;
}

function ghCliRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const args = ["api", "--include", "--method", method, "-H", "Accept: application/vnd.github+json", path];
    if (body !== undefined) args.push("--input", "-");
    const child = execFile("gh", args, { timeout: 15_000, maxBuffer: 2_000_000 }, (_error, stdout, stderr) => {
      const output = String(stdout ?? "");
      const splitMatch = output.match(/\r?\n\r?\n/);
      if (!splitMatch || splitMatch.index === undefined) {
        if (_error) {
          ghCliReadyCache = false;
          reject(new Error(String(stderr || _error.message || "gh api failed").trim().slice(0, 240)));
          return;
        }
        resolve({ status: 0, json: null });
        return;
      }
      ghCliReadyCache = true;
      ghCliCheckedAt = Date.now();
      const head = output.slice(0, splitMatch.index);
      const rawBody = output.slice(splitMatch.index + splitMatch[0].length);
      const statusMatch = head.match(/^HTTP\/[^\s]+\s+(\d{3})/m);
      const status = statusMatch ? Number(statusMatch[1]) : (_error ? 500 : 200);
      let json = null;
      try { json = JSON.parse(rawBody); } catch { /* non-JSON stays null */ }
      resolve({ status, json });
    });
    if (body !== undefined && child.stdin) {
      child.stdin.end(JSON.stringify(body));
    }
  });
}

function githubBrokerRequestOnce(method, path, body) {
  return new Promise((resolve, reject) => {
    const certPath = join(dirname(STATE_DIR), "github-broker-cert.pem");
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpsRequest({
      host: "127.0.0.1", port: BROKER_PORT, path, method, timeout: 15000,
      ...(existsSync(certPath) ? { ca: readFileSync(certPath) } : { rejectUnauthorized: false }),
      headers: {
        authorization: `Bearer ${GITHUB_SENTINEL}`,
        accept: "application/vnd.github+json",
        "user-agent": "code-space-pilot",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => { size += chunk.length; if (size <= 1_000_000) chunks.push(chunk); });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* non-JSON stays null */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("broker request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function githubBrokerRequest(method, path, body) {
  if (useDirectGhCli()) {
    return ghCliRequest(method, path, body);
  }
  // The broker occasionally returns a transient 502 on connect; one retry
  // for idempotent reads absorbs it (writes are never replayed).
  const attempts = method === "GET" ? 2 : 1;
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300));
    result = await githubBrokerRequestOnce(method, path, body);
    if (result.status !== 502) break;
  }
  return result;
}

function appendMuseInboxRequest(text) {
  readMuseInbox(); // load the seq watermark before appending
  const record = {
    seq: ++museInboxSeq,
    messageId: uuidv7(),
    at: new Date().toISOString(),
    from: { kind: "code-space-ui", name: "Code Space" },
    text,
  };
  appendFileSync(MUSE_INBOX_PATH, `${JSON.stringify(record)}\n`);
  return record;
}

// The dialog's GitHub App step validates + writes credentials in-process
// (see githubAppSetup.mjs for why the old subprocess hand-off hung); the
// broker is not restarted here — activation stays Muse's step below.

// After App credentials are written, the step is only truly done once the
// restarted broker can use them. Probe through the broker at most every
// 10s while activation is pending; a 200 clears the pending flag.
async function probeAppActivation() {
  if (!appActivationPending) return true;
  const now = Date.now();
  if (now - appActivationProbe.at < 10_000) return appActivationProbe.ok;
  appActivationProbe = { at: now, ok: false };
  try {
    const result = await githubBrokerRequestOnce("GET", "/installation/repositories?per_page=1");
    appActivationProbe.ok = result.status === 200;
  } catch { appActivationProbe.ok = false; }
  if (appActivationProbe.ok) { appActivationPending = false; appActivationRequested = false; }
  return appActivationProbe.ok;
}

function gitRead(workspaceRoot, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", workspaceRoot, ...args], { timeout: 5000, maxBuffer: 2_000_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

// Set repo-local git config (per-checkout author override). Resolves
// true only when the values were actually written.
function gitConfigLocal(workspaceRoot, identity) {
  return new Promise((resolve) => {
    execFile("git", ["-C", workspaceRoot, "config", "user.name", identity.name], { timeout: 5000 }, (nameError) => {
      if (nameError) return resolve(false);
      execFile("git", ["-C", workspaceRoot, "config", "user.email", identity.email], { timeout: 5000 }, (emailError) => resolve(!emailError));
    });
  });
}

function gitConfigUnsetLocal(workspaceRoot) {
  return new Promise((resolve) => {
    execFile("git", ["-C", workspaceRoot, "config", "--unset", "user.name"], { timeout: 5000 }, () => {
      execFile("git", ["-C", workspaceRoot, "config", "--unset", "user.email"], { timeout: 5000 }, () => resolve(true));
    });
  });
}

function gitReadRaw(workspaceRoot, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", workspaceRoot, ...args], { timeout: 5000, maxBuffer: 2_000_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout ?? ""));
    });
  });
}

// Active repository clones keyed by workspaceName (appSessionId), exposed via
// GET /repos/clone-progress so the UI can show a live progress bar during
// large clones. `inFlightSessionStarts` deduplicates concurrent POST /sessions
// calls for the same workspaceName while a clone is still running.
const activeClones = new Map();
const inFlightSessionStarts = new Map();

// Clone a picked repo into a new companion's workspace. Through the
// broker gitconfig when GitHub is provisioned (private repos work and no
// real credential reaches this process); plain https otherwise, which
// covers public repos. Failures are truncated: git stderr can be verbose.
function gitCloneRepo(cloneUrl, dir, onProgress) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...(!useDirectGhCli() && existsSync(GITHUB_BROKER_CONFIG) ? githubSessionEnv() : {}),
      GIT_TERMINAL_PROMPT: "0",
    };
    const child = spawn("git", ["clone", "--progress", "--", cloneUrl, dir], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    let progressState = { phase: "Cloning", percent: null, transferred: null };
    // No fixed short cap: a large clone that keeps producing progress runs
    // until it finishes. It is killed only after CLONE_STALL_TIMEOUT_MS
    // without any output, or at the CLONE_MAX_DURATION_MS ceiling.
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    const watchdog = setInterval(() => {
      const reason = cloneTimeoutReason({ startedAt, lastProgressAt, now: Date.now() });
      if (!reason) return;
      clearInterval(watchdog);
      child.kill("SIGTERM");
      reject(new Error(reason === "stalled"
        ? `git clone stalled: no progress for ${Math.round(CLONE_STALL_TIMEOUT_MS / 60_000)} minutes`
        : `git clone timed out after ${Math.round(CLONE_MAX_DURATION_MS / 60_000)} minutes`));
    }, 15_000);
    child.stderr.on("data", (chunk) => {
      lastProgressAt = Date.now();
      const text = chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-4000);
      progressState = parseGitCloneProgress(text, progressState);
      if (typeof onProgress === "function") onProgress(progressState);
    });
    child.on("error", (error) => {
      clearInterval(watchdog);
      reject(new Error(String(error?.message ?? error).slice(0, 240)));
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderrTail.trim().split(/[\r\n]+/).filter(Boolean).at(-1) ?? `git clone exited with status ${code}`;
      reject(new Error(detail.slice(0, 240)));
    });
  });
}

function workspaceEntries(dir) {
  try { return readdirSync(dir); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function githubGitContext(workspaceRoot) {
  if (!workspaceRoot) return {};
  const [remote, branch] = await Promise.all([
    gitRead(workspaceRoot, ["config", "--get", "remote.origin.url"]),
    gitRead(workspaceRoot, ["branch", "--show-current"]),
  ]);
  return { remote: remote ?? undefined, branch: branch ?? undefined };
}

// Background PR monitors (prMonitor.mjs): persisted in the state dir and
// polled through the broker once a minute. A material change updates the
// session's pr_monitor transcript row and delivers a turn so the agent
// learns about it without polling itself.
async function notifyPrMonitor(monitor, changes) {
  const entry = resolveEntry(monitor.logId);
  if (!entry) return;
  const label = `${monitor.owner}/${monitor.repo}#${monitor.number}`;
  let text = `[GitHub PR monitor] ${label}: ${changes.join("; ")}.${monitor.snapshot?.url ? ` ${monitor.snapshot.url}` : ""}`;
  if (pendingSeeds.has(entry.logId)) {
    text = `${pendingSeeds.get(entry.logId)}\n\n---\n\n${text}`;
    pendingSeeds.delete(entry.logId);
  }
  try {
    const turn = await entry.session.sendUserTurn({ input: [{ type: "text", text }], ifBusy: "queue" });
    if (turn?.turnId) followedTurns.add(turn.turnId);
    void pumpTurn(entry.logId, turn);
  } catch (error) {
    broadcast(entry.logId, { type: "turn_error", error: `PR monitor update could not be delivered: ${String(error?.message ?? error).slice(0, 200)}` });
  }
}

const prMonitors = createPrMonitorRegistry({
  storePath: `${STATE_DIR}/pr-monitors.json`,
  brokerRequest: githubBrokerRequest,
  broadcast,
  notify: notifyPrMonitor,
  sessionExists: (logId) => Boolean(resolveEntry(logId)) || Object.hasOwn(loadRegistry(), logId),
  log,
});

const githubToolset = createGitHubToolset({
  enabled: isGitHubEnabled,
  brokerRequest: githubBrokerRequest,
  gitContext: githubGitContext,
  monitors: prMonitors,
});

function healthPayload() {
  const relay = relayUpSyncCache;
  const turns = turnReadiness();
  return {
    ok: bootReady && relay !== false && unrecovered.size === 0 && turns.stuck.length === 0,
    booting: !bootReady,
    sessions: sessions.size,
    // Workspace paths are paths on this host; callers (the app's dev server)
    // use this to build them for whichever machine the pilot runs on.
    home: HOME,
    terminals: terminals.size(),
    relay: !RELAY_ENABLED ? "disabled" : relay === false ? "down" : relay === true ? "up" : "unknown",
    // Informational only: GitHub is optional, so a down broker never flips ok.
    github_broker: brokerUpSyncCache === false ? "down" : brokerUpSyncCache === true ? "up" : "unknown",
    unrecovered: [...unrecovered],
    turns,
  };
}
// Last relay probe result for the synchronous /health handler; refreshed by
// the background prober. Starts unknown until the first probe completes.
let relayUpSyncCache = null;
const relayProber = setInterval(async () => {
  if (!RELAY_ENABLED) return;
  try { relayUpSyncCache = await relayUp(); } catch { relayUpSyncCache = false; }
}, 15000);
// Never hold the event loop open for the regression suite.
if (typeof relayProber.unref === "function") relayProber.unref();

// ---- user-input requests (agent questions for the user) ----
// The serve host delivers `userInput/requested` into each session's fold;
// without a transport to the dashboard the turn hangs forever (the session
// just spins). This poller surfaces each pending prompt as a transcript
// event the worker picks up, and the HTTP endpoints below carry the user's
// answer back via `userInput/answer` (or `userInput/cancel`).
// userInputId -> stable logId, for settled detection.
const surfacedInputs = new Map();

// UUIDv7 for the SS3.1.1 idempotency handle the answer/cancel verbs require.
function uuidv7() {
  const bytes = randomFillSync(new Uint8Array(16));
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const truncate = (value, max) =>
  typeof value === "string" && value.length > max ? value.slice(0, max) : value;

// Cap the surfaced payload: the full question set also flows through
// GET /sessions/:id/user-inputs, so the persisted transcript event stays small.
function summarizeUserInput(input) {
  const questions = Array.isArray(input?.questions) ? input.questions.slice(0, 10) : [];
  return {
    userInputId: input?.userInputId,
    turnId: input?.turnId ?? null,
    autoResolutionMs: typeof input?.autoResolutionMs === "number" ? input.autoResolutionMs : null,
    questions: questions.map((q) => ({
      id: q?.id,
      header: truncate(q?.header, 120),
      question: truncate(q?.question, 2000),
      selection: q?.selection ?? { mode: "single" },
      options: (Array.isArray(q?.options) ? q.options.slice(0, 10) : []).map((o) => ({
        label: truncate(o?.label, 500),
        description: truncate(o?.description, 1000),
      })),
    })),
  };
}

function userInputAlreadyLogged(logId, userInputId) {
  for (const ev of eventLog.get(logId) ?? []) {
    if ((ev.type === "user_input_requested" || ev.type === "user_input_answered") && ev.userInputId === userInputId) {
      return true;
    }
  }
  return false;
}

function liveUserInputs(entry) {
  try {
    const pending = entry.session.fold.pendingUserInputs();
    return Array.isArray(pending) ? pending : [];
  } catch {
    return [];
  }
}

function pollUserInputs() {
  try {
    const seen = new Set();
    for (const entry of sessions.values()) {
      for (const input of liveUserInputs(entry)) {
        const userInputId = input?.userInputId;
        if (typeof userInputId !== "string" || !userInputId) continue;
        seen.add(userInputId);
        if (surfacedInputs.has(userInputId)) continue;
        surfacedInputs.set(userInputId, entry.logId);
        // Boot reconciliation: a restart re-surfaces a still-pending prompt
        // without duplicating its transcript marker.
        if (!userInputAlreadyLogged(entry.logId, userInputId)) {
          broadcast(entry.logId, { type: "user_input_requested", ...summarizeUserInput(input) });
          log("user input requested:", entry.logId, userInputId);
        }
      }
    }
    for (const [userInputId, logId] of surfacedInputs) {
      if (!seen.has(userInputId)) {
        surfacedInputs.delete(userInputId);
        broadcast(logId, { type: "user_input_settled", userInputId });
      }
    }
  } catch (e) {
    log("user input poll failed:", String(e).slice(0, 160));
  }
}
const userInputProber = setInterval(pollUserInputs, 3000);
// Never hold the event loop open for the regression suite.
if (typeof userInputProber.unref === "function") userInputProber.unref();

async function boot() {
  bootReady = false;
  syncGitIdentityToGitconfig();
  relayUpSyncCache = await relayUp();
  await waitForRelay();
  client = await spawnHost();
  log("serve host up, durability:", safeJson(client.durability));
  // Required MCP endpoints must already be reachable before resumeAll:
  // muse serve may connect to each session's server during session/resume.
  await new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    server.once("error", fail);
    server.listen(PORT, "127.0.0.1", () => {
      server.off("error", fail);
      log(`listening on 127.0.0.1:${PORT}`);
      resolve();
    });
  });
  await resumeAll();
  const resumedMonitors = prMonitors.boot();
  if (resumedMonitors) log(`resumed ${resumedMonitors} PR monitor(s)`);
  bootReady = true;

  // Watch for host death and respawn.
  (async () => {
    for (;;) {
      const exit = await client.exit;
      if (shuttingDown) break; // our own clean close, not a death — stay down
      log("serve host exited:", safeJson(exit).slice(0, 200));
      bootReady = false;
      mcpTokens.clear(); // only freshly resumed sessions may use MCP tokens
      broadcastAll({ type: "host_restarted" });
      await new Promise((r) => setTimeout(r, 2000));
      try {
        client = await spawnHost();
        log("serve host respawned");
        await resumeAll();
        bootReady = true;
      } catch (e) {
        log("respawn failed:", String(e).slice(0, 200));
      }
    }
  })();

}

function broadcastAll(event) {
  for (const { logId } of sessions.values()) broadcast(logId, event);
}

// ---- agent-to-agent messages ----
// muse serve sessions get no native peer messaging (muse 1.4 registers
// session-message targets for TUI sessions only), so the pilot provides it:
// agents use the required Code Space MCP tools; the user's Muse assistant
// uses the app's sendAgentMessage action. The pilot delivers each
// message to the target agent as a new turn (queued if it's busy) whose
// header says who sent it and how to reply, and records it in both
// transcripts. Replies to Muse land in a Muse inbox the app can read.

const MUSE = "muse"; // the reserved name for the user's Muse assistant
// MCP token (from a session's code-space MCP URL) -> backend session id.
const mcpTokens = new Map();

// The user's Muse assistant as agents see it: its avatar name and theme color.
// Defaults to Jolly (the default Muse avatar) in the default Muse color; on a
// Muse VM the assistant sets its real avatar name/color (app action
// setAssistantIdentity). "muse", "jolly" and the assistant's name are
// reserved: no agent can take them, and messages to them go to the assistant.
const ASSISTANT_PATH = `${STATE_DIR}/assistant.json`;
const DEFAULT_ASSISTANT = {
  name: process.env.MUSE_CODE_SPACE_ASSISTANT_NAME || "Jolly",
  color: process.env.MUSE_CODE_SPACE_ASSISTANT_COLOR || "#d0e4fc", // R .816 G .894 B .988
  avatar_data_url: null,
  // The user's own name, provided by the Muse assistant the same way it
  // provides its own name (setAssistantIdentity). Null until it does.
  user_name: process.env.MUSE_CODE_SPACE_USER_NAME || null,
};
function loadAssistant() {
  try {
    const saved = JSON.parse(readFileSync(ASSISTANT_PATH, "utf8"));
    return {
      name: typeof saved.name === "string" && saved.name.trim() ? saved.name.trim() : DEFAULT_ASSISTANT.name,
      color: typeof saved.color === "string" && /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : DEFAULT_ASSISTANT.color,
      avatar_data_url: saved.avatar_data_url != null && !validateAssistantAvatar(saved.avatar_data_url) ? saved.avatar_data_url : null,
      user_name: typeof saved.user_name === "string" && saved.user_name.trim() ? saved.user_name.trim() : DEFAULT_ASSISTANT.user_name,
    };
  } catch {
    return { ...DEFAULT_ASSISTANT };
  }
}
let assistant = loadAssistant();
function reservedNames() {
  return new Set([MUSE, "jolly", assistant.name.toLowerCase()]);
}
function isReservedName(name) {
  return reservedNames().has(String(name ?? "").trim().replace(/^@/, "").toLowerCase());
}
const personNamePattern = /^[\p{L}\p{N}][\p{L}\p{N} _.'-]{0,39}$/u;
function setAssistant({ name, color, avatar_data_url, user_name }) {
  const next = { ...assistant };
  if (user_name !== undefined) {
    if (user_name === null) {
      next.user_name = null;
    } else {
      const clean = String(user_name).trim();
      if (!personNamePattern.test(clean)) return { ok: false, error: "user_name must be 1-40 letters, digits, spaces, - or _" };
      next.user_name = clean;
    }
  }
  if (name !== undefined) {
    const clean = String(name).trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u.test(clean)) return { ok: false, error: "name must be 1–40 letters, digits, spaces, - or _" };
    if (findAgent(clean)) return { ok: false, error: `an agent is already called "${clean}"` };
    next.name = clean;
  }
  if (color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(color))) return { ok: false, error: "color must be #rrggbb" };
    next.color = String(color).toLowerCase();
  }
  if (avatar_data_url !== undefined) {
    if (avatar_data_url !== null) {
      const error = validateAssistantAvatar(avatar_data_url);
      if (error) return { ok: false, error };
    }
    next.avatar_data_url = avatar_data_url;
  }
  writeFileSync(ASSISTANT_PATH, JSON.stringify(next, null, 2));
  assistant = next;
  return { ok: true, assistant };
}
const MUSE_INBOX_PATH = `${STATE_DIR}/muse-inbox.jsonl`;
const MUSE_INBOX_MAX = 500;
let museInboxSeq = 0;
// Outstanding UI request asking Muse to initiate the custom.github-broker
// Secure Vault addition (repo picker GitHub setup, broker step). In-memory:
// a pilot restart simply lets the user ask again.
let brokerSetupRequested = false;
// GitHub App step (dialog): help requested from Muse, and credentials
// written by the pilot but not yet activated (broker restart pending).
let appHelpRequested = false;
let appActivationPending = false;
let appActivationRequested = false;
let appActivationProbe = { at: 0, ok: false };

function agentDirectory() {
  const busy = new Set([...openTurns.values()].map((t) => t.logId));
  return [...sessions.values()]
    .filter((entry) => entry.meta?.name)
    .map((entry) => ({ name: entry.meta.name, sessionId: entry.logId, busy: busy.has(entry.logId), workspaceRoot: entry.meta.workspaceRoot ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** An agent by name (case-insensitive) or app-visible session id. */
function findAgent(ref) {
  if (!ref) return undefined;
  const wanted = String(ref).trim().replace(/^@/, "").toLowerCase();
  for (const entry of sessions.values()) {
    if (entry.logId === ref || entry.session.sessionId === ref) return entry;
    if (entry.meta?.name && entry.meta.name.toLowerCase() === wanted) return entry;
  }
  return undefined;
}

const MAX_SOUL_LENGTH = 8000;
function cleanSoul(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim().slice(0, MAX_SOUL_LENGTH);
  return clean ? clean : null;
}
function soulBlock(soul) {
  const clean = cleanSoul(soul);
  return clean ? `[SOUL.md]\n${clean}` : null;
}

// Told to every named agent on its first turn (the app shows the user's
// prompt from its own DB, so this doesn't clutter the transcript). The
// companion's SOUL.md rides along here so its personality actually shapes
// the conversation; it sits before the --- separator, so transcript
// restore keeps stripping it along with the rest of the preamble.
function agentPreamble(name, soul, projectBriefing) {
  const lines = [
    `[Code Space] You are agent "${name}". Other agents and the user's Muse assistant (${assistant.name}) may message you; messages arrive as turns starting with "Message from …".`,
    'To message another agent or the assistant, use mcp__code_space__send_message with a name from mcp__code_space__list_agents (including the assistant’s avatar name).',
    'If the user asks "Send @name a message ...", @name refers to a Code Space agent: call mcp__code_space__send_message with to: "name" (without @) and the requested message as text. A quoted mention like @"My Agent" means the exact multiword name. Never use a shell or code-agents for agent messaging.',
    'When you start or preview a web/dev server on 127.0.0.1:<port>, run it in the background until it is listening, call mcp__code_space__preview_screenshot with port: <port>, and paste the returned [![...](.code-space/preview-<port>.png)](http://127.0.0.1:<port>/) Markdown line verbatim into your reply so the user can click it to open the live Preview tab. You can also embed any workspace image in your reply with ![alt](relative/path.png).',
  ];
  const block = soulBlock(soul);
  if (block) lines.push("", block);
  // The project briefing ([Project: …] description/references/PROJECT.md)
  // rides the same hidden channel as the SOUL.
  const briefing = cleanSoul(projectBriefing);
  if (briefing) lines.push("", briefing);
  return lines.join("\n");
}

// Add a routing hint only to an explicit "Send @agent ..." command. The app
// stores/displays the original prompt; the selected agent (not the browser or
// the user's assistant) still makes the actual MCP call as itself. This also
// helps sessions created before the @mention instruction was in the preamble.
function annotateAgentMention(text, sender) {
  if (typeof text !== "string") return text;
  const match = /^send[ \t]+@(?:"((?:\\.|[^"\\\n])*)"|([\p{L}\p{N}_-]+))(?=[\s,.;:!?]|$)/iu.exec(text.trim());
  if (!match) return text;
  let name = match[2];
  try { if (match[1] !== undefined) name = JSON.parse(`"${match[1]}"`); } catch { return text; }
  const assistantRecipient = isReservedName(name);
  const target = assistantRecipient ? undefined : findAgent(name);
  if (target?.logId === sender.logId) return text;
  if (!target?.meta?.name && !assistantRecipient) return text;
  const to = JSON.stringify(target?.meta?.name ?? assistant.name);
  const recipient = target?.meta?.name ? `agent ${JSON.stringify(target.meta.name)}` : `the user's Muse assistant ${JSON.stringify(assistant.name)}`;
  return `[Code Space routing: this request addresses ${recipient}. Use mcp__code_space__send_message with to: ${to} and the message asked for below. Do not do the recipient's task yourself; never use a shell messenger.]\n\n${text}`;
}

function messageHeader(from) {
  if (from.kind === MUSE) {
    return `Message from ${from.name} — the user's Muse assistant (via Code Space). To reply: use mcp__code_space__send_message with to ${JSON.stringify(from.name)}.`;
  }
  return `Message from agent "${from.name}" (via Code Space). To reply: use mcp__code_space__send_message with to "${from.name}".`;
}

function readMuseInbox(since = 0) {
  const out = [];
  try {
    for (const line of readFileSync(MUSE_INBOX_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (typeof message.seq === "number") museInboxSeq = Math.max(museInboxSeq, message.seq);
        if (message.seq > since) out.push(message);
      } catch { /* skip */ }
    }
  } catch { /* no inbox yet */ }
  return out.slice(-MUSE_INBOX_MAX);
}

/**
 * Deliver one message. `from` is {kind:"agent", entry} or {kind:"muse"};
 * `to` is an agent name/id or "muse". Returns { ok, messageId, to, queued } or { ok:false, error, code }.
 */
async function deliverAgentMessage({ from, to, text }) {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, code: "bad_request", error: "message text is empty" };
  if (body.length > 20000) return { ok: false, code: "bad_request", error: "message is over 20000 characters" };
  const messageId = uuidv7();
  const museRef = { kind: MUSE, name: assistant.name, color: assistant.color, sessionId: null };
  const fromRef = from.kind === MUSE
    ? museRef
    : { kind: "agent", name: from.entry.meta?.name ?? from.entry.logId, sessionId: from.entry.logId };
  const at = new Date().toISOString();

  if (isReservedName(to)) {
    if (from.kind === MUSE) return { ok: false, code: "bad_request", error: "Muse can't message itself" };
    readMuseInbox(); // load the seq watermark
    const record = { seq: ++museInboxSeq, messageId, at, from: fromRef, text: body };
    appendFileSync(MUSE_INBOX_PATH, `${JSON.stringify(record)}\n`);
    broadcast(from.entry.logId, { type: "agent_message", direction: "out", messageId, from: fromRef, to: museRef, text: body });
    return { ok: true, messageId, to: museRef, queued: false };
  }

  const target = findAgent(to);
  if (!target) return { ok: false, code: "unknown_agent", error: `no agent named "${to}" — use mcp__code_space__list_agents` };
  if (from.kind === "agent" && target.logId === from.entry.logId) return { ok: false, code: "bad_request", error: "an agent can't message itself" };
  const toRef = { kind: "agent", name: target.meta?.name ?? target.logId, sessionId: target.logId };
  const queued = [...openTurns.values()].some((t) => t.logId === target.logId);
  let turnText = `${messageHeader(fromRef)}\n\n${body}`;
  if (pendingSeeds.has(target.logId)) {
    turnText = `${pendingSeeds.get(target.logId)}\n\n---\n\n${turnText}`;
    pendingSeeds.delete(target.logId);
  }
  // Recorded before the turn starts so the receiver's transcript shows the
  // message above whatever the agent does with it.
  broadcast(target.logId, { type: "agent_message", direction: "in", messageId, from: fromRef, to: toRef, text: body, queued });
  if (from.kind === "agent") {
    broadcast(from.entry.logId, { type: "agent_message", direction: "out", messageId, from: fromRef, to: toRef, text: body, queued });
  }
  try {
    const turn = await target.session.sendUserTurn({ input: [{ type: "text", text: turnText }], ifBusy: "queue" });
    if (turn?.turnId) followedTurns.add(turn.turnId);
    void pumpTurn(target.logId, turn);
    return { ok: true, messageId, to: toRef, queued };
  } catch (e) {
    const error = `delivery failed: ${String(e?.message ?? e).slice(0, 300)}`;
    broadcast(target.logId, { type: "turn_error", error });
    return { ok: false, code: "delivery_failed", error };
  }
}

// What the MCP tools need (mcp.mjs).
const mcpDeps = {
  agentForToken(token) {
    const backendId = mcpTokens.get(token);
    return backendId ? sessions.get(backendId) : undefined;
  },
  listAgents(self) {
    const others = agentDirectory().filter((a) => a.sessionId !== self.logId);
    const lines = others.map((a) => `- ${a.name}${a.busy ? " (busy)" : ""}`);
    lines.push(`- ${assistant.name} — your Muse assistant`);
    return `You are "${self.meta?.name ?? self.logId}". You can message:\n${lines.join("\n")}`;
  },
  sendMessage(self, to, text) {
    return deliverAgentMessage({ from: { kind: "agent", entry: self }, to, text });
  },
  github: githubToolset,
};

// Permanently forget a session: registry entry, alias, buffers and the
// transcript file (events-<id>.jsonl). Refuses while a turn is running. The
// MSP has no session-delete verb, so muse serve's own session store is left
// alone; the pilot simply never resumes the session again.
function isOwnedWorkspacePath(wsDir) {
  if (typeof wsDir !== "string" || !wsDir.trim()) return false;
  const root = resolve(WORKSPACES);
  const target = resolve(wsDir);
  const rel = relative(root, target);
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes("/") && !rel.includes("\\");
}

function deleteSession(id, requestedWorkspaceRoot = null) {
  const entry = resolveEntry(id);
  const logId = entry?.logId ?? id;
  for (const t of openTurns.values()) {
    if (t.logId === logId) return { ok: false, code: "turn_running", error: "a turn is running; stop it before deleting the session" };
  }
  let existed = false;
  let metaWorkspaceRoot = entry?.meta?.workspaceRoot ?? null;
  for (const [backendId, candidate] of sessions) {
    if (candidate.logId === logId) {
      if (!metaWorkspaceRoot && candidate.meta?.workspaceRoot) metaWorkspaceRoot = candidate.meta.workspaceRoot;
      sessions.delete(backendId);
      existed = true;
    }
  }
  // Drop only this entry: the file can hold sessions that aren't loaded
  // (e.g. unrecovered), which saveRegistry() would otherwise lose.
  const registry = loadRegistry();
  if (registry[logId]) {
    if (!metaWorkspaceRoot && registry[logId]?.workspaceRoot) metaWorkspaceRoot = registry[logId].workspaceRoot;
    existed = true;
  }
  if (existed) {
    delete registry[logId];
    for (const { meta, logId: liveId } of sessions.values()) registry[liveId] = meta;
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  }
  if (aliases.delete(logId)) saveAliases();
  prMonitors.forgetSession(logId); // its transcript row is gone; stop watching
  previewWs.closeAllForSession(logId);
  for (const sub of subscribers.get(logId) ?? []) {
    try { sub.end(); } catch { /* already closed */ }
  }
  subscribers.delete(logId);
  eventLog.delete(logId);
  appendCounts.delete(logId);
  pendingSeeds.delete(logId);
  unrecovered.delete(logId);
  if (existsSync(eventPath(logId))) {
    unlinkSync(eventPath(logId));
    existed = true;
  }
  const wsDir = metaWorkspaceRoot ?? (typeof requestedWorkspaceRoot === "string" && requestedWorkspaceRoot.trim() ? requestedWorkspaceRoot.trim() : null);
  if (wsDir && isOwnedWorkspacePath(wsDir) && existsSync(wsDir)) {
    try {
      rmSync(wsDir, { recursive: true, force: true });
      existed = true;
    } catch (error) {
      return { ok: false, code: "workspace_delete_failed", error: `could not delete working directory: ${String(error?.message ?? error).slice(0, 200)}` };
    }
  }
  if (existed) log("deleted session", logId);
  return { ok: true, sessionId: logId, existed };
}

// ---- HTTP API ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 25e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function buildTurnInputParts(text, attachments) {
  const parts = [];
  if (typeof text === "string" && text.length > 0) {
    parts.push({ type: "text", text });
  }
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (
        att &&
        typeof att.mediaType === "string" &&
        /^image\/[a-z0-9.+-]+$/i.test(att.mediaType) &&
        typeof att.base64Data === "string" &&
        att.base64Data.length > 0
      ) {
        parts.push({
          type: "image",
          mediaType: att.mediaType,
          base64Data: att.base64Data,
        });
      }
    }
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "" });
  }
  return parts;
}
// Terminals for the UI (shells in session workspaces on this host).
const terminals = createTerminalManager({ log, envExtras: () => githubSessionEnv() });
const previewWs = createPreviewWsManager();

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(safeJson(obj));
};

function defaultWorkspacePath(workspaceName) {
  const token = workspaceName
    ? createHash("sha256").update(workspaceName).digest("hex").slice(0, 12)
    : uuidv7().slice(-12);
  return `${WORKSPACES}/${token}`;
}

// Auto-generated names must not attach a new agent to an unrelated directory.
// Explicit user-selected paths intentionally support existing workspaces.
function createWorkspacePath(path, generated) {
  if (!generated) { mkdirSync(path, { recursive: true }); return true; }
  try { mkdirSync(path); return true; }
  catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function createPilotSession(body) {
  const appSessionId = typeof body.workspaceName === "string" && body.workspaceName.trim() ? body.workspaceName.trim() : null;
  if (appSessionId && inFlightSessionStarts.has(appSessionId)) {
    return inFlightSessionStarts.get(appSessionId);
  }
  const promise = createPilotSessionInner(body, appSessionId);
  if (appSessionId) {
    inFlightSessionStarts.set(appSessionId, promise);
    promise.finally(() => {
      if (inFlightSessionStarts.get(appSessionId) === promise) {
        inFlightSessionStarts.delete(appSessionId);
      }
    });
  }
  return promise;
}

async function createPilotSessionInner(body, appSessionId) {
  let entry = appSessionId
    ? [...sessions.values()].find((candidate) => candidate.meta?.appSessionId === appSessionId)
    : undefined;
  if (!entry && appSessionId) {
    // A registered session may not be live after a backend restart. Recover
    // it under its original pilot id instead of creating a duplicate.
    const saved = Object.entries(loadRegistry()).find(([, meta]) => meta?.appSessionId === appSessionId);
    if (saved) {
      const [id, meta] = saved;
      if (!(await recoverSession(id, meta))) {
        return { code: 503, body: { error: "existing session could not be recovered", code: "recovery_failed" } };
      }
      entry = resolveEntry(id);
    }
  }
  if (!entry) {
    const repoPick = body.repo === undefined || body.repo === null ? null : parseRepoInput(body.repo);
    if (body.repo !== undefined && body.repo !== null && !repoPick) {
      return { code: 400, body: { error: "Pick a repository as owner/repo or a github.com URL.", code: "invalid_repo" } };
    }
    // Per-checkout commit author override: only meaningful with a repo, and
    // validated here exactly as at the app layer (fail before any clone).
    const gitAuthor = body.gitAuthor === undefined || body.gitAuthor === null ? null : parseGitIdentity(body.gitAuthor);
    if (body.gitAuthor !== undefined && body.gitAuthor !== null && !gitAuthor) {
      return { code: 400, body: { error: "Provide a valid author name and email for this checkout.", code: "invalid_git_identity" } };
    }
    if (gitAuthor && !repoPick) {
      return { code: 400, body: { error: "A commit author override needs a picked repository.", code: "invalid_git_identity" } };
    }
    // Direct pilot callers also get a short, stable directory without
    // leaking their mutable title or the full workspaceName into the path.
    const wsDir = body.workspaceRoot ?? defaultWorkspacePath(appSessionId);
    if (repoPick) {
      // Clone before the session starts so the agent opens in the repo,
      // not an empty folder it must clone into by hand. A retry that finds
      // the same repo already cloned reuses it.
      const cloneKey = appSessionId || wsDir;
      activeClones.set(cloneKey, {
        repo: repoPick.slug,
        phase: "Connecting to GitHub",
        percent: null,
        transferred: null,
        startedAt: Date.now(),
      });
      try {
        await ensureRepoCloned({
          dir: wsDir,
          repo: repoPick,
          gitClone: gitCloneRepo,
          gitOrigin: (dir) => gitRead(dir, ["config", "--get", "remote.origin.url"]),
          gitHead: (dir) => gitRead(dir, ["rev-parse", "--verify", "HEAD"]),
          removeDir: (dir) => { rmSync(dir, { recursive: true, force: true }); },
          listDir: workspaceEntries,
          onProgress: (progress) => {
            activeClones.set(cloneKey, {
              repo: repoPick.slug,
              phase: progress.phase,
              percent: progress.percent,
              transferred: progress.transferred,
              startedAt: Date.now(),
            });
          },
        });
      } catch (error) {
        return { code: 422, body: { error: `Could not clone ${repoPick.slug}: ${String(error?.message ?? error).slice(0, 300)}`, code: "repo_clone_failed" } };
      } finally {
        activeClones.delete(cloneKey);
      }
    } else if (!createWorkspacePath(wsDir, !body.workspaceRoot || body.generatedWorkspace === true)) {
      return { code: 409, body: { error: "generated working directory already exists; start a new companion", code: "workspace_conflict" } };
    }
    // Apply the per-checkout author as repo-local config (beats the global
    // identity in the session gitconfig). Failure must not lose the session.
    let appliedGitAuthor = null;
    if (gitAuthor && existsSync(join(wsDir, ".git"))) {
      appliedGitAuthor = (await gitConfigLocal(wsDir, gitAuthor)) ? gitAuthor : null;
    }
    const meta = {
      title: body.title ?? null,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : null,
      modelId: body.modelId || (await defaultModelId()),
      createdAt: new Date().toISOString(),
      workspaceRoot: wsDir,
      repo: repoPick?.slug ?? null,
      gitAuthor: appliedGitAuthor ?? effectiveGitIdentity(),
      appSessionId,
      initialTurnId: null,
      soul: cleanSoul(body.soul),
      projectBriefing: cleanSoul(body.project_briefing),
    };
    const session = await client.startSession({ workspaceRoot: wsDir, modelId: meta.modelId, approvalMode: "allowAll" });
    wireSession(session, meta);
    if (meta.name) {
      const canonical = await renameBackendSession(session.sessionId, meta.name);
      if (canonical) {
        meta.name = canonical;
        saveRegistry();
      }
    }
    broadcast(session.sessionId, { type: "session_started", meta });
    entry = resolveEntry(session.sessionId);
  }
  if (body.prompt && !entry.meta.initialTurnId) {
    if (!(await relayUp())) {
      return { code: 503, body: { error: "credential relay unavailable; retry once it is back", code: "relay_down", sessionId: entry.logId } };
    }
    try {
      const firstText = entry.meta.name ? `${agentPreamble(entry.meta.name, entry.meta.soul, entry.meta.projectBriefing)}\n\n---\n\n${body.prompt}` : body.prompt;
      const turn = await entry.session.sendUserTurn({
        input: buildTurnInputParts(firstText, body.attachments),
        reasoningEffort: normEffort(body.reasoningEffort),
      });
      if (!turn?.turnId) throw new Error("turn admitted without a turn id");
      entry.meta.initialTurnId = turn.turnId;
      saveRegistry();
      void pumpTurn(entry.logId, turn);
    } catch (e) {
      const error = String(e?.message ?? e).slice(0, 500);
      broadcast(entry.logId, { type: "turn_error", error });
      return { code: 500, body: { error, code: "turn_rejected", sessionId: entry.logId } };
    }
  }
  return {
    code: 200,
    body: { sessionId: entry.logId, turnId: entry.meta.initialTurnId ?? null, modelId: entry.meta.modelId, name: entry.meta.name },
  };
}

async function createPilotSessionOnce(body) {
  const key = typeof body.workspaceName === "string" && body.workspaceName.trim() ? body.workspaceName.trim() : null;
  if (!key) return createPilotSession(body);
  const pending = sessionCreates.get(key);
  if (pending) return pending;
  const attempt = createPilotSession(body);
  sessionCreates.set(key, attempt);
  try {
    return await attempt;
  } finally {
    sessionCreates.delete(key);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return json(res, 200, healthPayload());
    }
    // MCP handshakes must work while sessions are resuming; other routes
    // must wait until the registry is reconciled.
    if (!bootReady && !path.startsWith("/mcp/")) {
      return json(res, 503, { error: "pilot is resuming sessions", code: "pilot_starting" });
    }

    // POST /terminals {key, cwd, cols, rows, terminalId?} -> {terminalId, reattached, cwd, number, exited}
    //   (new shell unless terminalId names one of this key's shells to reattach to)
    // GET /terminals?key=K -> {terminals: [{terminalId, number, exited, exitCode, cwd}]}
    // POST /terminals/:id/input {data} · POST /terminals/:id/resize {cols, rows}
    // GET /terminals/:id/output?since=N&waitMs=M -> {data(base64), next, exited, exitCode, truncated}
    // DELETE /terminals/:id
    if (path === "/terminals" || path.startsWith("/terminals/")) {
      const body = req.method === "POST" ? await readBody(req).catch(() => ({})) : {};
      try {
        if (await handleTerminalRoute(terminals, req.method, path, url, body, (code, obj) => json(res, code, obj))) return;
      } catch (e) {
        return json(res, terminalErrorStatus(e), { error: String(e?.message ?? e).slice(0, 300), code: e?.code ?? "terminal_error" });
      }
    }

    // Wire debug log: pilot<->backend JSON-RPC traffic. Capture is always on;
    // POST /debug/wire {clear:true} empties the buffer. GET returns the
    // ring buffer. The UI toggle only shows/hides the panel.
    if (req.method === "GET" && path === "/debug/relay") {
      if (!RELAY_ENABLED) return json(res, 200, { enabled: false, status: "disabled", entries: [], startedAt: null, lastSuccessAt: null, lastFailureAt: null, error: null });
      try {
        const response = await fetch(`${RELAY_URL}/__code_space/diagnostics`, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json();
        if (data?.ok !== true || !Array.isArray(data.entries)) throw new Error("invalid diagnostics");
        const entries = data.entries.slice(-100).map((item) => ({
          id: Number.isSafeInteger(item.id) && item.id >= 0 ? item.id : 0,
          at: typeof item.at === "string" ? item.at.slice(0, 32) : "",
          method: typeof item.method === "string" ? item.method.slice(0, 8) : "",
          path: ["/v1/responses", "/models", "/other"].includes(item.path) ? item.path : "/other",
          status: Number.isSafeInteger(item.status) && item.status >= 0 ? item.status : 0,
          durationMs: Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 ? item.durationMs : 0,
          requestBytes: Number.isSafeInteger(item.requestBytes) && item.requestBytes >= 0 ? item.requestBytes : 0,
          responseBytes: Number.isSafeInteger(item.responseBytes) && item.responseBytes >= 0 ? item.responseBytes : 0,
          stage: ["complete", "upstream_http", "credential", "proxy", "upstream_connect", "timeout", "response_stream", "client_disconnect", "blocked", "request"].includes(item.stage) ? item.stage : "other",
          errorType: typeof item.errorType === "string" ? item.errorType.slice(0, 60) : null,
        }));
        return json(res, 200, { enabled: true, status: "up", entries,
          startedAt: typeof data.startedAt === "string" ? data.startedAt.slice(0, 32) : null,
          lastSuccessAt: typeof data.lastSuccessAt === "string" ? data.lastSuccessAt.slice(0, 32) : null,
          lastFailureAt: typeof data.lastFailureAt === "string" ? data.lastFailureAt.slice(0, 32) : null,
          error: null });
      } catch {
        return json(res, 200, { enabled: true, status: "down", entries: [], startedAt: null, lastSuccessAt: null, lastFailureAt: null, error: "Relay is unreachable." });
      }
    }
    if (path === "/debug/wire") {
      if (req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        if (body.clear) wireLog.length = 0;
        return json(res, 200, { enabled: true, entries: wireLog.length });
      }
      if (req.method === "GET") {
        return json(res, 200, { enabled: true, entries: wireLog });
      }
    }

    // Live model catalog via MSP model/list (a query, not a command).
    if (req.method === "GET" && path === "/models") {
      if (!connection) return json(res, 503, { error: "pilot not connected" });
      try {
        const params = {};
        const sid = url.searchParams.get("sessionId");
        if (sid) params.sessionId = sid;
        const result = await connection.request("model/list", params);
        return json(res, 200, result);
      } catch (e) {
        return json(res, 500, { error: `model/list failed: ${String(e).slice(0, 300)}` });
      }
    }

    // Repos the repo picker offers: what the GitHub broker credential can
    // see. GitHub is optional, so "not set up" is a 200 with enabled:false.
    if (req.method === "GET" && path === "/repos/clone-progress") {
      const workspaceName = url.searchParams.get("workspaceName") ?? "";
      const progress = activeClones.get(workspaceName) ?? null;
      return json(res, 200, progress
        ? {
            active: true,
            repo: progress.repo,
            phase: progress.phase,
            percent: progress.percent,
            transferred: progress.transferred,
          }
        : { active: false, repo: null, phase: null, percent: null, transferred: null });
    }

    if (req.method === "GET" && path === "/repos/search") {
      try {
        if (useDirectGhCli() && ghCliReadyCache === null) {
          await checkGhCliReady();
        }
        return json(res, 200, await searchGitHubRepos({
          enabled: isGitHubEnabled,
          brokerRequest: githubBrokerRequest,
          query: url.searchParams.get("q") ?? "",
        }));
      } catch (error) {
        return json(res, 502, { error: String(error?.message ?? error).slice(0, 300), code: "repo_search_failed" });
      }
    }

    if (req.method === "GET" && path === "/repos") {
      try {
        if (useDirectGhCli() && ghCliReadyCache === null) {
          await checkGhCliReady();
        }
        return json(res, 200, await listGitHubRepos({
          enabled: isGitHubEnabled,
          brokerRequest: githubBrokerRequest,
        }));
      } catch (error) {
        return json(res, 502, { error: String(error?.message ?? error).slice(0, 300), code: "repo_list_failed" });
      }
    }

    if (req.method === "GET" && path === "/sessions") {
      // Stable app-visible ids; the live backend id rides along so the app
      // can follow backend restarts instead of polling a dead watermark.
      return json(res, 200, [...sessions.values()].map(({ session, meta, logId }) => ({
        sessionId: logId, backendSessionId: session.sessionId,
        title: meta.title ?? null, name: meta.name ?? null, modelId: meta.modelId ?? null,
      })));
    }

    // Manual recovery handle for a registry id the backend doesn't know
    // (e.g. a turn submitted mid-restart): recreate + reseed without
    // changing the app-visible id. Boot-time resumeAll already does this
    // automatically; this covers the gap between restarts.
    // Agent-to-agent messages (see deliverAgentMessage):
    // GET  /agents -> {agents: [{name, sessionId, busy, workspaceRoot}]}
    // POST /messages {from:"muse", to, text} -> {ok, messageId, to, queued}
    //      only the user's Muse assistant uses this route; agents send via
    //      their session-scoped MCP tool, so they cannot spoof a sender.
    // GET  /messages/muse?since=N -> {messages: [...], latest}: replies to Muse
    if (req.method === "GET" && path === "/agents") {
      return json(res, 200, { agents: agentDirectory(), assistant: { name: assistant.name, color: assistant.color } });
    }
    // Global git commit identity: GET -> {identity} (identity file, else a
    // [user] section set by hand in the generated gitconfig, else null).
    // POST {name,email} sets it; POST {identity:null} clears it. Changes are
    // merged into the generated gitconfig immediately.
    if (path === "/git-identity") {
      if (req.method === "GET") return json(res, 200, { identity: effectiveGitIdentity() });
      if (req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        if (body.identity === null || (body.name === null && body.email === null)) {
          writeGitIdentityFile(GIT_IDENTITY_PATH, null);
          const gitconfig = join(dirname(STATE_DIR), "gitconfig");
          if (existsSync(gitconfig)) {
            const current = readFileSync(gitconfig, "utf8");
            const cleared = mergeGitIdentityIntoGitconfig(current, null, { clear: true });
            if (cleared !== current) writeFileSync(gitconfig, cleared);
          }
          return json(res, 200, { identity: null });
        }
        const identity = parseGitIdentity({ name: body.name ?? body.identity?.name, email: body.email ?? body.identity?.email });
        if (!identity) return json(res, 400, { error: "Provide a valid author name and email.", code: "invalid_git_identity" });
        writeGitIdentityFile(GIT_IDENTITY_PATH, identity);
        syncGitIdentityToGitconfig();
        return json(res, 200, { identity });
      }
    }
    // GitHub setup progress for the repo picker's setup dialog. Status is
    // derived from the broker config on disk: any config means the broker
    // is provisioned (gh + repo listing), an "app"-mode config additionally
    // means GitHub App authentication (git clone/push) — except while an
    // App credential written by this pilot still awaits broker activation,
    // when the broker probe decides.
    if (path === "/github-setup") {
      if (req.method === "GET") {
        if (useDirectGhCli()) {
          if (ghCliReadyCache === null) await checkGhCliReady();
          if (ghCliReadyCache === true) {
            return json(res, 200, {
              brokerDone: true,
              appDone: true,
              brokerRequested: false,
              appRequested: false,
              appHelpRequested: false,
            });
          }
        }
        let mode = null;
        try {
          if (existsSync(GITHUB_BROKER_CONFIG)) mode = JSON.parse(readFileSync(GITHUB_BROKER_CONFIG, "utf8"))?.mode ?? null;
        } catch { mode = null; }
        const appDone = mode === "app" && (appActivationPending ? await probeAppActivation() : true);
        return json(res, 200, {
          brokerDone: mode !== null, appDone, brokerRequested: brokerSetupRequested && mode === null,
          appRequested: appActivationPending, appHelpRequested,
        });
      }
      if (req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        if (body.step === "broker") {
          // Ask the user's Muse assistant to initiate the Secure Vault
          // addition of custom.github-broker: the request lands in the Muse
          // inbox (readMuseMessages), the assistant starts the vault flow
          // with the user in its own surface, and this dialog polls status
          // until the broker credential actually works. Repeated clicks
          // while a request is outstanding do not queue duplicates.
          if (!brokerSetupRequested) {
            brokerSetupRequested = true;
            appendMuseInboxRequest("Please set up the Code Space GitHub broker (gh command support): initiate the Secure Vault addition of a custom API credential named custom.github-broker, then write the surrogate broker config and restart the broker as described in hooks/code-space-assistant-job.md, and let the user know here when the broker is working.");
          }
          return json(res, 200, { brokerDone: false, appDone: false, brokerRequested: true });
        }
        if (body.step === "app-help") {
          // Guidance only: Muse walks the user through creating the App
          // and finding the IDs/key; the key itself is entered in the
          // dialog, never in the assistant conversation.
          if (!appHelpRequested) {
            appHelpRequested = true;
            appendMuseInboxRequest("Please guide me through creating the GitHub App for Code Space (GitHub App step in the repo picker): the App settings, Contents + Pull requests permissions, generating the private key, installing it on selected repositories, and where to find the App ID and installation ID. Remind me not to paste the private key into this conversation — I will enter it in the Code Space dialog.");
          }
          return json(res, 200, { brokerDone: false, appDone: false, appHelpRequested: true });
        }
        if (body.step === "app") {
          const appId = typeof body.appId === "string" ? body.appId.trim() : "";
          const installationId = typeof body.installationId === "string" ? body.installationId.trim() : "";
          const privateKey = typeof body.privateKey === "string" ? body.privateKey : "";
          if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId)) {
            return json(res, 400, { error: "App ID and installation ID must be numeric.", code: "invalid_github_app" });
          }
          if (!privateKey.includes("-----BEGIN") || !privateKey.includes("PRIVATE KEY-----") || !privateKey.includes("-----END")) {
            return json(res, 400, { error: "That did not look like a PEM private key.", code: "invalid_github_app" });
          }
          const setup = await runGithubAppSetup(appId, installationId, privateKey, {
            configFile: GITHUB_BROKER_CONFIG,
            profileFile: join(HOME, ".profile"),
            brokerCaFile: join(dirname(STATE_DIR), "github-broker-ca.pem"),
          });
          if (!setup.ok) return json(res, 422, { error: setup.error ?? "GitHub App validation failed — nothing written.", code: "github_app_validation_failed" });
          // Credentials are written and validated; the broker still has to
          // be restarted to load them. Ask Muse to activate + verify, and
          // let the status probe confirm before the step shows done.
          appActivationPending = true;
          appActivationProbe = { at: 0, ok: false };
          if (!appActivationRequested) {
            appActivationRequested = true;
            appendMuseInboxRequest("Please activate the Code Space GitHub App broker credential I just entered in the repo picker: restart muse-code-space-github-broker.service (sudo if needed), verify https://127.0.0.1:443/__code_space/health answers ok, and let me know here when git access is working. If the restart or health check fails, tell me the exact failing step.");
          }
          return json(res, 200, { brokerDone: true, appDone: false, appRequested: true });
        }
        return json(res, 400, { error: "Unknown setup step.", code: "invalid_github_setup_step" });
      }
    }
    // Spotify companion music (spotify.mjs). Loopback only, like every
    // pilot route. Responses never contain tokens: status reports only
    // whether a config exists (plus the account display name).
    if (path === "/spotify/status" && req.method === "GET") {
      return json(res, 200, await spotify.status());
    }
    if (path.startsWith("/spotify/")) {
      const body = req.method === "POST" ? await readBody(req).catch(() => ({})) : {};
      try {
        if (path === "/spotify/setup/start" && req.method === "POST") {
          const started = await spotify.startSetup({ clientId: body.client_id, redirectUri: body.redirect_uri });
          return json(res, 200, started);
        }
        if (path === "/spotify/setup/complete" && req.method === "POST") {
          const completed = await spotify.completeSetup({ code: body.code, state: body.state });
          return json(res, 200, completed);
        }
        if (path === "/spotify/disconnect" && req.method === "POST") {
          return json(res, 200, await spotify.disconnect());
        }
        if (!spotify.isConnected()) {
          return json(res, 409, { error: "Spotify is not connected", code: "spotify_not_connected" });
        }
        if (path === "/spotify/devices" && req.method === "GET") {
          return json(res, 200, { devices: await spotify.devices() });
        }
        if (path === "/spotify/playback" && req.method === "GET") {
          return json(res, 200, { playback: await spotify.playback() });
        }
        if (path === "/spotify/play" && req.method === "POST") {
          return json(res, 200, await spotify.play({ contextUri: body.context_uri, deviceId: body.device_id }));
        }
        if (path === "/spotify/pause" && req.method === "POST") return json(res, 200, await spotify.pause());
        if (path === "/spotify/resume" && req.method === "POST") return json(res, 200, await spotify.resume({ deviceId: body.device_id }));
        if (path === "/spotify/next" && req.method === "POST") return json(res, 200, await spotify.next());
        if (path === "/spotify/previous" && req.method === "POST") return json(res, 200, await spotify.previous());
        if (path === "/spotify/volume" && req.method === "POST") {
          return json(res, 200, await spotify.setVolume(body.volume_percent));
        }
        return json(res, 404, { error: "Unknown Spotify route", code: "spotify_unknown_route" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Spotify is not connected") {
          return json(res, 409, { error: message, code: "spotify_not_connected" });
        }
        // Setup validation fails fast with a precise client error; playback
        // and token failures are upstream (Spotify) errors.
        const isSetup = path.startsWith("/spotify/setup/");
        return json(res, isSetup ? 400 : 502, { error: message.slice(0, 300), code: isSetup ? "spotify_setup_invalid" : "spotify_error" });
      }
    }
    // Full assistant identity is fetched separately; avatars never enter message events.
    if (path === "/assistant") {
      if (req.method === "GET") return json(res, 200, assistant);
      if (req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const result = setAssistant({ name: body.name, color: body.color, avatar_data_url: body.avatar_data_url, user_name: body.user_name });
        return json(res, result.ok ? 200 : 400, result.ok ? result.assistant : result);
      }
    }
    // Code Space MCP server for one agent (see mcp.mjs): POST JSON-RPC.
    const mMcp = path.match(/^\/mcp\/([^/]+)$/);
    if (mMcp) {
      if (req.method !== "POST") {
        res.writeHead(req.method === "DELETE" ? 200 : 405, { allow: "POST" });
        return res.end();
      }
      const body = await readBody(req).catch(() => null);
      const response = await handleMcpRequest(decodeURIComponent(mMcp[1]), body, mcpDeps);
      if (response === null) {
        res.writeHead(202);
        return res.end();
      }
      return json(res, 200, response);
    }
    if (req.method === "POST" && path === "/messages") {
      const body = await readBody(req).catch(() => ({}));
      if (String(body.from ?? "").toLowerCase() !== MUSE) {
        return json(res, 403, { ok: false, code: "mcp_required", error: "agents must use the Code Space send_message MCP tool" });
      }
      const result = await deliverAgentMessage({ from: { kind: MUSE }, to: body.to, text: body.text });
      return json(res, result.ok ? 200 : result.code === "unknown_agent" ? 404 : 400, result);
    }
    if (req.method === "GET" && path === "/messages/muse") {
      const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
      const messages = readMuseInbox(since);
      return json(res, 200, { messages, latest: museInboxSeq });
    }

    // POST /sessions/:id/git-author {name,email} | {identity:null}: set or
    // clear the per-checkout commit author as repo-local git config in the
    // session workspace. Clearing unsets it, so the global identity in the
    // session gitconfig applies again.
    const mGitAuthor = path.match(/^\/sessions\/([^/]+)\/git-author$/);
    if (req.method === "POST" && mGitAuthor) {
      const entry = resolveEntry(decodeURIComponent(mGitAuthor[1]));
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const body = await readBody(req).catch(() => ({}));
      const wsDir = entry.meta?.workspaceRoot ?? null;
      if (!wsDir || !existsSync(join(wsDir, ".git"))) {
        return json(res, 409, { error: "session workspace is not a git checkout", code: "not_a_checkout" });
      }
      if (body.identity === null || (body.name === null && body.email === null)) {
        await gitConfigUnsetLocal(wsDir);
        entry.meta.gitAuthor = effectiveGitIdentity();
        saveRegistry();
        return json(res, 200, { ok: true, identity: entry.meta.gitAuthor });
      }
      const identity = parseGitIdentity(body);
      if (!identity) return json(res, 400, { error: "Provide a valid author name and email.", code: "invalid_git_identity" });
      if (!(await gitConfigLocal(wsDir, identity))) {
        return json(res, 500, { error: "could not write git config in the session workspace", code: "git_config_failed" });
      }
      entry.meta.gitAuthor = identity;
      saveRegistry();
      return json(res, 200, { ok: true, identity });
    }

    // POST /sessions/:id/rename {name} -> {name}: rename the agent in Muse
    // (session/rename); returns the canonical name Muse settled.
    const mRename = path.match(/^\/sessions\/([^/]+)\/rename$/);
    if (req.method === "POST" && mRename) {
      const entry = resolveEntry(decodeURIComponent(mRename[1]));
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const body = await readBody(req).catch(() => ({}));
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return json(res, 400, { error: "name required", code: "bad_request" });
      if (isReservedName(name)) return json(res, 409, { error: `"${name}" is reserved for the user's Muse assistant`, code: "reserved_name" });
      const canonical = await renameBackendSession(entry.session.sessionId, name);
      if (!canonical) return json(res, 409, { error: "Muse rejected the name", code: "rename_rejected" });
      entry.meta.name = canonical;
      if (body.soul !== undefined) {
        entry.meta.soul = cleanSoul(body.soul);
        // The next user turn carries the new companion's personality ahead
        // of it (via the pending-seed slot), so a handoff changes how the
        // agent works from its very next reply.
        const block = soulBlock(entry.meta.soul);
        if (block) {
          const existing = pendingSeeds.get(entry.logId);
          pendingSeeds.set(entry.logId, existing ? `${block}\n\n${existing}` : block);
        }
      }
      saveRegistry();
      return json(res, 200, { name: canonical });
    }

    // Agent-to-agent control: POST /sessions/:id/workflows/:workflowRunId/cancel -> { ok }
    // (workflow/cancel). Not subagent/readResult: that's a steering command
    // for the parent agent ("read the result"), not a data read for clients.
    const mAgent = path.match(/^\/sessions\/([^/]+)\/(workflows)\/([^/]+)\/(cancel)$/);
    if (req.method === "POST" && mAgent) {
      const entry = resolveEntry(decodeURIComponent(mAgent[1]));
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      if (!connection) return json(res, 503, { error: "pilot not connected" });
      const target = decodeURIComponent(mAgent[3]);
      const backendId = entry.session.sessionId;
      try {
        if (mAgent[2] === "workflows" && mAgent[4] === "cancel") {
          await connection.command("workflow/cancel", { commandId: uuidv7(), sessionId: backendId, workflowRunId: target });
          return json(res, 200, { ok: true });
        }
      } catch (e) {
        return json(res, 409, { error: String(e?.message ?? e).slice(0, 300), code: "agent_control_rejected" });
      }
      return json(res, 404, { error: "not found" });
    }

    // DELETE /sessions/:id -> { ok, sessionId, existed } (idempotent) | 409 turn_running
    const mDelete = path.match(/^\/sessions\/([^/]+)$/);
    if (req.method === "DELETE" && mDelete) {
      const result = deleteSession(decodeURIComponent(mDelete[1]), url.searchParams.get("workspaceRoot"));
      return json(res, result.ok ? 200 : 409, result);
    }

    // GET /sessions/:id/preview/ports?port=<optionalPort>
    const mPreviewPorts = path.match(/^\/sessions\/([^/]+)\/preview\/ports$/);
    if (req.method === "GET" && mPreviewPorts) {
      const id = decodeURIComponent(mPreviewPorts[1]);
      const entry = resolveEntry(id);
      const registry = entry ? null : loadRegistry();
      const meta = entry?.meta ?? registry?.[id] ?? null;
      const wsDir = meta?.workspaceRoot ?? null;
      const checkPort = Number(url.searchParams.get("port") ?? 0);
      const [ports, activeReachable] = await Promise.all([
        wsDir && existsSync(wsDir)
          ? discoverWorkspaceListeningPorts({ workspaceRoot: wsDir })
          : Promise.resolve([]),
        checkPort > 0 && isAllowedPreviewPort(checkPort)
          ? probeLocalPort(checkPort)
          : Promise.resolve(null),
      ]);
      return json(res, 200, { ports, activeReachable });
    }

    // POST /sessions/:id/preview/request
    const mPreviewReq = path.match(/^\/sessions\/([^/]+)\/preview\/request$/);
    if (req.method === "POST" && mPreviewReq) {
      const id = decodeURIComponent(mPreviewReq[1]);
      const entry = resolveEntry(id);
      const registry = entry ? null : loadRegistry();
      const meta = entry?.meta ?? registry?.[id] ?? null;
      if (!meta) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const body = await readBody(req);
      const result = await proxyPreviewHttpRequest({
        port: Number(body.port),
        method: body.method,
        path: body.path,
        headers: body.headers,
        bodyBase64: body.bodyBase64,
        previewBasePath: body.previewBasePath,
        sessionId: id,
      });
      return json(res, 200, result);
    }

    // POST /sessions/:id/preview/ws
    const mPreviewWs = path.match(/^\/sessions\/([^/]+)\/preview\/ws$/);
    if (req.method === "POST" && mPreviewWs) {
      const id = decodeURIComponent(mPreviewWs[1]);
      const entry = resolveEntry(id);
      const registry = entry ? null : loadRegistry();
      const meta = entry?.meta ?? registry?.[id] ?? null;
      if (!meta) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const body = await readBody(req);
      const cmd = body.cmd;
      if (cmd === "open") {
        return json(res, 200, previewWs.open({
          sessionId: id,
          clientId: String(body.clientId ?? ""),
          port: Number(body.port),
          path: String(body.path ?? "/"),
          protocols: Array.isArray(body.protocols) ? body.protocols : [],
        }));
      }
      if (cmd === "send") {
        return json(res, 200, previewWs.send({
          sessionId: id,
          clientId: String(body.clientId ?? ""),
          data: String(body.data ?? ""),
        }));
      }
      if (cmd === "poll") {
        return json(res, 200, await previewWs.pollAsync({
          sessionId: id,
          since: body.since && typeof body.since === "object" ? body.since : {},
          waitMs: Number(body.waitMs ?? 0),
        }));
      }
      if (cmd === "close") {
        return json(res, 200, previewWs.close({
          sessionId: id,
          clientId: String(body.clientId ?? ""),
        }));
      }
      return json(res, 400, { error: "invalid preview ws command" });
    }

    // GET /sessions/:id/vcs-status -> { isGitCheckout, branch, headSha, uncommittedFileCount, totalAdditions, totalDeletions, files, smartlogCommits }
    const mVcsStatus = path.match(/^\/sessions\/([^/]+)\/vcs-status$/);
    if (req.method === "GET" && mVcsStatus) {
      const id = decodeURIComponent(mVcsStatus[1]);
      const entry = resolveEntry(id);
      const registry = entry ? null : loadRegistry();
      const meta = entry?.meta ?? registry?.[id] ?? null;
      const wsDir = meta?.workspaceRoot ?? null;
      if (!wsDir || !existsSync(wsDir)) {
        return json(res, 200, {
          isGitCheckout: false,
          branch: null,
          headSha: null,
          uncommittedFileCount: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          files: [],
          smartlogCommits: [],
        });
      }
      const status = await readGitVcsStatus({
        dir: wsDir,
        gitExec: (args) => gitReadRaw(wsDir, args),
      });
      return json(res, 200, status);
    }

    const mRecover = path.match(/^\/sessions\/([^/]+)\/recover$/);
    if (req.method === "POST" && mRecover) {
      const id = mRecover[1];
      if (resolveEntry(id)) return json(res, 200, { sessionId: id, recovered: false });
      const registry = loadRegistry();
      const meta = registry[id];
      if (!meta) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const ok = await recoverSession(id, meta);
      if (!ok) return json(res, 500, { error: "recovery failed; see the session transcript for details", code: "recovery_failed" });
      unrecovered.delete(id);
      return json(res, 200, { sessionId: id, recovered: true });
    }

    // Agent questions for the user (the `request_user_input` transport).
    // GET /sessions/:id/user-inputs -> { inputs: [{ userInputId, turnId, autoResolutionMs, questions }] }
    const mInputs = path.match(/^\/sessions\/([^/]+)\/user-inputs$/);
    if (req.method === "GET" && mInputs) {
      const entry = resolveEntry(mInputs[1]);
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      pollUserInputs();
      return json(res, 200, {
        inputs: liveUserInputs(entry)
          .filter((input) => typeof input?.userInputId === "string")
          .map(summarizeUserInput),
      });
    }

    // POST /sessions/:id/user-inputs/answer { userInputId, answers: [{ questionId, selectedLabel?, selectedLabels?, freeText?, note? }] }
    const mAnswer = path.match(/^\/sessions\/([^/]+)\/user-inputs\/answer$/);
    if (req.method === "POST" && mAnswer) {
      const body = await readBody(req);
      const entry = resolveEntry(mAnswer[1]);
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const userInputId = body.userInputId;
      if (typeof userInputId !== "string" || !userInputId) {
        return json(res, 400, { error: "userInputId required", code: "bad_request" });
      }
      const live = liveUserInputs(entry).find((input) => input?.userInputId === userInputId);
      if (!live) {
        return json(res, 404, { error: "no pending input with that id (answered, cancelled, or timed out)", code: "input_not_pending" });
      }
      if (!connection) return json(res, 503, { error: "pilot not connected", code: "pilot_down" });
      try {
        await connection.command("userInput/answer", {
          sessionId: entry.session.sessionId,
          userInputId,
          commandId: uuidv7(),
          answers: Array.isArray(body.answers) ? body.answers : [],
        });
      } catch (e) {
        const error = `answer rejected: ${String(e?.message ?? e).slice(0, 300)}`;
        broadcast(entry.logId, { type: "user_input_error", userInputId, error });
        return json(res, 400, { error, code: "answer_rejected" });
      }
      broadcast(entry.logId, { type: "user_input_answered", userInputId });
      pollUserInputs();
      return json(res, 200, { ok: true, userInputId });
    }

    // POST /sessions/:id/user-inputs/cancel { userInputId, reason? }
    const mCancel = path.match(/^\/sessions\/([^/]+)\/user-inputs\/cancel$/);
    if (req.method === "POST" && mCancel) {
      const body = await readBody(req);
      const entry = resolveEntry(mCancel[1]);
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const userInputId = body.userInputId;
      if (typeof userInputId !== "string" || !userInputId) {
        return json(res, 400, { error: "userInputId required", code: "bad_request" });
      }
      const live = liveUserInputs(entry).find((input) => input?.userInputId === userInputId);
      if (!live) {
        return json(res, 404, { error: "no pending input with that id (answered, cancelled, or timed out)", code: "input_not_pending" });
      }
      if (!connection) return json(res, 503, { error: "pilot not connected", code: "pilot_down" });
      try {
        await connection.command("userInput/cancel", {
          sessionId: entry.session.sessionId,
          userInputId,
          commandId: uuidv7(),
          ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim().slice(0, 500) } : {}),
        });
      } catch (e) {
        const error = `cancel rejected: ${String(e?.message ?? e).slice(0, 300)}`;
        broadcast(entry.logId, { type: "user_input_error", userInputId, error });
        return json(res, 400, { error, code: "answer_rejected" });
      }
      broadcast(entry.logId, { type: "user_input_answered", userInputId });
      pollUserInputs();
      return json(res, 200, { ok: true, userInputId });
    }

    // POST /sessions/:id/turns/interrupt — the "user pressed stop" gesture.
    // Priority lane, targets the session's foreground turn. Acceptance means
    // admitted, not stopped: the turn ends on turn/completed (cancelled).
    const mInterrupt = path.match(/^\/sessions\/([^/]+)\/turns\/interrupt$/);
    if (req.method === "POST" && mInterrupt) {
      const entry = resolveEntry(mInterrupt[1]);
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      if (!connection) return json(res, 503, { error: "pilot not connected", code: "pilot_down" });
      // Prefer the explicit turn id when the session has an open turn under
      // pump; otherwise the backend resolves the foreground turn at admission.
      const open = [...openTurns.values()].find(
        (state) => state && (state.logId === entry.logId || state.logId === entry.session.sessionId),
      );
      try {
        const result = await connection.command("turn/interrupt", {
          sessionId: entry.session.sessionId,
          commandId: uuidv7(),
          ...(open?.turnId ? { turnId: open.turnId } : {}),
        });
        if (result && typeof result === "object" && result.status !== "accepted") {
          return json(res, 409, {
            error: `interrupt not admitted (status "${String(result.status).slice(0, 80)}") — there may be no running turn`,
            code: "interrupt_not_admitted",
          });
        }
        const turnId =
          result && typeof result === "object" && typeof result.turnId === "string"
            ? result.turnId
            : (open?.turnId ?? null);
        return json(res, 200, { ok: true, ...(turnId ? { turnId } : {}) });
      } catch (e) {
        const error = `interrupt rejected: ${String(e?.message ?? e).slice(0, 300)}`;
        return json(res, 400, { error, code: "interrupt_rejected" });
      }
    }

    // POST /sessions/:id/compact — manually compact the session's conversation context.
    const mCompact = path.match(/^\/sessions\/([^/]+)\/compact$/);
    if (req.method === "POST" && mCompact) {
      const entry = resolveEntry(decodeURIComponent(mCompact[1]));
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      if (!connection) return json(res, 503, { error: "pilot not connected", code: "pilot_down" });
      try {
        const result = await connection.command("session/compact", {
          commandId: uuidv7(),
          sessionId: entry.session.sessionId,
        });
        const status =
          result && typeof result === "object" && typeof result.status === "string"
            ? result.status
            : "accepted";
        const reason =
          result && typeof result === "object" && typeof result.reason === "string"
            ? result.reason
            : undefined;
        return json(res, 200, { ok: true, status, ...(reason ? { reason } : {}) });
      } catch (e) {
        const error = `compact rejected: ${String(e?.message ?? e).slice(0, 300)}`;
        return json(res, 400, { error, code: "compact_rejected" });
      }
    }

    if (req.method === "POST" && path === "/sessions") {
      const body = await readBody(req);
      const result = await createPilotSessionOnce(body);
      return json(res, result.code, result.body);
    }

    // A live, read-only file tab. Session ownership and its workspace root
    // come from the saved pilot entry; the client may supply only a path.
    const mFileRead = path.match(/^\/sessions\/([^/]+)\/files\/read$/);
    if (req.method === "POST" && mFileRead) {
      const entry = resolveEntry(decodeURIComponent(mFileRead[1]));
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const body = await readBody(req).catch(() => ({}));
      if (!entry.meta?.workspaceRoot) return json(res, 409, { error: "Companion working directory is unavailable." });
      const result = readWorkspaceFile(entry.meta.workspaceRoot, body.path);
      return json(res, result.ok ? 200 : result.code, result);
    }

    const mImageRead = path.match(/^\/sessions\/([^/]+)\/files\/read-image$/);
    if (req.method === "POST" && mImageRead) {
      const entry = resolveEntry(decodeURIComponent(mImageRead[1]));
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      const body = await readBody(req).catch(() => ({}));
      if (!entry.meta?.workspaceRoot) return json(res, 409, { error: "Companion working directory is unavailable." });
      const result = readWorkspaceImage(entry.meta.workspaceRoot, body.path);
      return json(res, result.ok ? 200 : result.code, result);
    }

    // Read a stored tool's full output on demand. The worker supplies an
    // item/ref pair from its own DB, never from a browser-provided ref.
    const mToolOutput = path.match(/^\/sessions\/([^/]+)\/tools\/output$/);
    if (req.method === "POST" && mToolOutput) {
      const entry = resolveEntry(decodeURIComponent(mToolOutput[1]));
      if (!entry) return json(res, 404, { error: "unknown session", code: "unknown_session" });
      if (!connection) return json(res, 503, { error: "pilot not connected" });
      const body = await readBody(req);
      if (typeof body.itemId !== "string" || typeof body.outputRef !== "string" ||
          !Number.isSafeInteger(body.offsetBytes) || body.offsetBytes < 0) {
        return json(res, 400, { error: "invalid tool output request" });
      }
      try {
        const page = await connection.request("item/readOutput", {
          sessionId: entry.session.sessionId, itemId: body.itemId, outputRef: body.outputRef,
          offsetBytes: body.offsetBytes, lengthBytes: 256 * 1024,
        });
        return json(res, 200, page);
      } catch (error) {
        return json(res, 502, { error: `item/readOutput failed: ${String(error).slice(0, 300)}` });
      }
    }

    const mTurn = path.match(/^\/sessions\/([^/]+)\/turns$/);
    if (req.method === "POST" && mTurn) {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: "text required", code: "bad_request" });
      if (!(await relayUp())) {
        return json(res, 503, {
          error: "credential relay unavailable; retry once it is back",
          code: "relay_down",
        });
      }
      // A turn for a backend id the serve host no longer knows must not be
      // a dead end: recover inline (reseed → rewire → admit) under the same
      // app-visible id, so the UI never grows a duplicate "continued" copy.
      let entry = resolveEntry(mTurn[1]);
      if (!entry) {
        const registry = loadRegistry();
        const meta = registry[mTurn[1]];
        if (meta) {
          unrecovered.add(mTurn[1]);
          log("turn for unknown backend session", mTurn[1], "— recovering inline");
          if (await recoverSession(mTurn[1], meta)) {
            unrecovered.delete(mTurn[1]);
            entry = resolveEntry(mTurn[1]);
          }
        }
      }
      if (!entry) {
        return json(res, 404, {
          error: "unknown session and automatic recovery failed; see the session transcript for details",
          code: "unknown_session",
        });
      }
      // First turn after a transcript recovery carries the compacted context
      // so the replacement backend session picks up where the old one left off.
      let text = annotateAgentMention(body.text, entry);
      if (pendingSeeds.has(entry.logId)) {
        text = `${pendingSeeds.get(entry.logId)}\n\n---\n\nNew user message:\n${text}`;
        pendingSeeds.delete(entry.logId);
      }
      const t0 = Date.now();
      let modelSwitched = false;
      // The SDK facade has no setModel; apply it through the SDK's own
      // Connection before admitting the turn. A failed switch fails the turn
      // rather than silently running the wrong model.
      if (body.modelId && body.modelId !== entry.meta.modelId) {
        if (!connection) return json(res, 503, { error: "pilot not connected" });
        try {
          await connection.command("session/setModel", {
            sessionId: entry.session.sessionId,
            model: { modelId: body.modelId },
          });
        } catch (e) {
          return json(res, 400, { error: `setModel failed: ${String(e).slice(0, 300)}` });
        }
        entry.meta.modelId = body.modelId;
        saveRegistry();
        modelSwitched = true;
        log("model switched:", entry.session.sessionId, "->", body.modelId);
      }
      const turn = await entry.session.sendUserTurn({
        input: buildTurnInputParts(text, body.attachments),
        ifBusy: body.ifBusy ?? "queue",
        reasoningEffort: normEffort(body.reasoningEffort),
      });
      const admitMs = Date.now() - t0;
      pumpTurn(entry.logId, turn);
      return json(res, 200, { turnId: turn.turnId, admitMs, modelSwitched, modelId: entry.meta.modelId });
    }

    // JSON poll endpoint for the worker (request/response actions can't hold SSE).
    // GET /sessions/:id/poll?since=N -> { events: [...], latestSeq }
    const mPoll = path.match(/^\/sessions\/([^/]+)\/poll$/);
    if (req.method === "GET" && mPoll) {
      const since = Number(url.searchParams.get("since") ?? 0);
      const entry = resolveEntry(mPoll[1]);
      if (entry) {
        const events = (eventLog.get(entry.logId) ?? []).filter((e) => e.seq > since);
        // Does this session have a turn the pilot is actively pumping?
        // The worker uses this to reconcile phantom "running" states when
        // the backend died and the turn_error broadcast was missed.
        let hasOpenTurn = false;
        for (const t of openTurns.values()) {
          if (t.logId === entry.logId) { hasOpenTurn = true; break; }
        }
        return json(res, 200, {
          events, latestSeq: eventSeq,
          sessionId: entry.logId, backendSessionId: entry.session.sessionId,
          hasOpenTurn,
        });
      }
      // No live backend session (failed recovery, mid-restart): still serve
      // the persisted transcript — including recovery_failed — so the app
      // can surface it instead of spinning on a dead watermark.
      if (existsSync(eventPath(mPoll[1]))) {
        const fileEvents = loadEventLog(mPoll[1]).filter((e) => e.seq > since);
        const latest = fileEvents.length
          ? fileEvents[fileEvents.length - 1].seq
          : since;
        return json(res, 200, {
          events: fileEvents, latestSeq: latest,
          sessionId: mPoll[1], backendSessionId: null,
          hasOpenTurn: false,
        });
      }
      return json(res, 404, { error: "unknown session", code: "unknown_session" });
    }

    const mEvents = path.match(/^\/sessions\/([^/]+)\/events$/);
    if (req.method === "GET" && mEvents) {
      const entry = resolveEntry(mEvents[1]);
      if (!entry) return json(res, 404, { error: "unknown session" });
      const sessionId = entry.logId;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      for (const ev of eventLog.get(sessionId) ?? []) {
        res.write(`data: ${safeJson(ev)}\n\n`);
      }
      let set = subscribers.get(sessionId);
      if (!set) { set = new Set(); subscribers.set(sessionId, set); }
      set.add(res);
      const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 25000);
      req.on("close", () => { clearInterval(hb); set.delete(res); });
      return;
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    log("http error:", String(e).slice(0, 200));
    return json(res, 500, { error: String(e).slice(0, 300) });
  }
});

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(sig, "received — closing serve host cleanly");
  terminals.closeAll();
  try {
    if (client) await client.close();
  } catch (e) {
    log("clean close failed:", String(e).slice(0, 160));
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  boot().catch((e) => { console.error("boot failed:", e); process.exit(1); });
}

// Exported for the node:test regression suite (pilot/recovery.test.mjs);
// the daemon path above is unaffected.
export const __test__ = {
  buildRecoverySeed,
  resolveEntry,
  wireSession,
  saveRegistry,
  loadRegistry,
  createPilotSessionOnce,
  defaultWorkspacePath,
  createWorkspacePath,
  loadAliases,
  loadEventLog,
  saveAliases,
  healthPayload,
  agentDirectory,
  agentPreamble,
  cleanSoul,
  soulBlock,
  annotateAgentMention,
  mcpTokens,
  mcpDeps,
  isReservedName,
  setAssistant,
  loadAssistant,
  getAssistant: () => assistant,
  findAgent,
  deliverAgentMessage,
  readMuseInbox,
  museServeEnv,
  withProxyFallback,
  githubSessionEnv,
  brokerUp,
  parseProxyAssignments,
  onHostNotification,
  followedTurns,
  deleteSession,
  renameBackendSession,
  pickDefaultModelId,
  defaultModelId,
  relayUp,
  waitForRelay,
  relayDisabledConfigWarning,
  RELAY_ENABLED,
  uuidv7,
  summarizeUserInput,
  pollUserInputs,
  pumpTurn,
  describeStuckItem,
  isCancelledOutcome,
  turnReadiness,
  openTurns,
  aliases,
  sessions,
  pendingSeeds,
  eventLog,
  unrecovered,
  surfacedInputs,
};

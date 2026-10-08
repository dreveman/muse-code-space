// Terminals for the Code Sessions UI: any number of login shells per app
// session (the UI's terminal tabs), run on a PTY by pty_bridge.py in the
// session's working directory on this host
// (the machine where muse serve runs). The app talks to it over plain HTTP
// through its actions (no WebSocket path exists from the browser to here):
// input is POSTed, output is read by byte offset with a long-poll.
//
// Shared by pilot.mjs and dev/fake-pilot.ts, so the fake pilot gets real
// terminals too.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "pty_bridge.py");
const MAX_BUFFER_BYTES = 1024 * 1024; // replay window for (re)attaching clients
const MAX_READ_BYTES = 64 * 1024; // per output response
// Opt-in: kill shells nobody has read for this long (0 = never, the
// default). Not needed for correctness: there's at most one shell per app
// session (reopening reattaches), deleting a session kills its shell, and a
// pilot restart kills them all.
const IDLE_REAP_MS = Number(process.env.MUSE_CODE_SPACE_TERMINAL_IDLE_MS ?? 0);

// The shell gets only these variables — nothing leaks from wherever the
// pilot happens to run (TERM_PROGRAM=iTerm.app, the pilot's own config,
// service-manager vars, ...). A login shell (-l) then sets up PATH and the
// rest from the user's profile, as in any new terminal window.
const BASE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
// Real locale categories only. Not every LC_* is a locale: iTerm2 exports
// LC_TERMINAL / LC_TERMINAL_VERSION (so ssh's `SendEnv LC_*` forwards them),
// and shell configs use LC_TERMINAL=iTerm2 to detect a real iTerm.
const LOCALE_VARS = new Set(["LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME"]);

/** @param {NodeJS.ProcessEnv} [source] the pilot's environment (only a few values are carried over) */
export function terminalEnv(source = process.env) {
  let user = { username: source.USER ?? "", homedir: source.HOME ?? "/", shell: null };
  try { user = userInfo(); } catch { /* no passwd entry: keep the env values */ }
  const env = {
    HOME: user.homedir || source.HOME || "/",
    USER: user.username || source.USER || "",
    LOGNAME: user.username || source.LOGNAME || source.USER || "",
    SHELL: source.MUSE_CODE_SPACE_TERMINAL_SHELL || user.shell || "/bin/bash",
    PATH: BASE_PATH,
    LANG: source.LANG || "en_US.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "wterm",
  };
  // Carried over only when set: locale categories, and macOS's per-user temp dir.
  for (const [key, value] of Object.entries(source)) {
    if (value && (LOCALE_VARS.has(key) || key === "TMPDIR")) env[key] = value;
  }
  // Explicit extras: MUSE_CODE_SPACE_TERMINAL_ENV="KEY=value;OTHER=value"
  for (const pair of (source.MUSE_CODE_SPACE_TERMINAL_ENV ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) env[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return env;
}

/**
 * @typedef {{ id: string, key: string, cwd: string, proc: import("node:child_process").ChildProcess,
 *   chunks: Buffer[], start: number, end: number, exited: boolean, exitCode: number | null,
 *   waiters: Set<() => void>, lastSeenAt: number, cols: number, rows: number, number: number, createdAt: number }} Terminal
 */

export function createTerminalManager({ log = () => {}, python = process.env.MUSE_CODE_SPACE_PYTHON ?? "python3" } = {}) {
  /** @type {Map<string, Terminal>} */
  const terminals = new Map();
  const byKey = new Map(); // app session id -> Set<terminal id>
  const counters = new Map(); // app session id -> last terminal number ("Terminal N")

  const wake = (t) => {
    for (const resolve of t.waiters) resolve();
    t.waiters.clear();
  };

  /**
   * A new shell for `key` (an app session), or — with `terminalId` — reattach
   * to one of its existing shells (a tab coming back into view).
   */
  function open({ key, cwd, cols = 80, rows = 24, terminalId = null }) {
    if (terminalId) {
      const existing = terminals.get(terminalId);
      if (!existing || existing.key !== key) throw Object.assign(new Error("unknown terminal"), { code: "unknown_terminal" });
      existing.lastSeenAt = Date.now();
      return { terminalId: existing.id, reattached: true, cwd: existing.cwd, number: existing.number, exited: existing.exited };
    }
    if (!cwd || !cwd.startsWith("/")) throw Object.assign(new Error("cwd must be an absolute path"), { code: "bad_request" });
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    const id = crypto.randomUUID();
    const proc = spawn(python, [BRIDGE, cwd, String(cols), String(rows)], {
      cwd,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: terminalEnv(),
    });
    /** @type {Terminal} */
    const number = (counters.get(key) ?? 0) + 1;
    counters.set(key, number);
    const t = {
      id, key, cwd, proc, chunks: [], start: 0, end: 0, exited: false, exitCode: null,
      waiters: new Set(), lastSeenAt: Date.now(), cols, rows, number, createdAt: Date.now(),
    };
    proc.stdout.on("data", (chunk) => {
      t.chunks.push(chunk);
      t.end += chunk.length;
      let size = t.end - t.start;
      while (size > MAX_BUFFER_BYTES && t.chunks.length > 1) {
        const dropped = t.chunks.shift();
        t.start += dropped.length;
        size -= dropped.length;
      }
      wake(t);
    });
    proc.stderr.on("data", (chunk) => log("terminal stderr:", chunk.toString().trim().slice(0, 200)));
    proc.on("exit", (code, signal) => {
      t.exited = true;
      t.exitCode = code ?? (signal ? 128 : null);
      log("terminal exited", id, code ?? signal);
      wake(t);
    });
    proc.on("error", (error) => {
      t.exited = true;
      log("terminal failed to start:", String(error));
      wake(t);
    });
    terminals.set(id, t);
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(id);
    log("terminal opened", id, `(#${number})`, "for", key, "in", cwd);
    return { terminalId: id, reattached: false, cwd, number, exited: false };
  }

  /** The shells of an app session, oldest first (exited ones stay until closed). */
  function list(key) {
    return [...(byKey.get(key) ?? [])]
      .map((id) => terminals.get(id))
      .filter(Boolean)
      .sort((a, b) => a.number - b.number)
      .map((t) => ({ terminalId: t.id, number: t.number, exited: t.exited, exitCode: t.exitCode, cwd: t.cwd }));
  }

  function get(id) {
    const t = terminals.get(id);
    if (!t) throw Object.assign(new Error("unknown terminal"), { code: "unknown_terminal" });
    return t;
  }

  function input(id, data) {
    const t = get(id);
    if (t.exited) throw Object.assign(new Error("terminal has exited"), { code: "terminal_exited" });
    t.lastSeenAt = Date.now();
    t.proc.stdin.write(data);
  }

  function resize(id, cols, rows) {
    const t = get(id);
    if (t.exited) return;
    t.cols = cols;
    t.rows = rows;
    t.proc.stdio[3]?.write(`${JSON.stringify({ cols, rows })}\n`);
  }

  /** Bytes from `since` (an absolute offset), waiting up to waitMs for new output. */
  async function read(id, since, waitMs = 0) {
    const t = get(id);
    t.lastSeenAt = Date.now();
    if (since >= t.end && !t.exited && waitMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          t.waiters.delete(done);
          resolve();
        }, Math.min(waitMs, 25_000));
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        t.waiters.add(done);
      });
    }
    const from = Math.max(since, t.start);
    const all = Buffer.concat(t.chunks);
    const slice = all.subarray(from - t.start, Math.min(all.length, from - t.start + MAX_READ_BYTES));
    return {
      data: slice.toString("base64"),
      next: from + slice.length,
      truncated: since < t.start, // the client missed bytes that fell out of the window
      exited: t.exited && from + slice.length >= t.end,
      exitCode: t.exitCode,
    };
  }

  function remove(id) {
    const t = terminals.get(id);
    if (!t) return false;
    if (!t.exited) {
      try { t.proc.stdin.end(); } catch { /* already closed */ }
      try { t.proc.kill("SIGHUP"); } catch { /* already gone */ }
    }
    wake(t);
    terminals.delete(id);
    const ids = byKey.get(t.key);
    ids?.delete(id);
    if (ids && ids.size === 0) {
      byKey.delete(t.key);
      counters.delete(t.key); // no shells left: the next one is "Terminal 1" again
    }
    return true;
  }

  if (IDLE_REAP_MS > 0) {
    const reaper = setInterval(() => {
      const cutoff = Date.now() - IDLE_REAP_MS;
      for (const t of terminals.values()) {
        if (t.lastSeenAt < cutoff) {
          log("reaping idle terminal", t.id);
          remove(t.id);
        }
      }
    }, Math.min(60_000, IDLE_REAP_MS));
    if (typeof reaper.unref === "function") reaper.unref();
  }

  /** Kill all shells of an app session (it was archived or deleted). */
  function removeByKey(key) {
    const ids = [...(byKey.get(key) ?? [])];
    for (const id of ids) remove(id);
    counters.delete(key);
    return ids.length > 0;
  }

  function closeAll() {
    for (const id of [...terminals.keys()]) remove(id);
  }

  return { open, list, input, resize, read, remove, removeByKey, closeAll, size: () => terminals.size };
}

/**
 * Handle /terminals routes; returns true when it handled the request.
 * `send(status, body)` writes JSON; `body` is the parsed JSON request body.
 */
export async function handleTerminalRoute(manager, method, path, url, body, send) {
  if (path === "/terminals" && method === "POST") {
    const cols = Number(body.cols) || 80;
    const rows = Number(body.rows) || 24;
    const terminalId = typeof body.terminalId === "string" && body.terminalId ? body.terminalId : null;
    send(200, manager.open({ key: String(body.key ?? ""), cwd: String(body.cwd ?? ""), cols, rows, terminalId }));
    return true;
  }
  // GET /terminals?key=<app session id> -> { terminals: [{ terminalId, number, exited, exitCode, cwd }] }
  if (path === "/terminals" && method === "GET") {
    send(200, { terminals: manager.list(String(url.searchParams.get("key") ?? "")) });
    return true;
  }
  // DELETE /terminals/by-key/:key — kill an app session's shell, if any.
  const byKeyMatch = path.match(/^\/terminals\/by-key\/([^/]+)$/);
  if (byKeyMatch && method === "DELETE") {
    send(200, { ok: true, existed: manager.removeByKey(decodeURIComponent(byKeyMatch[1])) });
    return true;
  }
  const m = path.match(/^\/terminals\/([^/]+)(\/[a-z]+)?$/);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  const sub = m[2] ?? "";
  if (sub === "/input" && method === "POST") {
    manager.input(id, typeof body.data === "string" ? body.data : "");
    send(200, { ok: true });
    return true;
  }
  if (sub === "/resize" && method === "POST") {
    manager.resize(id, Math.max(1, Number(body.cols) || 80), Math.max(1, Number(body.rows) || 24));
    send(200, { ok: true });
    return true;
  }
  if (sub === "/output" && method === "GET") {
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    const waitMs = Math.max(0, Number(url.searchParams.get("waitMs")) || 0);
    send(200, await manager.read(id, since, waitMs));
    return true;
  }
  if (sub === "" && method === "DELETE") {
    send(200, { ok: true, existed: manager.remove(id) });
    return true;
  }
  return false;
}

/** Map manager errors to HTTP statuses. */
export function terminalErrorStatus(error) {
  const code = error?.code;
  if (code === "unknown_terminal") return 404;
  if (code === "terminal_exited") return 409;
  if (code === "bad_request") return 400;
  return 500;
}

// Tests for the UI terminals (pilot/terminals.mjs + pty_bridge.py).
// Run: node --test pilot/terminals.test.mjs   (needs python3)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTerminalManager, handleTerminalRoute, terminalEnv, terminalErrorStatus } from "./terminals.mjs";

// A plain, fast shell: login shells with heavy prompt setup make output timing noisy.
process.env.MUSE_CODE_SPACE_TERMINAL_SHELL = "/bin/sh";
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");

async function readUntil(m, id, since, pattern, timeoutMs = 8000) {
  let out = "";
  let next = since;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await m.read(id, next, 500);
    next = r.next;
    out += Buffer.from(r.data, "base64").toString();
    if (pattern.test(strip(out)) || r.exited) return { out: strip(out), next, exited: r.exited, exitCode: r.exitCode };
  }
  return { out: strip(out), next, exited: false, exitCode: null };
}

test("a terminal runs in its cwd, follows resizes, and reports its exit", async () => {
  const m = createTerminalManager();
  const cwd = path.join(mkdtempSync(path.join(os.tmpdir(), "term-test-")), "work dir");
  const { terminalId, reattached } = m.open({ key: "session-1", cwd, cols: 100, rows: 30 });
  assert.equal(reattached, false);
  m.input(terminalId, "pwd; stty size; echo DONE-$((40+2))\r");
  let r = await readUntil(m, terminalId, 0, /DONE-42/);
  assert.ok(r.out.includes("work dir"), "starts in the (created) cwd");
  assert.ok(r.out.includes("30 100"), "initial size");

  m.resize(terminalId, 120, 40);
  await new Promise((resolve) => setTimeout(resolve, 150));
  m.input(terminalId, "stty size\r");
  r = await readUntil(m, terminalId, r.next, /40 120/);
  assert.ok(r.out.includes("40 120"), "resize reaches the shell");

  assert.equal(m.open({ key: "session-1", cwd: "/elsewhere", terminalId }).terminalId, terminalId, "reattach by id");
  assert.throws(() => m.open({ key: "other-session", cwd, terminalId }), (e) => terminalErrorStatus(e) === 404, "another session can't attach to it");
  const replay = await m.read(terminalId, 0, 0);
  assert.ok(strip(Buffer.from(replay.data, "base64").toString()).includes("DONE-42"), "a reattached view can replay from 0");

  m.input(terminalId, "exit 3\r");
  r = await readUntil(m, terminalId, r.next, /$^/);
  assert.equal(r.exited, true);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(m.list("session-1").map((t) => [t.terminalId, t.exited, t.exitCode]), [[terminalId, true, 3]], "an exited shell stays listed until its tab is closed");
  m.closeAll();
});

test("unknown terminals map to 404, exited input to 409", async () => {
  const m = createTerminalManager();
  assert.throws(() => m.input("nope", "x"), (e) => terminalErrorStatus(e) === 404);
  const sent = [];
  const handled = await handleTerminalRoute(m, "GET", "/terminals/nope/output", new URL("http://x/terminals/nope/output"), {}, (c, b) => sent.push([c, b]))
    .catch((e) => terminalErrorStatus(e));
  assert.equal(handled, 404);
  assert.equal(await handleTerminalRoute(m, "GET", "/sessions", new URL("http://x/sessions"), {}, () => {}), false, "other routes pass through");
});

test("open requires an absolute cwd", () => {
  const m = createTerminalManager();
  assert.throws(() => m.open({ key: "k", cwd: "relative/path" }), (e) => terminalErrorStatus(e) === 400);
});

test("the shell's environment is an allowlist, not the pilot's", async () => {
  const env = terminalEnv({
    HOME: "/home/x", USER: "x", PATH: "/opt/pilot/bin:/usr/bin", LANG: "sv_SE.UTF-8", LC_ALL: "sv_SE.UTF-8",
    TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0", XDG_CONFIG_HOME: "/home/x/.config/muse-code-space-pilot",
    MUSE_CODE_SPACE_RELAY_URL: "none", SECRET_TOKEN: "s3cret", MUSE_CODE_SPACE_TERMINAL_SHELL: "/bin/sh",
    MUSE_CODE_SPACE_TERMINAL_ENV: "EDITOR=vim;FOO=a=b",
    LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7.3", LC_CTYPE: "UTF-8",
  });
  assert.equal(env.TERM_PROGRAM, "wterm");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.SHELL, "/bin/sh");
  assert.equal(env.LANG, "sv_SE.UTF-8");
  assert.equal(env.LC_ALL, "sv_SE.UTF-8");
  assert.ok(!env.PATH.includes("/opt/pilot"), "PATH is rebuilt by the login shell, not inherited");
  assert.equal(env.LC_CTYPE, "UTF-8", "real locale categories pass");
  for (const leaked of ["ITERM_SESSION_ID", "LC_TERMINAL", "LC_TERMINAL_VERSION", "XDG_CONFIG_HOME", "MUSE_CODE_SPACE_RELAY_URL", "SECRET_TOKEN"]) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the shell`);
  }
  assert.equal(env.EDITOR, "vim", "explicit extras via MUSE_CODE_SPACE_TERMINAL_ENV");
  assert.equal(env.FOO, "a=b");

  // And end to end: the running shell sees exactly that.
  const before = { TERM_PROGRAM: process.env.TERM_PROGRAM, LEAKY: process.env.LEAKY, LC_TERMINAL: process.env.LC_TERMINAL };
  process.env.TERM_PROGRAM = "iTerm.app";
  process.env.LEAKY = "1";
  process.env.LC_TERMINAL = "iTerm2";
  const m = createTerminalManager();
  try {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "term-env-"));
    const { terminalId } = m.open({ key: "env", cwd });
    m.input(terminalId, 'echo "TP=$TERM_PROGRAM LEAKY=${LEAKY:-unset} LCT=${LC_TERMINAL:-unset} T=$TERM"\r');
    // Match the printed line, not the echoed command (which still has the $s).
    const r = await readUntil(m, terminalId, 0, /TP=[^$\s]+ LEAKY=[^$\s]+ LCT=[^$\s]+ T=[^$\s"]+/);
    assert.match(r.out, /TP=wterm LEAKY=unset LCT=unset T=xterm-256color/);
  } finally {
    m.closeAll();
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("proxy vars reach the shell so git/curl need no manual setup", () => {
  const env = terminalEnv({
    HOME: "/home/x", USER: "x",
    http_proxy: "http://proxy:3128", https_proxy: "http://proxy:3128",
    HTTP_PROXY: "http://proxy:3128", HTTPS_PROXY: "http://proxy:3128",
    all_proxy: "http://proxy:3128", ALL_PROXY: "http://proxy:3128",
    no_proxy: "localhost,127.0.0.1", NO_PROXY: "localhost,127.0.0.1",
    SECRET_TOKEN: "s3cret",
  });
  assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(env.https_proxy, "http://proxy:3128");
  assert.equal(env.HTTP_PROXY, "http://proxy:3128");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(env.SECRET_TOKEN, undefined, "non-network secrets still stay out");
});

test("no idle reaping by default; a session's shell can be killed by its key", async () => {
  const m = createTerminalManager();
  const cwd = mkdtempSync(path.join(os.tmpdir(), "term-key-"));
  const { terminalId } = m.open({ key: "app-session-9", cwd });
  try {
    assert.equal(m.size(), 1);
    assert.equal(m.removeByKey("app-session-9"), true);
    assert.equal(m.size(), 0);
    assert.throws(() => m.input(terminalId, "x"), (e) => terminalErrorStatus(e) === 404);
    assert.equal(m.removeByKey("app-session-9"), false, "idempotent");
    const sent = [];
    assert.equal(await handleTerminalRoute(m, "DELETE", "/terminals/by-key/nope", new URL("http://x/terminals/by-key/nope"), {}, (c, b) => sent.push([c, b])), true);
    assert.deepEqual(sent, [[200, { ok: true, existed: false }]]);
  } finally {
    m.closeAll();
  }
});

test("any number of shells per session, numbered, listed, and all killed by key", () => {
  const m = createTerminalManager();
  const cwd = mkdtempSync(path.join(os.tmpdir(), "term-multi-"));
  try {
    const a = m.open({ key: "s", cwd });
    const b = m.open({ key: "s", cwd });
    const other = m.open({ key: "t", cwd });
    assert.notEqual(a.terminalId, b.terminalId, "every open is a new shell");
    assert.deepEqual([a.number, b.number, other.number], [1, 2, 1], "numbered per session");
    assert.deepEqual(m.list("s").map((t) => t.number), [1, 2]);
    m.remove(a.terminalId);
    assert.deepEqual(m.list("s").map((t) => t.number), [2], "closing one tab leaves the others");
    assert.equal(m.open({ key: "s", cwd }).number, 3, "numbers aren't reused while the session has shells");
    assert.equal(m.removeByKey("s"), true);
    assert.deepEqual(m.list("s"), []);
    assert.equal(m.open({ key: "s", cwd }).number, 1, "with no shells left, numbering starts over");
    assert.equal(m.list("t").length, 1, "other sessions untouched");
  } finally {
    m.closeAll();
  }
});

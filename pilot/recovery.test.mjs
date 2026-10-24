// Regression tests for pilot transcript recovery (docs/PILOT.md).
// Run: node --test pilot/recovery.test.mjs
// (pilot/node_modules must resolve @muse-code/sdk — install.sh links it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate ALL pilot disk state before the module evaluates (it reads HOME
// at import time and mkdirs its state dir).
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "pilot-recovery-test-"));

const { __test__: t } = await import("./pilot.mjs");
const stateDir = path.join(process.env.HOME, "workspace", "muse-code-space-pilot", "state");

const row = (item) => JSON.stringify({ seq: 1, type: "item", item });

test("full tool output is fetched through item/readOutput only on request", () => {
  const source = readFileSync(new URL("./pilot.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('path.match(/^\\/sessions\\/([^/]+)\\/tools\\/output$/)'), "there is a dedicated on-demand route");
  assert.ok(source.includes('connection.request("item/readOutput", {'));
  assert.ok(source.includes('sessionId: entry.session.sessionId, itemId: body.itemId, outputRef: body.outputRef'));
  assert.ok(source.includes('lengthBytes: 256 * 1024'));
});

test("buildRecoverySeed returns null with no transcript file", () => {
  assert.equal(t.buildRecoverySeed("missing-session"), null);
});

test("buildRecoverySeed compacts prompt + recent progress, skips noise", () => {
  const lines = [
    row({ kind: "userMessage", status: "completed", text: "Refactor the parser" }),
    row({ kind: "agentMessage", status: "completed", text: "old progress" }),
    row({ kind: "toolCall", status: "completed", tool: "bash", args: "{}" }),
    row({ kind: "agentMessage", status: "inProgress", text: "half-written noise" }),
    row({ kind: "agentMessage", status: "completed", text: "latest progress" }),
    "not-json{{{",
  ];
  writeFileSync(path.join(stateDir, "events-seed1.jsonl"), lines.join("\n"));
  const seed = t.buildRecoverySeed("seed1");
  assert.ok(seed.includes("Refactor the parser"));
  assert.ok(seed.includes("latest progress"));
  assert.ok(!seed.includes("half-written noise"));
});

test("buildRecoverySeed caps length", () => {
  writeFileSync(
    path.join(stateDir, "events-big.jsonl"),
    row({ kind: "agentMessage", status: "completed", text: "x".repeat(9000) }),
  );
  const seed = t.buildRecoverySeed("big");
  assert.ok(seed.length <= 4000);
});

test("stable id resolves through alias; registry keys by stable id", () => {
  const fake = { sessionId: "backend-9", onApproval() {} };
  t.wireSession(fake, { title: "t", modelId: "m" }, "orig-9");
  assert.equal(t.resolveEntry("orig-9")?.logId, "orig-9");
  assert.equal(t.resolveEntry("backend-9")?.logId, "orig-9");
  t.aliases.set("orig-9", "backend-9");
  t.saveAliases();
  const saved = JSON.parse(readFileSync(path.join(stateDir, "aliases.json"), "utf8"));
  assert.equal(saved["orig-9"], "backend-9");
  const registry = JSON.parse(readFileSync(path.join(stateDir, "sessions.json"), "utf8"));
  assert.ok(registry["orig-9"], "registry must be keyed by stable id");
  assert.ok(!registry["backend-9"], "backend id must not leak into registry keys");
});

test("resolveEntry returns undefined for unknown ids", () => {
  assert.equal(t.resolveEntry("nope"), undefined);
});

test("health reports ok only when relay is up and nothing is unrecovered", () => {
  // relayUpSyncCache starts unknown in this process: report sessions without
  // claiming a relay state the pilot never probed.
  const base = t.healthPayload();
  assert.equal(base.ok, true);
  assert.equal(base.unrecovered.length, 0);
  assert.ok(base.sessions >= 1, "wired sessions count toward health");

  t.unrecovered.add("stuck-session");
  const bad = t.healthPayload();
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unrecovered, ["stuck-session"]);
  t.unrecovered.delete("stuck-session");
  assert.equal(t.healthPayload().ok, true);
});

test("uuidv7 produces v7-shaped idempotency handles", () => {
  const id = t.uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, t.uuidv7());
});

test("summarizeUserInput caps the persisted payload", () => {
  const out = t.summarizeUserInput({
    userInputId: "u1",
    turnId: "t1",
    questions: [{
      id: "q",
      header: "h",
      question: "x".repeat(3000),
      selection: { mode: "single" },
      options: [{ label: "y".repeat(600), description: "d" }],
    }],
  });
  assert.equal(out.userInputId, "u1");
  assert.ok(out.questions[0].question.length <= 2000);
  assert.ok(out.questions[0].options[0].label.length <= 500);
});

test("pollUserInputs surfaces pending prompts once, then settles them", () => {
  let pending = [{
    userInputId: "u-test-1",
    turnId: "t1",
    questions: [{
      id: "q1", header: "Pick", question: "Which?",
      selection: { mode: "single" }, options: [{ label: "A" }],
    }],
  }];
  const fake = {
    sessionId: "backend-ui-1",
    onApproval() {},
    fold: { pendingUserInputs: () => pending },
  };
  t.wireSession(fake, { title: "ui" }, "orig-ui-1");
  t.surfacedInputs.clear();
  t.pollUserInputs();
  assert.ok(t.surfacedInputs.has("u-test-1"));
  const requested = () =>
    (t.eventLog.get("orig-ui-1") ?? []).filter((e) => e.type === "user_input_requested");
  assert.equal(requested().length, 1);
  assert.equal(requested()[0].userInputId, "u-test-1");
  assert.equal(requested()[0].questions[0].id, "q1");
  // Second poll: no duplicate marker.
  t.pollUserInputs();
  assert.equal(requested().length, 1);
  // Disappearance broadcasts settled and clears tracking.
  pending = [];
  t.pollUserInputs();
  assert.ok(!t.surfacedInputs.has("u-test-1"));
  assert.equal(
    (t.eventLog.get("orig-ui-1") ?? []).filter((e) => e.type === "user_input_settled").length,
    1,
  );
});

test("pumpTurn fails a wedged turn visibly and names the stuck child", async () => {
  process.env.MUSE_CODE_SPACE_TURN_IDLE_TIMEOUT_MS = "60";
  process.env.MUSE_CODE_SPACE_TURN_TOOL_TIMEOUT_MS = "60";
  try {
    const hanging = (async function* () {
      yield { kind: "toolCall", status: "inProgress", tool: "skill-reminder", args: "{}" };
      await new Promise(() => {});
    })();
    const fakeTurn = {
      turnId: "t-wedge-1",
      items: () => hanging,
      completed: new Promise(() => {}),
    };
    await t.pumpTurn("sess-wedge-1", fakeTurn);
    const errors = (t.eventLog.get("sess-wedge-1") ?? []).filter((e) => e.type === "turn_error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].error.includes("Turn stalled"));
    assert.ok(errors[0].error.includes("skill-reminder"));
    assert.ok(!t.openTurns.has("t-wedge-1"));
  } finally {
    delete process.env.MUSE_CODE_SPACE_TURN_IDLE_TIMEOUT_MS;
    delete process.env.MUSE_CODE_SPACE_TURN_TOOL_TIMEOUT_MS;
  }
});

test("pumpTurn delivers a healthy turn without interference", async () => {
  const gen = (async function* () {
    yield { kind: "agentMessage", status: "completed", text: "done" };
  })();
  const fakeTurn = {
    turnId: "t-healthy-1",
    items: () => gen,
    completed: Promise.resolve({ status: "completed" }),
  };
  await t.pumpTurn("sess-healthy-1", fakeTurn);
  const events = t.eventLog.get("sess-healthy-1") ?? [];
  assert.ok(events.some((e) => e.type === "item"));
  assert.ok(events.some((e) => e.type === "turn_completed"));
  assert.ok(!events.some((e) => e.type === "turn_error"));
  assert.ok(!t.openTurns.has("t-healthy-1"));
});

test("a late settle after idle release stays quiet", async () => {
  process.env.MUSE_CODE_SPACE_TURN_IDLE_TIMEOUT_MS = "60";
  process.env.MUSE_CODE_SPACE_TURN_TOOL_TIMEOUT_MS = "60";
  try {
    let resolveCompleted;
    const hanging = (async function* () {
      yield { kind: "agentMessage", status: "inProgress", text: "half-written" };
      await new Promise(() => {});
    })();
    const fakeTurn = {
      turnId: "t-late-1",
      items: () => hanging,
      completed: new Promise((resolve) => { resolveCompleted = resolve; }),
    };
    await t.pumpTurn("sess-late-1", fakeTurn);
    // The wedge already failed visibly; the late success must not revive it.
    resolveCompleted({ status: "completed" });
    await new Promise((r) => setTimeout(r, 20));
    const events = t.eventLog.get("sess-late-1") ?? [];
    assert.equal(events.filter((e) => e.type === "turn_error").length, 1);
    assert.equal(events.filter((e) => e.type === "turn_completed").length, 0);
  } finally {
    delete process.env.MUSE_CODE_SPACE_TURN_IDLE_TIMEOUT_MS;
    delete process.env.MUSE_CODE_SPACE_TURN_TOOL_TIMEOUT_MS;
  }
});

test("health reports stuck turns as unhealthy", () => {
  const now = Date.now();
  t.openTurns.set("t-stuck-9", {
    logId: "sess-stuck-9", turnId: "t-stuck-9",
    startedAt: now - 10 * 60 * 1000, lastItemAt: now - 6 * 60 * 1000,
    items: 3, inProgress: [],
  });
  try {
    const payload = t.healthPayload();
    assert.equal(payload.turns.open, 1);
    assert.ok(payload.turns.maxIdleMs >= 6 * 60 * 1000);
    assert.deepEqual(payload.turns.stuck, ["t-stuck-9"]);
    assert.equal(payload.ok, false);
  } finally {
    t.openTurns.delete("t-stuck-9");
  }
  assert.equal(t.healthPayload().ok, true);
});

test("describeStuckItem names tool and kind", () => {
  assert.ok(t.describeStuckItem({ kind: "toolCall", tool: "bash", args: "{}" }).includes("bash"));
  assert.equal(t.describeStuckItem(null), "unknown item");
});

test("isCancelledOutcome spots SDK and legacy cancelled terminals", () => {
  assert.equal(t.isCancelledOutcome({ kind: "completed", params: { terminal: "cancelled", turnId: "t" } }), true);
  assert.equal(t.isCancelledOutcome({ status: "canceled" }), true);
  assert.equal(t.isCancelledOutcome({ kind: "completed", params: { terminal: "completed" } }), false);
  assert.equal(t.isCancelledOutcome(null), false);
});

test("pumpTurn flags a cancelled completion so the worker files it stopped", async () => {
  const fakeTurn = (outcome) => ({
    turnId: "turn-cancel-1",
    async *items() {},
    completed: Promise.resolve(outcome),
  });
  await t.pumpTurn("cancel-flag", fakeTurn({ kind: "completed", params: { terminal: "cancelled", turnId: "turn-cancel-1" } }));
  const rows = t.loadEventLog("cancel-flag");
  const done = rows.find((event) => event.type === "turn_completed");
  assert.ok(done);
  assert.equal(done.cancelled, true);
});

test("pumpTurn leaves ordinary completions unflagged", async () => {
  const fakeTurn = {
    turnId: "turn-ok-1",
    async *items() {},
    completed: Promise.resolve({ kind: "completed", params: { terminal: "completed", turnId: "turn-ok-1" } }),
  };
  await t.pumpTurn("cancel-flag-clean", fakeTurn);
  const rows = t.loadEventLog("cancel-flag-clean");
  const done = rows.find((event) => event.type === "turn_completed");
  assert.ok(done);
  assert.equal("cancelled" in done, false);
});

test("loadEventLog serves the persisted transcript for poll fallback", () => {
  const lines = [
    row({ kind: "agentMessage", status: "completed", text: "hello" }),
    JSON.stringify({ seq: 41, type: "recovery_failed", error: "boom" }),
  ];
  writeFileSync(path.join(stateDir, "events-fileback.jsonl"), lines.join("\n"));
  const events = t.loadEventLog("fileback");
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "recovery_failed");
  // The persisted recovery failure is what the poll fallback serves when no
  // backend session exists, so it must survive the round trip.
  assert.ok(events[1].seq > 0);
});

// ---- MUSE_CODE_SPACE_RELAY_URL=none (hosts with direct model access) ----

test("relay checks stay on by default", () => {
  assert.equal(t.RELAY_ENABLED, true);
  assert.equal(t.relayDisabledConfigWarning(), null, "no warning while the relay is in use");
});

test("MUSE_CODE_SPACE_RELAY_URL=none disables every relay check", async () => {
  const saved = process.env.MUSE_CODE_SPACE_RELAY_URL;
  process.env.MUSE_CODE_SPACE_RELAY_URL = " None ";
  // A query string gives a fresh module instance that reads the new env.
  const { __test__: off } = await import("./pilot.mjs?relay=none");
  if (saved === undefined) delete process.env.MUSE_CODE_SPACE_RELAY_URL;
  else process.env.MUSE_CODE_SPACE_RELAY_URL = saved;

  assert.equal(off.RELAY_ENABLED, false);
  assert.equal(await off.relayUp(), true, "turn admission must not wait on a relay that is not there");
  const started = Date.now();
  assert.equal(await off.waitForRelay(), true);
  assert.ok(Date.now() - started < 1000, "boot must not sit in the 30s relay wait");
  const health = off.healthPayload();
  assert.equal(health.relay, "disabled");
  assert.equal(health.ok, true);

  // Warn when muse's pilot config still routes model calls through the relay.
  const dir = mkdtempSync(path.join(os.tmpdir(), "pilot-relay-settings-"));
  const settings = path.join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ endpoint_transport: { base_url: "http://127.0.0.1:18790", auth: "bearer" } }));
  assert.match(off.relayDisabledConfigWarning(settings), /127\.0\.0\.1:18790/);
  writeFileSync(settings, JSON.stringify({ schema_version: 1 }));
  assert.equal(off.relayDisabledConfigWarning(settings), null);
  writeFileSync(settings, JSON.stringify({ endpoint_transport: { base_url: "https://api.example.com" } }));
  assert.equal(off.relayDisabledConfigWarning(settings), null, "a real remote endpoint is not the relay");
  assert.equal(off.relayDisabledConfigWarning(path.join(dir, "missing.json")), null);
});

// ---- default model (catalogs differ per host) ----

test("pickDefaultModelId prefers the catalog default, then the first model", () => {
  assert.equal(t.pickDefaultModelId({ models: [{ modelId: "a" }, { modelId: "b", isDefault: true }] }), "b");
  assert.equal(t.pickDefaultModelId({ models: [{ modelId: "demo-orbit-2.4-preview" }] }), "demo-orbit-2.4-preview");
  assert.equal(t.pickDefaultModelId({ models: [] }), null);
  assert.equal(t.pickDefaultModelId(null), null);
});

test("defaultModelId asks model/list, caches it, and falls back when the catalog is unreadable", async () => {
  assert.equal(await t.defaultModelId(async () => { throw new Error("not connected"); }), "muse-spark-1.3");
  assert.equal(await t.defaultModelId(async () => ({ models: [] })), "muse-spark-1.3");
  let calls = 0;
  const catalog = async (method) => {
    calls += 1;
    assert.equal(method, "model/list");
    return { models: [{ modelId: "demo-orbit-2.4-preview", isDefault: true }] };
  };
  assert.equal(await t.defaultModelId(catalog), "demo-orbit-2.4-preview");
  assert.equal(await t.defaultModelId(catalog), "demo-orbit-2.4-preview");
  assert.equal(calls, 1, "the default is cached");
});

test("health reports the pilot's home folder", () => {
  assert.equal(t.healthPayload().home, process.env.HOME);
});

// ---- DELETE /sessions/:id ----

test("deleteSession forgets the session, its transcript, and its working directory, keeps others", () => {
  const registryPath = path.join(stateDir, "sessions.json");
  const wsDir = t.defaultWorkspacePath("del-1");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(path.join(wsDir, "file.txt"), "hello\n");
  const other = { title: "keep me", modelId: "m" };
  t.wireSession({ sessionId: "backend-del-1", onApproval() {} }, { title: "bye", modelId: "m", workspaceRoot: wsDir }, "del-1");
  // Written after wireSession (which rewrites the registry from memory): an
  // unloaded entry like keep-1 must survive the delete.
  const onDisk = JSON.parse(readFileSync(registryPath, "utf8"));
  writeFileSync(registryPath, JSON.stringify({ ...onDisk, "keep-1": other }));
  writeFileSync(path.join(stateDir, "events-del-1.jsonl"), row({ kind: "userMessage", status: "completed", text: "hi" }) + "\n");
  t.aliases.set("del-1", "backend-del-1");
  t.pendingSeeds.set("del-1", "seed");

  const result = t.deleteSession("del-1");
  assert.deepEqual(result, { ok: true, sessionId: "del-1", existed: true });
  assert.equal(t.resolveEntry("del-1"), undefined);
  assert.equal(t.aliases.has("del-1"), false);
  assert.equal(t.pendingSeeds.has("del-1"), false);
  assert.equal(existsSync(path.join(stateDir, "events-del-1.jsonl")), false, "transcript file removed");
  assert.equal(existsSync(wsDir), false, "working directory removed");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.equal(registry["del-1"], undefined);
  assert.deepEqual(registry["keep-1"], other, "unloaded sessions in the registry survive");

  assert.deepEqual(t.deleteSession("del-1"), { ok: true, sessionId: "del-1", existed: false }, "idempotent");
});

test("deleteSession refuses while a turn is running", () => {
  t.wireSession({ sessionId: "backend-busy-1", onApproval() {} }, { title: "busy", modelId: "m" }, "busy-1");
  t.openTurns.set("turn-busy", { turnId: "turn-busy", logId: "busy-1", inProgress: [], lastItemAt: Date.now() });
  const result = t.deleteSession("busy-1");
  assert.equal(result.ok, false);
  assert.equal(result.code, "turn_running");
  assert.ok(t.resolveEntry("busy-1"), "still there");
  t.openTurns.delete("turn-busy");
});

// ---- agent-to-agent: host-started turns + late workflow updates ----

test("a turn the host starts (e.g. workflow results) is followed like ours", async () => {
  const turns = new Map();
  const fakeSession = {
    sessionId: "backend-host-1",
    onApproval() {},
    turn(turnId) {
      const gen = (async function* () {
        yield { kind: "agentMessage", status: "completed", text: "ALPHA BETA", turnId };
      })();
      const turn = { turnId, items: () => gen, completed: Promise.resolve({ kind: "completed", params: { terminal: "completed" } }) };
      turns.set(turnId, turn);
      return turn;
    },
  };
  t.wireSession(fakeSession, { title: "host", modelId: "m" }, "app-host-1");
  // Our own submit: recorded as followed, so the tap ignores its turn/started.
  t.followedTurns.add("own-turn-1");
  t.onHostNotification({ method: "turn/started", params: { sessionId: "backend-host-1", turnId: "own-turn-1" } });
  // A host-started one: followed.
  t.onHostNotification({ method: "turn/started", params: { sessionId: "backend-host-1", turnId: "host-turn-1" } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(turns.has("own-turn-1"), false, "our own turn isn't pumped twice");
  assert.equal(turns.has("host-turn-1"), true);
  const log = t.eventLog.get("app-host-1") ?? [];
  const types = log.map((e) => e.type);
  assert.ok(types.includes("host_turn_started"), "the transcript notes it");
  assert.ok(log.some((e) => e.type === "item" && e.item.text === "ALPHA BETA"), "its answer reaches the app");
  assert.ok(types.includes("turn_completed"));
  assert.equal(t.followedTurns.has("host-turn-1"), false, "no longer followed once it ended");
  // Unknown sessions are ignored.
  t.onHostNotification({ method: "turn/started", params: { sessionId: "nobody", turnId: "x" } });
});

test("workflow updates after their turn ended still reach the app; other items don't", () => {
  t.wireSession({ sessionId: "backend-wf-1", onApproval() {}, turn() {} }, { title: "wf", modelId: "m" }, "app-wf-1");
  const before = (t.eventLog.get("app-wf-1") ?? []).length;
  const workflow = { kind: "workflow", itemId: "wf-item", turnId: "ended-turn", status: "inProgress", children: [{ childId: "c1", attempt: 1, status: "running", label: "alpha" }] };
  t.onHostNotification({ method: "item/updated", params: { sessionId: "backend-wf-1", item: workflow } });
  t.onHostNotification({ method: "item/updated", params: { sessionId: "backend-wf-1", item: { kind: "agentMessage", itemId: "m", turnId: "ended-turn", status: "completed", text: "x" } } });
  const added = (t.eventLog.get("app-wf-1") ?? []).slice(before);
  assert.equal(added.length, 1, "only the long-lived workflow item");
  assert.equal(added[0].item.kind, "workflow");
  // Inside an open followed turn, pumpTurn relays items: the tap stays out.
  t.followedTurns.add("live-turn");
  t.openTurns.set("live-turn", { logId: "app-wf-1", turnId: "live-turn", inProgress: [], lastItemAt: Date.now() });
  t.onHostNotification({ method: "item/updated", params: { sessionId: "backend-wf-1", item: { ...workflow, turnId: "live-turn" } } });
  assert.equal((t.eventLog.get("app-wf-1") ?? []).length, before + 1);
  t.openTurns.delete("live-turn");
  t.followedTurns.delete("live-turn");
});

// ---- agent names (session/rename, session/nameChanged) ----

test("Muse's name changes reach the registry and the app", () => {
  t.wireSession({ sessionId: "backend-name-1", onApproval() {}, turn() {} }, { title: "x", modelId: "m", name: "Jolly" }, "app-name-1");
  const before = (t.eventLog.get("app-name-1") ?? []).length;
  t.onHostNotification({ method: "session/nameChanged", params: { sessionId: "backend-name-1", name: "Jolly" } });
  assert.equal((t.eventLog.get("app-name-1") ?? []).length, before, "unchanged name: no event");
  t.onHostNotification({ method: "session/nameChanged", params: { sessionId: "backend-name-1", name: "jolly-renamed" } });
  const events = (t.eventLog.get("app-name-1") ?? []).slice(before);
  assert.deepEqual(events.map((e) => [e.type, e.name]), [["name_changed", "jolly-renamed"]]);
  assert.equal(t.resolveEntry("app-name-1").meta.name, "jolly-renamed");
});

test("renameBackendSession without a connection is a safe no-op", async () => {
  assert.equal(await t.renameBackendSession("backend-x", "Pip"), null);
});

// ---- macOS launcher sandbox: agent workspaces must be writable ----

test("muse serve gets ~/workspace as a writable root (launcher sandbox)", () => {
  const env = t.museServeEnv({ PATH: "/usr/bin", META_3PAI_ADDITIONAL_WRITABLE_DIRS: "/already/there" });
  const dirs = env.META_3PAI_ADDITIONAL_WRITABLE_DIRS.split("\n");
  assert.ok(dirs.includes(`${process.env.HOME}/workspace`), "agent workspaces live under ~/workspace");
  assert.ok(dirs.includes("/already/there"), "keeps dirs the caller already granted");
  assert.equal(env.XDG_CONFIG_HOME, `${process.env.HOME}/.config/muse-code-space-pilot`);
  assert.equal(env.MUSE_AUTH_PATH, `${process.env.HOME}/.config/muse-code-space-pilot/muse/auth.json`);
  const custom = t.museServeEnv({ MUSE_CODE_SPACE_WRITABLE_DIRS: `${process.env.HOME}/a:${process.env.HOME}/b` }).META_3PAI_ADDITIONAL_WRITABLE_DIRS;
  assert.equal(custom, `${process.env.HOME}/a\n${process.env.HOME}/b`, "MUSE_CODE_SPACE_WRITABLE_DIRS overrides the default");
});

// ---- egress proxy: sessions must inherit it without manual setup ----

test("proxy fallback fills only missing vars and explicit env wins", () => {
  const filled = t.withProxyFallback(
    { HTTPS_PROXY: "http://explicit:3128", PATH: "/usr/bin" },
    ["HTTPS_PROXY=http://from-file:3128\nhttps_proxy=http://from-file:3128\nSECRET_TOKEN=nope\n# comment\n\nNO_PROXY=localhost\n"],
  );
  assert.equal(filled.HTTPS_PROXY, "http://explicit:3128", "explicit env is never overwritten");
  assert.equal(filled.https_proxy, "http://from-file:3128", "missing vars are filled from the file");
  assert.equal(filled.NO_PROXY, "localhost");
  assert.equal(filled.SECRET_TOKEN, undefined, "only proxy vars are adopted");
  const serve = t.museServeEnv(filled);
  assert.equal(serve.HTTPS_PROXY, "http://explicit:3128", "muse serve (and its agent shells) inherit the proxy");
  assert.equal(serve.https_proxy, "http://from-file:3128");
});

test("pilot health reports the GitHub broker state beside relay", async () => {
  assert.ok(["up", "down", "unknown"].includes(t.healthPayload().github_broker));
  assert.equal(typeof (await t.brokerUp()), "boolean", "broker probe resolves, never hangs");
});

test("sessions get GitHub broker wiring only when install generated it", () => {
  const runtime = path.join(process.env.HOME, "workspace", "muse-code-space-pilot");
  assert.deepEqual(t.githubSessionEnv(), {}, "no generated gitconfig: no wiring");
  writeFileSync(path.join(runtime, "gitconfig"), "[url]\n");
  mkdirSync(path.join(runtime, "gh-config"), { recursive: true });
  writeFileSync(path.join(runtime, "github-broker-ca.pem"), "cert");
  writeFileSync(path.join(runtime, "github-broker-cert.pem"), "cert");
  const env = t.githubSessionEnv();
  assert.ok(env.GIT_CONFIG_GLOBAL.endsWith("/gitconfig"));
  assert.ok(env.GH_CONFIG_DIR.endsWith("/gh-config"));
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(env.SSL_CERT_FILE.endsWith("/github-broker-ca.pem"));
  assert.ok(env.GIT_SSL_CAINFO.endsWith("/github-broker-cert.pem"), "git CA pinned to broker cert, overriding login-profile GIT_SSL_CAINFO");
  const serve = t.museServeEnv({ PATH: "/usr/bin" });
  assert.equal(serve.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_GLOBAL, "muse serve sessions inherit the wiring");
});

// ---- agent-to-agent messages ----

function messagingAgent(backendId, name, workspaceRoot) {
  const sent = [];
  const session = {
    sessionId: backendId,
    onApproval() {},
    turn() {},
    async sendUserTurn(options) {
      sent.push(options);
      const gen = (async function* () {})();
      return { turnId: `turn-${backendId}-${sent.length}`, items: () => gen, completed: Promise.resolve({ kind: "completed" }) };
    },
  };
  t.wireSession(session, { title: name, modelId: "m", name, workspaceRoot }, `app-${name}`);
  return sent;
}

test("an @agent request is routed through the built-in MCP tool, not a shell command", () => {
  const preamble = t.agentPreamble("nova");
  assert.match(preamble, /Send @name a message/);
  assert.match(preamble, /mcp__code_space__send_message with to: "name"/);
  assert.match(preamble, /Never use a shell or code-agents/);
});

test("Send @agent on a follow-up gets an MCP routing hint without changing unrelated prompts", () => {
  messagingAgent("b-mention-sender", "maple", "/w/maple");
  messagingAgent("b-mention-target", "pear", "/w/pear");
  messagingAgent("b-mention-spaced", "my agent", "/w/spaced");
  messagingAgent("b-mention-quoted", 'my "agent"', "/w/quoted");
  const sender = t.findAgent("maple");
  const prompt = "Send @pear a message asking it to replace test.rs with TEST";
  const annotated = t.annotateAgentMention(prompt, sender);
  assert.match(annotated, /mcp__code_space__send_message with to: "pear"/);
  assert.ok(annotated.endsWith(prompt), "the user's exact text remains at the end");
  assert.match(t.annotateAgentMention('Send @"my agent" hello', sender), /to: "my agent"/);
  assert.ok(t.annotateAgentMention(`Send @${JSON.stringify('my "agent"')} hello`, sender).includes(`to: ${JSON.stringify('my "agent"')}`));
  assert.match(t.annotateAgentMention("Send @jolly a status note", sender), /Muse assistant "Jolly"[\s\S]*to: "Jolly"/);
  const oldName = t.getAssistant().name;
  t.setAssistant({ name: "Actual Muse" });
  assert.match(t.annotateAgentMention('Send @"Actual Muse" a note', sender), /to: "Actual Muse"/);
  t.setAssistant({ name: oldName });
  for (const raw of ["Please review @pear", "Send @missing hello", "Send @maple hello", "foo@pear.com"]) {
    assert.equal(t.annotateAgentMention(raw, sender), raw, `don't route ${raw}`);
  }
});

test("agents message each other by name; both transcripts record it; the turn says who and how to reply", async () => {
  const jollySent = messagingAgent("b-jolly", "jolly", "/w/jolly");
  const pipSent = messagingAgent("b-pip", "pip", "/w/pip");
  assert.deepEqual(t.agentDirectory().filter((a) => ["jolly", "pip"].includes(a.name)).map((a) => a.name), ["jolly", "pip"]);

  // The MCP token identifies the sender; no bash-provided cwd/name is trusted.
  const sender = t.findAgent("jolly");
  const result = await t.deliverAgentMessage({ from: { kind: "agent", entry: sender }, to: "PIP", text: "Can you review my diff?" });
  assert.equal(result.ok, true);
  assert.equal(result.to.name, "pip", "names match case-insensitively");
  const turnText = pipSent[0].input[0].text;
  assert.match(turnText, /^Message from agent "jolly" \(via Code Space\)\. To reply: use mcp__code_space__send_message with to "jolly"/);
  assert.match(turnText, /Can you review my diff\?$/);
  assert.equal(pipSent[0].ifBusy, "queue", "queued behind a running turn");
  const pipIn = (t.eventLog.get("app-pip") ?? []).find((e) => e.type === "agent_message");
  const jollyOut = (t.eventLog.get("app-jolly") ?? []).find((e) => e.type === "agent_message");
  assert.deepEqual([pipIn.direction, pipIn.from.name, pipIn.text], ["in", "jolly", "Can you review my diff?"]);
  assert.deepEqual([jollyOut.direction, jollyOut.to.name], ["out", "pip"]);
  assert.equal(jollySent.length, 0, "the sender gets no turn");
});

test("Muse's messages are labeled as Muse; replies to muse land in the Muse inbox", async () => {
  const sent = messagingAgent("b-juno", "juno", "/w/juno");
  const fromMuse = await t.deliverAgentMessage({ from: { kind: "muse" }, to: "juno", text: "Status update please" });
  assert.equal(fromMuse.ok, true);
  assert.match(sent[0].input[0].text, /^Message from Jolly — the user's Muse assistant.*To reply: use mcp__code_space__send_message with to "Jolly"/);
  const juno = t.findAgent("juno");
  const before = t.readMuseInbox().length;
  const reply = await t.deliverAgentMessage({ from: { kind: "agent", entry: juno }, to: "muse", text: "All tests pass." });
  assert.equal(reply.ok, true);
  const inbox = t.readMuseInbox();
  assert.equal(inbox.length, before + 1);
  assert.deepEqual([inbox.at(-1).from.name, inbox.at(-1).text], ["juno", "All tests pass."]);
  assert.equal(t.readMuseInbox(inbox.at(-1).seq).length, 0, "since= reads only newer messages");
});

test("unknown recipients, self-messages and empty messages are refused", async () => {
  messagingAgent("b-milo", "milo", "/w/shared");
  messagingAgent("b-nova", "nova", "/w/shared");
  const milo = t.findAgent("milo");
  assert.equal((await t.deliverAgentMessage({ from: { kind: "agent", entry: milo }, to: "nobody", text: "hi" })).code, "unknown_agent");
  assert.equal((await t.deliverAgentMessage({ from: { kind: "agent", entry: milo }, to: "milo", text: "hi" })).code, "bad_request");
  assert.equal((await t.deliverAgentMessage({ from: { kind: "agent", entry: milo }, to: "nova", text: "   " })).code, "bad_request");
});

// ---- built-in messaging tools (MCP) + the assistant's reserved identity ----

test("sessionMcp grant and required MCP server are startup requirements", async () => {
  const { attachSessionMcp, requireSessionMcp } = await import("./mcp.mjs");
  assert.throws(() => requireSessionMcp({ grantedCapabilities: [] }), /requires.*sessionMcp/);
  assert.throws(() => requireSessionMcp(undefined), /requires.*sessionMcp/);
  assert.doesNotThrow(() => requireSessionMcp({ grantedCapabilities: ["sessionMcp"] }));
  const start = { workspaceRoot: "/w/pip", approvalMode: "allowAll" };
  const enabled = attachSessionMcp("session/start", start, "http://127.0.0.1:18791", () => "tok-pip");
  assert.equal(enabled.token, "tok-pip");
  assert.equal(enabled.params.config.mcpServers["code-space"].url, "http://127.0.0.1:18791/mcp/tok-pip");
  assert.equal(enabled.params.config.mcpServers["code-space"].mode, "required");
  assert.equal(start.config, undefined, "never mutate the original params");
  const resume = attachSessionMcp("session/resume", { sessionId: "pip" }, "http://127.0.0.1:18791", () => "tok-resume");
  assert.equal(resume.params.config.mcpServers["code-space"].url, "http://127.0.0.1:18791/mcp/tok-resume");
  assert.equal(attachSessionMcp("turn/start", start, "http://127.0.0.1:18791").token, null);
});

test("pilot HTTP starts before resuming sessions with required MCP", () => {
  const source = readFileSync(new URL("./pilot.mjs", import.meta.url), "utf8");
  const boot = source.slice(source.indexOf("async function boot() {"), source.indexOf("function broadcastAll(event)"));
  assert.ok(boot.includes("requireSessionMcp") === false, "capability check happens in spawnHost, before boot listens");
  assert.ok(boot.indexOf("server.listen(PORT") < boot.indexOf("await resumeAll()"), "MCP HTTP route must be listening before session/resume");
  assert.ok(source.includes("mcpTokens.clear(); // only freshly resumed sessions may use MCP tokens"));
});

test("the per-session MCP server offers send_message / list_agents as the calling agent", async () => {
  const { handleMcpRequest, MCP_TOOLS, sessionMcpConfig } = await import("./mcp.mjs");
  messagingAgent("b-remy", "remy", "/w/remy");
  const lunaSent = messagingAgent("b-luna", "luna", "/w/luna");
  t.mcpTokens.set("tok-remy", "b-remy");
  const call = (message) => handleMcpRequest("tok-remy", message, t.mcpDeps);

  const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.ok(init.result.capabilities.tools);
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "notifications get no response");
  const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(tools.result.tools.map((x) => x.name), MCP_TOOLS.map((x) => x.name));

  const list = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: {} } });
  const listing = list.result.content[0].text;
  assert.match(listing, /You are "remy"/);
  assert.match(listing, /- luna/);
  assert.ok(!listing.includes("- remy"), "an agent doesn't list itself");
  assert.match(listing, /- Jolly — your Muse assistant/);
  assert.ok(!listing.includes("- muse"), "list the assistant's usable avatar name rather than a routing alias");
  t.setAssistant({ name: "Actual Muse" });
  const renamed = await call({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "list_agents", arguments: {} } });
  assert.match(renamed.result.content[0].text, /- Actual Muse — your Muse assistant/);
  // An older fixture wired an agent called jolly directly, bypassing the
  // normal reserved-name check. Remove it before restoring the avatar name.
  t.deleteSession("app-jolly");
  assert.equal(t.setAssistant({ name: "Jolly" }).ok, true);

  const sent = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send_message", arguments: { to: "luna", text: "hello from a tool" } } });
  assert.match(sent.result.content[0].text, /^Delivered to luna/);
  assert.match(lunaSent[0].input[0].text, /Message from agent "remy"/, "the token identified the sender");

  const bad = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "send_message", arguments: { to: "nobody", text: "x" } } });
  assert.equal(bad.result.isError, true);
  const unknownToken = await handleMcpRequest("no-such-token", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_agents" } }, t.mcpDeps);
  assert.equal(unknownToken.result.isError, true);

  const config = sessionMcpConfig("http://127.0.0.1:18791", "abc");
  assert.deepEqual(config.mcpServers["code-space"], { transport: "streamableHttp", url: "http://127.0.0.1:18791/mcp/abc", mode: "required" });
});

test("muse, jolly and the assistant's name are reserved and reach the assistant", async () => {
  assert.equal(t.getAssistant().name, "Jolly");
  assert.equal(t.getAssistant().color, "#d0e4fc");
  for (const name of ["muse", "Jolly", "@jolly", "MUSE"]) assert.equal(t.isReservedName(name), true, name);
  assert.equal(t.isReservedName("pip"), false);
  messagingAgent("b-otto", "otto", "/w/otto");
  const otto = t.findAgent("otto");
  const before = t.readMuseInbox().length;
  const viaJolly = await t.deliverAgentMessage({ from: { kind: "agent", entry: otto }, to: "jolly", text: "Done." });
  assert.equal(viaJolly.ok, true);
  assert.equal(viaJolly.to.name, "Jolly");
  assert.equal(t.readMuseInbox().length, before + 1, "messages to jolly go to the assistant's inbox");
  // The assistant can take its real avatar name and color (on a Muse VM).
  assert.equal(t.setAssistant({ name: "otto" }).ok, false, "can't take an agent's name");
  assert.equal(t.setAssistant({ color: "blue" }).ok, false);
  assert.equal(t.setAssistant({ name: "Aria", color: "#AABBCC" }).ok, true);
  assert.equal(t.isReservedName("aria"), true);
  assert.equal(t.isReservedName("jolly"), true, "jolly stays reserved");
  t.setAssistant({ name: "Jolly", color: "#d0e4fc" });
});

// ---- durable first-message admission across app/pilot restarts ----

test("new direct pilot sessions use a short stable workspace name, not the full id", () => {
  const id = "manual-1234-session-with-a-very-long-name";
  const workspace = t.defaultWorkspacePath(id);
  assert.match(workspace, /\/workspace\/code\/[0-9a-f]{12}$/);
  assert.equal(t.defaultWorkspacePath(id), workspace);
  assert.notEqual(t.defaultWorkspacePath(`${id}-other`), workspace);
  assert.ok(!workspace.includes("muse-sessions") && !workspace.includes("manual-"));
  assert.match(t.defaultWorkspacePath(null), /\/workspace\/code\/[0-9a-f]{12}$/);
});

test("generated pilot paths refuse host collisions; explicit custom paths can be reused", () => {
  const workspace = path.join(stateDir, "generated-path-collision");
  assert.equal(t.createWorkspacePath(workspace, true), true);
  writeFileSync(path.join(workspace, "keep.txt"), "existing work");
  assert.equal(t.createWorkspacePath(workspace, true), false);
  assert.equal(t.createWorkspacePath(workspace, false), true);
  assert.equal(readFileSync(path.join(workspace, "keep.txt"), "utf8"), "existing work");
});

test("POST /sessions retry with the same workspaceName reuses an admitted first turn", async () => {
  let submitted = 0;
  t.wireSession({
    sessionId: "backend-first-1",
    onApproval() {},
    async sendUserTurn() { submitted += 1; throw new Error("the first turn must not be sent twice"); },
  }, {
    title: "Pip", name: "pip", modelId: "demo-orbit-2.4-preview",
    workspaceRoot: "/tmp/first-1", appSessionId: "app-first-1", initialTurnId: "turn-first-1",
  }, "backend-first-1");
  const result = await t.createPilotSessionOnce({ workspaceName: "app-first-1", prompt: "hello again" });
  assert.equal(result.code, 200);
  assert.equal(result.body.sessionId, "backend-first-1");
  assert.equal(result.body.turnId, "turn-first-1");
  assert.equal(submitted, 0);
});

test("saving a new session keeps unrecovered sessions in the registry", () => {
  const registryPath = path.join(stateDir, "sessions.json");
  const saved = t.loadRegistry();
  saved["unrecovered-keep-1"] = { title: "Don't lose me", modelId: "m" };
  writeFileSync(registryPath, JSON.stringify(saved));
  t.saveRegistry();
  assert.equal(t.loadRegistry()["unrecovered-keep-1"].title, "Don't lose me");
});


test("assistant avatar persists, survives partial identity edits, and clears atomically", () => {
  const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz/8AAAAASUVORK5CYII=";
  assert.equal(t.setAssistant({ avatar_data_url: avatar }).ok, true);
  assert.equal(JSON.parse(readFileSync(path.join(stateDir,"assistant.json"),"utf8")).avatar_data_url,avatar);
  assert.equal(t.loadAssistant().avatar_data_url,avatar, "a restarted pilot reloads the persisted avatar");
  assert.equal(t.setAssistant({ color: "#aabbcc" }).ok,true);
  assert.equal(t.getAssistant().avatar_data_url,avatar);
  assert.equal(t.setAssistant({ name: "Invalid avatar edit", avatar_data_url: "https://example.com/no.png" }).ok,false);
  assert.equal(t.getAssistant().name,"Jolly");
  assert.equal(t.getAssistant().avatar_data_url,avatar);
  assert.equal(t.setAssistant({ avatar_data_url: null, color: "#d0e4fc" }).ok,true);
  assert.equal(t.getAssistant().avatar_data_url,null);
  assert.equal(JSON.parse(readFileSync(path.join(stateDir,"assistant.json"),"utf8")).avatar_data_url,null);
});

test("user_name persists, survives partial identity edits, and clears with null", () => {
  assert.equal(t.getAssistant().user_name, null);
  assert.equal(t.setAssistant({ user_name: "  Alex Doe  " }).ok, true);
  assert.equal(t.getAssistant().user_name, "Alex Doe");
  assert.equal(JSON.parse(readFileSync(path.join(stateDir, "assistant.json"), "utf8")).user_name, "Alex Doe");
  assert.equal(t.loadAssistant().user_name, "Alex Doe", "a restarted pilot reloads the persisted user name");
  assert.equal(t.setAssistant({ color: "#aabbcc" }).ok, true);
  assert.equal(t.getAssistant().user_name, "Alex Doe", "partial identity edits keep the user name");
  assert.equal(t.setAssistant({ user_name: "bad/name!" }).ok, false);
  assert.equal(t.getAssistant().user_name, "Alex Doe", "invalid names are refused without clobbering");
  assert.equal(t.setAssistant({ user_name: null }).ok, true);
  assert.equal(t.getAssistant().user_name, null);
  assert.equal(JSON.parse(readFileSync(path.join(stateDir, "assistant.json"), "utf8")).user_name, null);
});

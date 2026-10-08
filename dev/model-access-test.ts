// Local integration check, using its own fake pilot, dev server, and temporary
// state. Run: bun dev/model-access-test.ts. No live services or artifact data.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = mkdtempSync(join(tmpdir(), "muse-model-access-"));
const PILOT_PORT = Number(process.env.MUSE_CODE_SPACE_MODEL_TEST_PILOT_PORT ?? 18897);
const APP_PORT = Number(process.env.MUSE_CODE_SPACE_MODEL_TEST_APP_PORT ?? 4187);
const PILOT = `http://127.0.0.1:${PILOT_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pilot: Subprocess | undefined;
let app: Subprocess | undefined;

async function action(name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${APP}/actions`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: name, args }) });
  const payload = await response.json() as { data?: any; error?: unknown };
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.data;
}

async function ready(url: string, child: Subprocess) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`Test process exited: ${child.exitCode}. Logs: ${TEMP}`);
    try { if ((await fetch(url)).ok) return; } catch { /* still starting */ }
    await pause(100);
  }
  throw new Error(`Test process did not become ready: ${url}. Logs: ${TEMP}`);
}

async function startPilot(access: "spark" | "wonder" | "full") {
  if (pilot) { pilot.kill(); await pilot.exited; }
  pilot = Bun.spawn([process.execPath, join(ROOT, "dev/fake-pilot.ts")], {
    env: { ...process.env, MUSE_CODE_SPACE_FAKE_PILOT_PORT: String(PILOT_PORT),
      MUSE_CODE_SPACE_FAKE_PILOT_MODEL_ACCESS: access,
      MUSE_CODE_SPACE_FAKE_PILOT_STATE: join(TEMP, "pilot.json") },
    stdout: Bun.file(join(TEMP, `pilot-${access}.log`)), stderr: "inherit",
  });
  await ready(`${PILOT}/health`, pilot);
}

async function finished(id: string) {
  for (let i = 0; i < 200; i++) {
    await action("syncPilotEvents", { session_id: id });
    const { session } = await action("getSession", { id });
    if (["succeeded", "failed", "stopped"].includes(session.status)) {
      assert.equal(session.status, "succeeded");
      return session;
    }
    await pause(100);
  }
  throw new Error(`Task did not finish: ${id}`);
}

const create = (id: string, title: string) => action("createSession", {
  session_id: id, title, prompt: "Hello", workspaceRoot: `/home/hatch/workspace/model-access/${id}`,
});
const pilotSessions = () => fetch(`${PILOT}/sessions`).then((r) => r.json());

// Refuse occupied ports so the checks cannot hit a manually running server.
for (const port of [PILOT_PORT, APP_PORT]) {
  const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  probe.stop(true);
}

try {
  await startPilot("spark");
  app = Bun.spawn([process.execPath, join(ROOT, "dev/server.ts")], {
    cwd: ROOT,
    env: { ...process.env, MUSE_CODE_SPACE_PILOT_URL: PILOT, MUSE_CODE_SPACE_DEV_PORT: String(APP_PORT),
      MUSE_CODE_SPACE_DEV_DIR: join(TEMP, "dev") },
    stdout: Bun.file(join(TEMP, "app.log")), stderr: Bun.file(join(TEMP, "app-errors.log")),
  });
  await ready(APP, app);
  const initial = await action("listModels");
  assert.equal(initial.access_checked, true);
  assert.ok(!initial.models.some((model: { id: string }) => model.id.includes("wonder")));

  // A stale externally synced catalog cannot grant paid access.
  await action("syncModels", { models: [
    { id: "muse-spark-1.3", display_name: "Muse Spark 1.3" },
    { id: "muse-wonder-1.0", display_name: "Muse Wonder 1.0" },
    { id: "muse-wonder-full-1.0", display_name: "Muse Wonder Full 1.0" },
  ] });
  await assert.rejects(() => action("upsertSession", { id: "bypass", title: "Nova", prompt: "Hello" }), /requires an upgrade/);
  const denied = await create("blocked", "Nova");
  assert.equal(denied.ok, false);
  assert.match(denied.error, /requires an upgrade/);
  assert.match(denied.error, /https:\/\/dev\.meta\.ai\/billing/);
  assert.equal((await action("listSessions")).sessions.length, 0);
  assert.equal((await pilotSessions()).length, 0);

  assert.equal((await create("ordinary", "Pip")).ok, true);
  const ordinary = await finished("ordinary");
  const failedHandoff = await action("assignAgent", { id: "ordinary", agent_id: "nova" });
  assert.equal(failedHandoff.ok, false);
  assert.match(failedHandoff.error, /requires an upgrade/);
  const unchanged = (await action("getSession", { id: "ordinary" })).session;
  for (const key of ["title", "model_id", "reasoning_effort", "updated_at", "workspace_root"]) {
    assert.equal(unchanged[key], ordinary[key], key);
  }
  assert.equal((await pilotSessions())[0].name, "Pip");

  await startPilot("wonder");
  const wonder = await action("listModels");
  assert.ok(wonder.models.some((model: { id: string }) => model.id === "muse-wonder-1.0"));
  assert.ok(!wonder.models.some((model: { id: string }) => model.id === "muse-wonder-full-1.0"));
  assert.equal((await create("full-denied", "Sage")).ok, false);
  assert.equal((await action("assignAgent", { id: "ordinary", agent_id: "nova" })).ok, true);
  assert.equal((await action("getSession", { id: "ordinary" })).session.model_id, "muse-wonder-1.0");
  assert.equal((await action("continueSession", { session_id: "ordinary", content: "Continue" })).ok, true);
  assert.equal((await finished("ordinary")).model_id, "muse-wonder-1.0");

  await startPilot("full");
  assert.equal((await create("full-task", "Sage")).ok, true);
  const full = await finished("full-task");
  assert.equal(full.model_id, "muse-wonder-full-1.0");
  assert.equal(full.reasoning_effort, "max");
  assert.equal((await action("setSessionArchived", { id: "full-task", archived: true })).ok, true);

  await startPilot("spark");
  const before = await pilotSessions();
  assert.equal((await action("upsertSession", { id: "full-task", title: "Sage", prompt: "Maintenance", status: "succeeded" })).ok, true);
  assert.equal((await action("setSessionArchived", { id: "full-task", archived: false })).ok, false);
  assert.equal((await action("continueSession", { session_id: "full-task", content: "Resume", resume: true })).ok, false);
  const stillPast = (await action("getSession", { id: "full-task" })).session;
  assert.equal(stillPast.archived, true);
  assert.equal(stillPast.model_id, "muse-wonder-full-1.0");
  assert.equal((await action("continueSession", { session_id: "ordinary", content: "No access now" })).ok, false);
  assert.deepEqual(await pilotSessions(), before);

  // Unavailable pilot is unknown access, even if the saved catalog has paid IDs.
  pilot!.kill(); await pilot!.exited; pilot = undefined;
  const offline = await action("listModels");
  assert.equal(offline.access_checked, false);
  assert.ok(offline.models.some((model: { id: string }) => model.id === "muse-wonder-full-1.0"));
  const unavailable = await create("offline", "Ember");
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.retryable, true);
  assert.doesNotMatch(unavailable.error, /requires an upgrade/);
  console.log("PASS: live filtered access, stale-catalog denial, no fallback, paid starts/handoffs, partial access, revoked access, archived resume rollback, and offline distinction.");
} catch (error) {
  for (const file of ["app.log", "app-errors.log"]) {
    try { console.error(readFileSync(join(TEMP, file), "utf8").slice(-5000)); } catch { /* no log yet */ }
  }
  throw error;
} finally {
  app?.kill(); pilot?.kill();
  await Promise.all([app?.exited, pilot?.exited]);
  console.log(`Test state and logs: ${TEMP}`);
}

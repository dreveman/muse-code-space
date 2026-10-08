// Restart test: exercises restarting every service the app depends on and
// checks that sessions survive and keep working.
//
//   bun run test:restart               # fake pilot (no muse needed)
//   bun run test:restart --real        # real pilot + your machine's `muse serve`
//
// Runs its own pilot (port 18894) and dev server (port 4176) with throwaway
// state under a temp dir, so it never touches the pilot/dev server you're
// using. The app's actions are driven the same way the UI drives them
// (create, continue, and syncPilotEvents polling).
//
// Scenarios (each ends with a follow-up turn that must succeed):
//   1. restart the dev server (app worker + DB)
//   2. restart the pilot (SIGTERM)
//   3. crash the pilot (SIGKILL)
//   4. kill `muse serve` under the pilot (real pilot only; it must respawn)
//   4a. crash the dev server with a freshly started tool still in progress
//   5. restart the pilot with a freshly started tool still in progress:
//      the turn must end visibly (never stay "running"), then continue
//   6. restart everything at once
// Finally: still exactly one app session, transcript intact.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const REAL = process.argv.includes("--real");
const KEEP = process.argv.includes("--keep");
const ROOT = resolve(import.meta.dir, "..");
const PILOT_PORT = Number(process.env.MUSE_CODE_SPACE_RESTART_TEST_PILOT_PORT ?? 18894);
const DEV_PORT = Number(process.env.MUSE_CODE_SPACE_RESTART_TEST_DEV_PORT ?? 4176);
const PILOT_URL = `http://127.0.0.1:${PILOT_PORT}`;
const APP_URL = `http://127.0.0.1:${DEV_PORT}`;
const TMP = join(tmpdir(), `mcs-restart-${Date.now()}`);
const TURN_TIMEOUT_MS = REAL ? 180_000 : 30_000;
const SESSION_ID = `restart-test-${Date.now()}`;
const TERMINAL = new Set(["succeeded", "failed", "stopped"]);

mkdirSync(TMP, { recursive: true });
const log = (msg: string) => console.log(`[restart-test] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- processes ----
let pilot: Subprocess | null = null;
let dev: Subprocess | null = null;

function startPilot() {
  const common = { MUSE_CODE_SPACE_PILOT_PORT: String(PILOT_PORT), PATH: process.env.PATH ?? "" };
  if (REAL) {
    const muse = Bun.which("muse");
    if (!muse) throw new Error("--real needs `muse` on PATH");
    pilot = Bun.spawn(["node", join(ROOT, "pilot/pilot.mjs")], {
      env: {
        ...process.env,
        ...common,
        MUSE_CODE_SPACE_MUSE_BIN: process.env.MUSE_CODE_SPACE_MUSE_BIN ?? muse,
        MUSE_CODE_SPACE_RELAY_URL: process.env.MUSE_CODE_SPACE_RELAY_URL ?? "none",
        MUSE_CODE_SPACE_PILOT_STATE_DIR: join(TMP, "pilot-state"),
        MUSE_CODE_SPACE_WORKSPACES: join(TMP, "workspaces"),
        // Keep a lost mid-turn from waiting the default 5 minutes.
        MUSE_CODE_SPACE_TURN_IDLE_TIMEOUT_MS: "45000",
      },
      stdout: Bun.file(join(TMP, "pilot.log")),
      stderr: Bun.file(join(TMP, "pilot.log")),
    });
  } else {
    pilot = Bun.spawn(["bun", join(ROOT, "dev/fake-pilot.ts")], {
      env: { ...process.env, ...common, MUSE_CODE_SPACE_FAKE_PILOT_PORT: String(PILOT_PORT), MUSE_CODE_SPACE_FAKE_PILOT_STATE: join(TMP, "fake-pilot.json"), MUSE_CODE_SPACE_FAKE_PILOT_SLOW_STEP_MS: "4000" },
      stdout: Bun.file(join(TMP, "pilot.log")),
      stderr: Bun.file(join(TMP, "pilot.log")),
    });
  }
}

function startDev() {
  dev = Bun.spawn(["bun", join(ROOT, "dev/server.ts")], {
    env: { ...process.env, MUSE_CODE_SPACE_DEV_DIR: join(TMP, "dev"), MUSE_CODE_SPACE_DEV_PORT: String(DEV_PORT), MUSE_CODE_SPACE_PILOT_URL: PILOT_URL },
    stdout: Bun.file(join(TMP, "dev.log")),
    stderr: Bun.file(join(TMP, "dev.log")),
  });
}

async function stop(proc: Subprocess | null, signal: NodeJS.Signals = "SIGTERM") {
  if (!proc || proc.exitCode !== null) return;
  proc.kill(signal);
  await Promise.race([proc.exited, sleep(8000)]);
  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last).slice(0, 200)})` : ""}`);
}

async function pilotHealth() {
  const res = await fetch(`${PILOT_URL}/health`, { signal: AbortSignal.timeout(2000) });
  return (await res.json()) as { ok: boolean; sessions: number; home?: string };
}
const waitPilot = () => waitFor("pilot /health", async () => (await pilotHealth()).ok, REAL ? 90_000 : 15_000);
const waitDev = () => waitFor("dev server", async () => (await fetch(APP_URL, { signal: AbortSignal.timeout(2000) })).ok, 30_000);

// ---- app actions (the same calls the UI makes) ----
async function act<T = Record<string, unknown>>(action: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${APP_URL}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args, actionCallId: crypto.randomUUID() }),
  });
  const body = (await res.json()) as { data?: T; error?: string };
  if (!res.ok || body.error) throw new Error(`${action}: ${res.status} ${body.error ?? ""}`);
  return body.data as T;
}

type Session = { id: string; status: string; summary: string | null; pilot_session_id: string | null };
type Detail = { session: Session | null; events: Array<{ id: number; kind: string; content: string; system_is_error: boolean; started_at?: string | null; finished_at?: string | null; tool_details?: { tool: string | null; status: string | null } | null }> };
type PilotPoll = { latestSeq: number; hasOpenTurn: boolean; events: Array<{ seq: number; type: string; item?: { itemId?: string; kind?: string; tool?: string; status?: string } }> };
async function pilotPoll(sessionId: string, since = 0): Promise<PilotPoll> {
  const response = await fetch(`${PILOT_URL}/sessions/${encodeURIComponent(sessionId)}/poll?since=${since}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`pilot poll refused ${response.status}`);
  return await response.json() as PilotPoll;
}
const detail = () => act<Detail>("getSession", { id: SESSION_ID, event_limit: 2000 });

/** Poll like the UI (syncPilotEvents) until the session leaves queued/running. */
async function settle(label: string): Promise<Detail> {
  return waitFor(`${label}: session to finish its turn`, async () => {
    await act("syncPilotEvents", { session_id: SESSION_ID });
    const d = await detail();
    return d.session && TERMINAL.has(d.session.status) ? d : null;
  }, TURN_TIMEOUT_MS);
}

function prompt(kind: "quick" | "slow"): string {
  if (!REAL) return kind === "slow" ? "slow turn please" : "quick turn";
  return kind === "slow"
    ? "Run `sleep 25` with the bash tool, then reply with SLEPT and nothing else."
    : "Reply with OK and nothing else.";
}

async function continueTurn(label: string): Promise<Detail> {
  const res = await act<{ ok: boolean; error: string | null }>("continueSession", {
    session_id: SESSION_ID,
    content: `${prompt("quick")} (${label})`,
  });
  if (!res.ok) throw new Error(`${label}: continueSession refused: ${res.error}`);
  const d = await settle(label);
  if (d.session?.status !== "succeeded") {
    throw new Error(`${label}: follow-up turn ended ${d.session?.status}: ${d.session?.summary ?? ""}`);
  }
  return d;
}

// Wait for a tool from THIS turn, not a tool left in an older transcript. A
// latest in-progress SDK revision plus the app's unfinished row proves the
// process was killed while the turn was genuinely doing work.
async function startObservedSlowTurn(label: string): Promise<{ pilotId: string; userCount: number; eventId: number; toolRowId: number }> {
  const before = await detail();
  const pilotId = before.session?.pilot_session_id;
  if (!pilotId) throw new Error(`${label}: the app has no pilot session id`);
  const baseline = (await pilotPoll(pilotId)).latestSeq;
  const eventId = before.events.at(-1)?.id ?? 0;
  const userCount = before.events.filter((event) => event.kind === "user").length;
  const res = await act<{ ok: boolean; error: string | null }>("continueSession", {
    session_id: SESSION_ID, content: prompt("slow"),
  });
  if (!res.ok) throw new Error(`${label}: continueSession refused: ${res.error}`);
  const toolRowId = await waitFor(`${label}: new in-progress tool`, async () => {
    const poll = await pilotPoll(pilotId, baseline);
    const latest = new Map<string, NonNullable<PilotPoll["events"][number]["item"]>>();
    for (const event of poll.events) {
      if (event.type === "item" && event.item?.kind === "toolCall") {
        latest.set(event.item.itemId ?? event.item.tool ?? String(event.seq), event.item);
      }
    }
    if (!poll.hasOpenTurn || ![...latest.values()].some((item) => item.status === "inProgress")) return null;
    await act("syncPilotEvents", { session_id: SESSION_ID });
    const now = await detail();
    return now.events.find((event) => event.id > eventId && event.kind === "tool" &&
      event.started_at && !event.finished_at && event.tool_details?.status === "inProgress")?.id ?? null;
  }, REAL ? 90_000 : 30_000);
  return { pilotId, userCount, eventId, toolRowId };
}

// Real mode uses uniquely named short workspaces under ~/workspace/code. Record
// only paths that did not exist before this test, then remove those exact
// paths at the end; never clean the live pilot's state or existing agents.
const realWorkspaces = new Map<string, { path: string; home: string }>();
function testWorkspaceRoot(id: string, home: string): string {
  const token = createHash("sha256").update(id).digest("hex").slice(0, 12);
  const path = REAL ? `${home}/workspace/code/${token}` : `~/workspace/code/${token}`;
  if (REAL) {
    if (existsSync(path)) throw new Error(`Refusing to reuse pre-existing restart-test workspace ${path}`);
    realWorkspaces.set(id, { path, home });
  }
  return path;
}

const results: Array<{ name: string; ok: boolean; note: string }> = [];
async function scenario(name: string, run: () => Promise<string | void>) {
  log(`▶ ${name}`);
  const started = Date.now();
  try {
    const note = (await run()) ?? "";
    results.push({ name, ok: true, note: `${note}${note ? "; " : ""}${((Date.now() - started) / 1000).toFixed(1)}s` });
    log(`  ✔ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, note: String(error instanceof Error ? error.message : error) });
    log(`  ✖ ${name}: ${String(error).slice(0, 300)}`);
  }
}

// Kill `muse serve` under the real pilot; its death-watch must respawn it.
async function killMuseServe() {
  if (!pilot) throw new Error("no pilot");
  const out = await new Response(Bun.spawn(["pgrep", "-P", String(pilot.pid)]).stdout).text();
  const pids = out.split(/\s+/).filter(Boolean);
  if (pids.length === 0) throw new Error("no `muse serve` child under the pilot");
  for (const pid of pids) process.kill(Number(pid), "SIGKILL");
  return pids.length;
}

async function main() {
  log(`mode: ${REAL ? "real pilot + muse serve" : "fake pilot"}; state in ${TMP}`);
  startPilot();
  await waitPilot();
  startDev();
  await waitDev();
  const home = (await pilotHealth()).home ?? "/home/hatch";
  // The real test pilot uses an isolated MUSE_CODE_SPACE_WORKSPACES override,
  // so it won't create the app's default parent. Never remove it later.
  if (REAL) mkdirSync(`${home}/workspace/code`, { recursive: true });
  const workspaceRoot = testWorkspaceRoot(SESSION_ID, home);

  await scenario("0. create a session and finish a turn", async () => {
    const res = await act<{ ok: boolean; error: string | null }>("createSession", {
      session_id: SESSION_ID,
      title: "Milo",
      prompt: prompt("quick"),
      workspaceRoot,
      });
    if (!res.ok) throw new Error(`createSession: ${res.error}`);
    const d = await settle("first turn");
    if (d.session?.status !== "succeeded") throw new Error(`first turn ended ${d.session?.status}: ${d.session?.summary}`);
    const token = createHash("sha256").update(SESSION_ID).digest("hex").slice(0, 12);
    const collision = await act<{ ok: boolean; error: string | null }>("createSession", {
      session_id: `manual-${Date.now()}-${token}`, prompt: "This must not start", workspaceRoot,
    });
    if (collision.ok || !collision.error?.includes("already in use")) {
      throw new Error(`a second agent reused the generated workspace: ${JSON.stringify(collision)}`);
    }
    return `${d.events.length} events; short-path collision refused`;
  });
  if (!results[0]?.ok) return;

  await scenario("1. restart the dev server", async () => {
    const before = (await detail()).events.length;
    await stop(dev);
    startDev();
    await waitDev();
    const after = (await detail()).events.length;
    if (after < before) throw new Error(`transcript shrank across restart: ${before} → ${after}`);
    await continueTurn("after dev server restart");
    return `transcript kept (${before} events)`;
  });

  await scenario("2. restart the pilot (SIGTERM)", async () => {
    const before = await detail();
    await stop(pilot, "SIGTERM");
    // The worker stays up: DB-backed transcripts still load, and a failed
    // pilot poll must not erase them or invent a terminal outcome.
    const during = await detail();
    const paused = await act<{ added: number; status: string; pilot_available: boolean | null }>("syncPilotEvents", { session_id: SESSION_ID });
    if (during.events.length !== before.events.length || paused.added !== 0 || paused.pilot_available !== false || paused.status !== before.session?.status) {
      throw new Error("the app lost or changed its transcript while only the pilot was down");
    }
    startPilot();
    await waitPilot();
    await continueTurn("after pilot restart");
  });

  await scenario("3. crash the pilot (SIGKILL)", async () => {
    await stop(pilot, "SIGKILL");
    startPilot();
    await waitPilot();
    await continueTurn("after pilot crash");
  });

  if (REAL) {
    await scenario("4. kill muse serve under the pilot", async () => {
      const killed = await killMuseServe();
      await sleep(3000); // the death-watch waits 2s before respawning
      await waitPilot();
      await continueTurn("after muse serve respawn");
      return `killed ${killed} process(es)`;
    });
  }

  await scenario("4a. restart the dev server mid-turn", async () => {
    const active = await startObservedSlowTurn("worker restart");
    await stop(dev, "SIGKILL");
    // The pilot must remain up and track the in-flight turn while the app
    // worker is gone; after restart the DB watermark catches up once.
    if (!(await pilotPoll(active.pilotId)).hasOpenTurn) throw new Error("pilot lost the turn when only the dev server died");
    startDev();
    await waitDev();
    const d = await settle("turn across worker restart");
    if (d.session?.status !== "succeeded") throw new Error(`turn ended ${d.session?.status}: ${d.session?.summary}`);
    if (d.events.filter((e) => e.kind === "user").length !== active.userCount + 1) throw new Error("worker restart duplicated a user turn");
    if (!d.events.find((e) => e.id === active.toolRowId)?.finished_at) throw new Error("worker restart left the tool timing open");
    await continueTurn("after worker mid-turn restart");
    return "pilot kept running; original turn completed once";
  });

  await scenario("5. restart the pilot mid-turn", async () => {
    const active = await startObservedSlowTurn("pilot restart");
    await stop(pilot, "SIGTERM");
    const paused = await act<{ added: number; status: string; pilot_available: boolean | null }>("syncPilotEvents", { session_id: SESSION_ID });
    if (paused.added !== 0 || paused.pilot_available !== false || paused.status !== "running") throw new Error("pilot outage changed the active turn before recovery");
    startPilot();
    await waitPilot();
    const d = await settle("interrupted turn");
    if (d.events.filter((e) => e.kind === "user").length !== active.userCount + 1) throw new Error("restart replayed the submitted turn");
    if (!d.events.find((e) => e.id === active.toolRowId)?.finished_at) throw new Error("restart left the in-progress tool timing open");
    if (d.session?.status !== "succeeded" && !d.events.some((e) => e.id > active.eventId && e.kind === "system" && e.system_is_error && /restart|stalled|failed|error/i.test(e.content))) {
      throw new Error(`interrupted turn ended ${d.session?.status} without a new visible explanation`);
    }
    await continueTurn("after mid-turn restart");
    return `observed running tool ${active.toolRowId} before kill; turn ended "${d.session?.status}"`;
  });

  await scenario("6. restart everything at once", async () => {
    await Promise.all([stop(dev), stop(pilot)]);
    startPilot();
    await waitPilot();
    startDev();
    await waitDev();
    await continueTurn("after full restart");
  });

  await scenario("7. one session, transcript intact", async () => {
    const list = await act<{ sessions: Session[] }>("listSessions", { limit: 50 });
    const mine = list.sessions.filter((s) => s.id.startsWith("restart-test-"));
    if (mine.length !== 1) throw new Error(`expected 1 app session, found ${mine.length}`);
    const d = await detail();
    const userTurns = d.events.filter((e) => e.kind === "user").length;
    // Tool timers must all have stopped, including tools cut off by a restart.
    const stillRunning = d.events.filter((e) => e.kind === "tool" && e.started_at && !e.finished_at).length;
    if (stillRunning > 0) throw new Error(`${stillRunning} tool row(s) still timing after every turn ended`);
    const timed = d.events.filter((e) => e.kind === "tool" && e.started_at).length;
    return `${d.events.length} events, ${userTurns} user turns, ${timed} timed tool rows`;
  });

  await scenario("8. create while pilot down, restart app, recover original prompt once", async () => {
    const offlineId = `${SESSION_ID}-offline`;
    const workspaceRoot = testWorkspaceRoot(offlineId, home);
    await stop(pilot);
    const created = await act<{ ok: boolean; start_status: string }>("createSession", {
      session_id: offlineId,
      title: "Pip",
      prompt: prompt("quick"),
      workspaceRoot,
      });
    if (!created.ok || created.start_status !== "waiting") throw new Error(`expected a durable waiting agent, got ${JSON.stringify(created)}`);
    await stop(dev);
    startDev();
    await waitDev();
    const waiting = await act<Detail>("getSession", { id: offlineId });
    if (waiting.session?.status !== "queued") throw new Error("the queued prompt did not survive an app restart");
    startPilot();
    await waitPilot();
    const d = await waitFor("queued first turn to finish", async () => {
      await act("recoverPendingAgents", {});
      const state = await act<Detail>("getSession", { id: offlineId });
      if (state.session?.status === "failed") throw new Error(state.session.summary ?? "agent failed to start");
      if (!state.session?.pilot_session_id) return null;
      await act("syncPilotEvents", { session_id: offlineId });
      const updated = await act<Detail>("getSession", { id: offlineId });
      return updated.session?.status === "succeeded" ? updated : null;
    }, TURN_TIMEOUT_MS);
    const users = d.events.filter((event) => event.kind === "user").length;
    if (users !== 1) throw new Error(`expected exactly one user prompt, got ${users}`);
    const pilotList = await (await fetch(`${PILOT_URL}/sessions`)).json() as Array<{ sessionId: string }>;
    if (pilotList.length !== 2) throw new Error(`expected 2 pilot sessions, got ${pilotList.length}`);
    return `first turn succeeded once after both services restarted (${d.events.length} events)`;
  });

  await scenario("9. lost create response attaches to the same pilot session", async () => {
    const id = `${SESSION_ID}-lost-reply`;
    const workspaceRoot = testWorkspaceRoot(id, home);
    await stop(pilot);
    const created = await act<{ ok: boolean; start_status: string }>("createSession", {
      session_id: id, title: "Nova", prompt: prompt("quick"), workspaceRoot,
    });
    if (!created.ok || created.start_status !== "waiting") throw new Error(`expected a queued first prompt, got ${JSON.stringify(created)}`);
    startPilot();
    await waitPilot();
    // Simulate a create admitted by the pilot whose HTTP response was lost
    // before the app could store the pilot id. The worker's later retry must
    // return the original pilot session/turn, not create a second one.
    const first = await (await fetch(`${PILOT_URL}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nova", name: "Nova", prompt: prompt("quick"),
        workspaceName: id, workspaceRoot, reasoningEffort: "low" }),
    })).json() as { sessionId: string; turnId: string | null };
    if (!first.turnId) throw new Error("pilot did not admit the first turn");
    await waitFor("the pilot's admitted turn to settle", async () => {
      const poll = await (await fetch(`${PILOT_URL}/sessions/${encodeURIComponent(first.sessionId)}/poll?since=0`)).json() as
        { events: Array<{ type: string }> };
      return poll.events.some((event) => event.type === "turn_completed") ? true : null;
    }, TURN_TIMEOUT_MS);
    // The pilot also crashes before the app has learned its id: the mapping
    // and the accepted first turn must survive in the pilot registry.
    await stop(pilot, "SIGKILL");
    startPilot();
    await waitPilot();
    const d = await waitFor("lost-reply turn to finish", async () => {
      await act("recoverPendingAgents", {});
      const state = await act<Detail>("getSession", { id });
      if (state.session?.status === "failed") throw new Error(state.session.summary ?? "agent failed");
      if (!state.session?.pilot_session_id) return null;
      await act("syncPilotEvents", { session_id: id });
      const updated = await act<Detail>("getSession", { id });
      return updated.session?.status === "succeeded" ? updated : null;
    }, TURN_TIMEOUT_MS);
    if (d.session?.pilot_session_id !== first.sessionId) throw new Error("app attached to a duplicate pilot session");
    const pilotList = await (await fetch(`${PILOT_URL}/sessions`)).json() as Array<{ sessionId: string }>;
    if (pilotList.length !== 3) throw new Error(`expected 3 pilot sessions, got ${pilotList.length}`);
    const userTurns = d.events.filter((event) => event.kind === "user").length;
    if (userTurns !== 1) throw new Error(`expected one user prompt, got ${userTurns}`);
    return `app attached to pilot session ${first.sessionId} without duplicating the prompt`;
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  log(`setup failed: ${String(error)}`);
  exitCode = 1;
} finally {
  await Promise.all([stop(dev), stop(pilot)]);
  console.log("\nRestart test results:");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  if (results.some((r) => !r.ok) || results.length === 0) exitCode = 1;
  console.log(`\nLogs: ${TMP}/pilot.log, ${TMP}/dev.log`);
  for (const [id, { path, home }] of realWorkspaces) {
    const token = createHash("sha256").update(id).digest("hex").slice(0, 12);
    if (path === `${home}/workspace/code/${token}`) rmSync(path, { recursive: true, force: true });
  }
  if (!KEEP && exitCode === 0) rmSync(TMP, { recursive: true, force: true });
  else console.log(`State kept in ${TMP}`);
  process.exit(exitCode);
}

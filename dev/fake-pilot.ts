import { existsSync, readFileSync, writeFileSync } from "node:fs";
// Real terminals (same module as the pilot): only the agent is fake.
import { createTerminalManager, handleTerminalRoute, terminalErrorStatus } from "../pilot/terminals.mjs";
import { validateAssistantAvatar } from "../pilot/assistant-avatar.mjs";

// Fake pilot for local UI/action testing — no muse, no VM, no credentials.
//
//   bun run dev:fake-pilot          # 127.0.0.1:18792
//   MUSE_CODE_SPACE_PILOT_URL=http://127.0.0.1:18792 bun run dev
//
// Speaks the subset of the real pilot's HTTP API (pilot/pilot.mjs) that
// server/src/actions.ts calls, and plays a short scripted turn for every
// prompt: userMessage → toolCall (inProgress → completed) → agentMessage →
// turn_completed, a few hundred ms apart. Prompt keywords change the script:
//   "fail"   → turn_error instead of an answer
//   "slow"   → 10s between steps (exercise spinners / interrupt)
//   "ask"    → a user_input request the UI must answer before the turn ends
//   "receive-message" → an incoming message from Pip (Juno when testing as Pip)
//   "workflow" → like the real pilot: a workflow launches, the turn ends while
//              it runs, its two child agents progress in the background, and
//              Muse then starts a turn on its own (host_turn_started) with
//              the combined answer. Cancel/result routes work on it.
// The response shapes mirror pilot.mjs; when the real pilot's API changes,
// update this file too. It is a test double, not a reference.

const PORT = Number(process.env.MUSE_CODE_SPACE_FAKE_PILOT_PORT ?? 18792);
// Pretend to run on another machine: reported as /health `home` (the dev
// server builds workspace paths from it). Unset = no `home`, i.e. the VM default.
const HOME = process.env.MUSE_CODE_SPACE_FAKE_PILOT_HOME;
// MUSE_CODE_SPACE_FAKE_PILOT_STATE=<file>: persist sessions + event history
// (like the real pilot's registry and transcripts) so restarts can be
// tested. A turn running when the process dies is lost, as in a real crash.
const STATE_FILE = process.env.MUSE_CODE_SPACE_FAKE_PILOT_STATE;
// MUSE_CODE_SPACE_FAKE_PILOT_ADMIT_DELAY_MS=<ms>: hold starts/turns
// before admitting the turn — a slow pilot, to test the UI's "Sending" state.
const ADMIT_DELAY_MS = Number(process.env.MUSE_CODE_SPACE_FAKE_PILOT_ADMIT_DELAY_MS ?? 0);

type Event = { seq: number; type: string; at: string; [key: string]: unknown };
type PendingInput = {
  userInputId: string;
  turnId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    selection: { mode: string; minSelections: number; maxSelections: number };
    options: Array<{ label: string; description?: string }>;
  }>;
  resolve: (answer: string) => void;
};
type Session = {
  id: string;
  title: string;
  /** Muse's name for the agent (session/rename); kept as given here. */
  name?: string;
  workspaceRoot?: string;
  appSessionId?: string;
  initialTurnId?: string | null;
  modelId: string;
  events: Event[];
  openTurn: string | null;
  cancel: (() => void) | null;
  inputs: Map<string, PendingInput>;
};

// Match the real pilot's entitlement-filtered catalog. Restart with `spark`
// or `wonder` to exercise upgrades and partial access; `full` exposes both.
const MODEL_ACCESS = process.env.MUSE_CODE_SPACE_FAKE_PILOT_MODEL_ACCESS ?? "full";
if (!["spark", "wonder", "full"].includes(MODEL_ACCESS)) {
  throw new Error("MUSE_CODE_SPACE_FAKE_PILOT_MODEL_ACCESS must be spark, wonder, or full.");
}
const MODELS = [
  { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3 (fake)" },
  // Default deliberately not first, like the real pilot's isDefault rule.
  { modelId: "muse-fake-fast", displayLabel: "Fake Fast", isDefault: true },
  ...(MODEL_ACCESS !== "spark" ? [{ modelId: "muse-wonder-1.0", displayLabel: "Muse Wonder 1.0" }] : []),
  ...(MODEL_ACCESS === "full" ? [{ modelId: "muse-wonder-full-1.0", displayLabel: "Muse Wonder Full 1.0" }] : []),
];

let seq = 0;
const sessions = new Map<string, Session>();
const toolOutputs = new Map<string, string>();
const museInbox: Array<{ seq: number; messageId: string; at: string; from: unknown; text: string }> = [];
// The user's Muse assistant (like the real pilot: default Jolly, Muse blue).
const assistant = { name: "Jolly", color: "#d0e4fc", avatar_data_url: null as string | null };
const isReserved = (name: unknown) => ["muse", "jolly", assistant.name.toLowerCase()].includes(String(name ?? "").trim().replace(/^@/, "").toLowerCase());
loadState();
const wire: Array<{ at: string; dir: string; method: string; ms?: number; ok?: boolean; params?: string }> = [];

function saveState() {
  if (!STATE_FILE) return;
  const data = { seq, assistant, toolOutputs: [...toolOutputs], sessions: [...sessions.values()].map(({ id, title, name, workspaceRoot, appSessionId, initialTurnId, modelId, events }) => ({ id, title, name, workspaceRoot, appSessionId, initialTurnId, modelId, events })) };
  writeFileSync(STATE_FILE, JSON.stringify(data));
}
function loadState() {
  if (!STATE_FILE || !existsSync(STATE_FILE)) return;
  const data = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { seq: number; assistant?: typeof assistant; toolOutputs?: Array<[string, string]>; sessions: Array<Pick<Session, "id" | "title" | "name" | "workspaceRoot" | "appSessionId" | "initialTurnId" | "modelId" | "events">> };
  seq = data.seq;
  if (data.assistant) {
    assistant.name = data.assistant.name;
    assistant.color = data.assistant.color;
    assistant.avatar_data_url = data.assistant.avatar_data_url != null && !validateAssistantAvatar(data.assistant.avatar_data_url)
      ? data.assistant.avatar_data_url : null;
  }
  for (const [id, output] of data.toolOutputs ?? []) toolOutputs.set(id, output);
  for (const saved of data.sessions) {
    sessions.set(saved.id, { ...saved, openTurn: null, cancel: null, inputs: new Map() });
  }
  console.log(`[fake-pilot] restored ${sessions.size} sessions from ${STATE_FILE}`);
}

function push(session: Session, type: string, extra: Record<string, unknown> = {}) {
  session.events.push({ seq: ++seq, type, at: new Date().toISOString(), ...extra });
  saveState();
}
function logWire(method: string, params?: unknown) {
  wire.push({ at: new Date().toISOString(), dir: "→", method, ok: true, params: params ? JSON.stringify(params).slice(0, 300) : undefined });
  if (wire.length > 200) wire.shift();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Background workflows: runId -> timers + state (so cancel can stop them).
const workflows = new Map<string, { sessionId: string; timers: Timer[]; itemId: string; cancelled: boolean }>();

function startFakeWorkflow(session: Session, turnId: string) {
  const runId = `workflow-run-${crypto.randomUUID()}`;
  const itemId = crypto.randomUUID();
  const wf = { sessionId: session.id, timers: [] as Timer[], itemId, cancelled: false };
  workflows.set(runId, wf);
  const item = (status: string, children: unknown[], message?: string) => ({
    kind: "workflow", itemId, turnId, status, workflowRunId: runId, entryId: "Alpha Beta parallel",
    recordedAt: new Date().toISOString(), children, ...(message ? { message } : {}),
  });
  push(session, "item", { item: item("inProgress", []) });
  const later = (ms: number, run: () => void) => wf.timers.push(setTimeout(() => { if (!wf.cancelled) run(); }, ms));
  later(1500, () => push(session, "item", { item: item("inProgress", [
    // Like muse 1.4: a child is named only on its first ("scheduled") update.
    { childId: "child-alpha", attempt: 1, label: "alpha", status: "scheduled" },
    { childId: "child-beta", attempt: 1, label: "beta", status: "scheduled" },
  ]) }));
  later(2200, () => push(session, "item", { item: item("inProgress", [
    { childId: "child-alpha", attempt: 1, status: "started" },
    { childId: "child-beta", attempt: 1, status: "usage" },
  ]) }));
  later(3000, () => push(session, "item", { item: item("inProgress", [
    { childId: "child-alpha", attempt: 1, status: "terminal", terminal: "completed", durationMs: 1400 },
    { childId: "child-beta", attempt: 1, status: "started" },
  ]) }));
  later(4500, () => {
    const envelope = `<workflow-launch-reconciled>${JSON.stringify({ type: "workflow_launch_reconciled", final_summary: { status: "completed", summary: "ALPHA\nBETA" }, latest_failure: null })}</workflow-launch-reconciled>`;
    push(session, "item", { item: item("completed", [
      { childId: "child-alpha", attempt: 1, status: "terminal", terminal: "completed", durationMs: 1400 },
      { childId: "child-beta", attempt: 1, status: "terminal", terminal: "completed", durationMs: 2900 },
    ], envelope) });
    // Muse delivers the results by starting a turn itself.
    const hostTurn = crypto.randomUUID();
    session.openTurn = hostTurn;
    push(session, "host_turn_started", { turnId: hostTurn });
    wf.timers.push(setTimeout(() => {
      push(session, "item", { item: { kind: "agentMessage", status: "completed", text: "Both agents replied: **ALPHA BETA**" } });
      push(session, "turn_completed", { turnId: hostTurn, outcome: { status: "completed" } });
      if (session.openTurn === hostTurn) session.openTurn = null;
    }, 800));
  });
  return runId;
}

async function runTurn(session: Session, text: string) {
  const turnId = crypto.randomUUID();
  session.openTurn = turnId;
  let cancelled = false;
  session.cancel = () => {
    cancelled = true;
  };
  const slowStepMs = Math.max(250, Number(process.env.MUSE_CODE_SPACE_FAKE_PILOT_SLOW_STEP_MS) || 10_000);
  const step = /\bslow\b/i.test(text) ? slowStepMs : 400;
  logWire("turn/start", { sessionId: session.id, text: text.slice(0, 80) });

  void (async () => {
    // Like the real pilot: both revisions of a tool call share its itemId and
    // carry recordedAt, which the app uses for the tool row's run time.
    const toolItemId = crypto.randomUUID();
    const outputRefId = `output-${toolItemId}`;
    const patchRefId = `patch-${toolItemId}`;
    const editDiff = /\bedit-diff\b/i.test(text);
    const readTool = /\bread-(?:ts-)?tool\b/i.test(text);
    const readTsTool = /\bread-ts-tool\b/i.test(text);
    const writeTool = /\bwrite-(?:ts-)?tool\b/i.test(text);
    const writeTsTool = /\bwrite-ts-tool\b/i.test(text);
    const tsWriteContent = "const x: number = 3;\n";
    const jsonTool = /\bjson-tool\b/i.test(text);
    const listAgentsTool = /\blist-agents-tool\b/i.test(text);
    const sendMessageTool = /\bsend-message-(?:tool|fail)\b/i.test(text);
    const sendMessageFail = /\bsend-message-fail\b/i.test(text);
    const receiveMessage = /\breceive-message\b/i.test(text);
    const searchTool = /\bsearch-(?:tool|empty|bad)\b/i.test(text);
    const searchEmpty = /\bsearch-empty\b/i.test(text);
    const searchBad = /\bsearch-bad\b/i.test(text);
    const bashNonzero = /\bbash-nonzero\b/i.test(text);
    const longOutput = /\blong[ -]tool\b/i.test(text);
    const patchJson = editDiff ? readFileSync(new URL("./fixtures/edit-patch.json", import.meta.url), "utf8") : "";
    const fullOutput = editDiff ? "Applied patch to test.rs"
      : readTool ? (readTsTool ? "Read text file `alpha.ts`.\n1|const x: number = 3;\n2|console.log(x)" : "Read text file `test.rs`.\n1|ALPHA\n2|BETA\n3|GAMMA")
      : writeTool ? (writeTsTool ? `wrote ${Buffer.byteLength(tsWriteContent)} bytes to alpha.ts` : "wrote 17 bytes to test.rs")
      : listAgentsTool ? `You are "${session.name ?? "milo"}". You can message:\n- juno\n- pip (busy)\n- ${assistant.name} — your Muse assistant`
      : sendMessageTool ? (sendMessageFail ? "Not delivered: offline" : "Delivered to pip.")
      : searchTool ? (searchBad ? "future search format" : searchEmpty ? "" : "alpha.txt-1-ALPHA before\nalpha.txt:2:MCS_SEARCH_PROBE first\nalpha.txt-3-ALPHA after\nbeta.txt-1-BETA before\nbeta.txt:2:MCS_SEARCH_PROBE second\nbeta.txt-3-BETA after")
      : jsonTool ? JSON.stringify({ ok: true, files: ["test.rs"], count: 2, nested: { ready: false } })
      : longOutput ? Array.from({ length: 35 }, (_, index) => `Tool output line ${index + 1}: ${"data ".repeat(6)}`).join("\n")
      : bashNonzero ? "PROBE_OUTPUT" : "hello\nfrom fake tool";
    toolOutputs.set(outputRefId, fullOutput);
    if (editDiff) toolOutputs.set(patchRefId, patchJson);
    const visibleOutput = longOutput ? fullOutput.split("\n").slice(0, 18).join("\n") : fullOutput;
    const toolItem = (status: string, patchReady = false) => ({
      kind: "toolCall", itemId: toolItemId, tool: editDiff ? "edit_file" : readTool ? "read_file" : writeTool ? "write_file" : listAgentsTool ? "mcp__code_space__list_agents" : sendMessageTool ? "mcp__code_space__send_message" : searchTool ? "search" : jsonTool ? "mystery" : "bash", status,
      recordedAt: new Date().toISOString(), args: JSON.stringify(editDiff ? { path: "test.rs", find: "OLD", replace: "NEW" } : readTool ? { path: readTsTool ? "alpha.ts" : "test.rs" } : writeTool ? (writeTsTool ? { path: "alpha.ts", content: tsWriteContent } : { path: "test.rs", content: "ALPHA\nBETA\nGAMMA\n" }) : listAgentsTool ? {} : sendMessageTool ? { to: "pip", text: "Please run tests" } : searchTool ? { pattern: "MCS_SEARCH_PROBE", paths: ["."], output_mode: "text", context_before: 1, context_after: 1 } : jsonTool ? { query: "test" } : bashNonzero ? { command: "printf PROBE_OUTPUT; exit 7", description: "Check a failing command" } : { command: "echo hello" }),
      ...(status === "failed" ? { failureReason: "process exited with status 7" } : {}),
      ...(editDiff && (patchReady || status === "completed") ? {
        patchRef: { id: patchRefId, kind: "tool_patch", byteLen: Buffer.byteLength(patchJson), availability: "available", mediaType: "application/json" },
        patchSummary: { files: 1, added: 2, removed: 1 },
      } : {}),
      ...(status !== "inProgress" ? {
        visibleOutput, truncated: longOutput,
        outputRef: { id: outputRefId, byteLen: Buffer.byteLength(fullOutput), availability: "available", mediaType: "text/plain" },
      } : {}),
    });
    const steps: Array<() => Promise<void> | void> = [
      () => push(session, "item", { item: { kind: "userMessage", text, status: "completed" } }),
      ...(receiveMessage ? [() => {
        // A transcript preview, independent of whether the sender has a task.
        const senderName = (session.name ?? session.title).trim().toLowerCase() === "pip" ? "juno" : "pip";
        const sender = [...sessions.values()].find((item) => item.name?.toLowerCase() === senderName);
        push(session, "agent_message", {
          direction: "in", messageId: crypto.randomUUID(),
          from: { kind: "agent", name: senderName, sessionId: sender?.id ?? null },
          to: { kind: "agent", name: session.name ?? session.title, sessionId: session.id },
          text: "Could you review my changes and run the tests?", queued: false,
        });
      }] : []),
      () => push(session, "item", { item: toolItem("inProgress") }),
      ...(editDiff ? [() => push(session, "item", { item: toolItem("inProgress", true) })] : []),
      ...(sendMessageTool ? [() => push(session, "agent_message", {
        direction: "out", messageId: crypto.randomUUID(),
        from: { kind: "agent", name: session.name ?? session.title, sessionId: session.id },
        to: { kind: "agent", name: "pip", sessionId: "fake-pip" }, text: "Please run tests", queued: false,
      })] : []),
      () => push(session, "item", { item: toolItem(bashNonzero ? "failed" : "completed") }),
    ];
    if (/\bthinking\b/i.test(text)) {
      const reasoningId = crypto.randomUUID();
      const reasoning = (status: string, summary: string[]) => ({
        kind: "reasoning", itemId: reasoningId, status, summary,
        // Deliberately never display/store raw reasoning.text in the app.
        text: "PRIVATE_RAW_REASONING_MUST_NOT_BE_SHOWN",
        recordedAt: new Date().toISOString(),
      });
      steps.splice(1, 0,
        () => push(session, "item", { item: reasoning("inProgress", []) }),
        () => push(session, "item", { item: reasoning("inProgress", ["Checking the project structure…"]) }),
        () => push(session, "item", { item: reasoning("completed", ["Checking the project structure…", "The next step is to run the tests."]) }),
      );
    }
    if (/\bask\b/i.test(text)) {
      steps.push(async () => {
        const userInputId = crypto.randomUUID();
        const answer = await new Promise<string>((resolve) => {
          const input: PendingInput = {
            userInputId,
            turnId,
            questions: [{
              id: "q1",
              header: "Pick one",
              question: "Which option should the fake agent use?",
              selection: { mode: "single", minSelections: 1, maxSelections: 1 },
              options: [{ label: "Option A" }, { label: "Option B", description: "the other one" }],
            }],
            resolve,
          };
          session.inputs.set(userInputId, input);
          push(session, "user_input_requested", { userInputId, questions: input.questions });
        });
        push(session, "user_input_answered", { userInputId });
        push(session, "item", { item: { kind: "agentMessage", status: "completed", text: `You picked: ${answer}` } });
      });
    }
    if (/\bworkflow\b/i.test(text)) {
      steps.push(() => push(session, "item", { item: { kind: "toolCall", itemId: crypto.randomUUID(), tool: "workflow", status: "completed", recordedAt: new Date().toISOString(), args: JSON.stringify({ name: "Alpha Beta parallel" }) } }));
      steps.push(() => { startFakeWorkflow(session, turnId); });
      steps.push(() => push(session, "item", { item: { kind: "agentMessage", status: "completed", text: "Launched a workflow with two agents; results will follow." } }));
      steps.push(() => push(session, "turn_completed", { turnId, outcome: { status: "completed" } }));
    } else if (/\bfail\b/i.test(text)) {
      steps.push(() => push(session, "turn_error", { error: "Fake pilot: simulated model failure." }));
    } else {
      steps.push(() =>
        push(session, "item", {
          item: { kind: "agentMessage", status: "completed", text: `**FAKE-OK** — echo of your prompt:\n\n> ${text.slice(0, 500)}` },
        }),
      );
      steps.push(() => push(session, "turn_completed", { turnId, outcome: { status: "completed" } }));
    }
    for (const run of steps) {
      if (cancelled) {
        push(session, "turn_completed", { turnId, cancelled: true, outcome: { status: "cancelled" } });
        break;
      }
      await sleep(step);
      if (cancelled) continue;
      await run();
    }
    if (session.openTurn === turnId) {
      session.openTurn = null;
      session.cancel = null;
    }
  })();
  return turnId;
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const terminals = createTerminalManager({ log: (...args: unknown[]) => console.log("[fake-pilot]", ...args) });

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (path === "/health") return json(200, { ok: true, fake: true, sessions: sessions.size, terminals: terminals.size(), relay: "up", ...(HOME ? { home: HOME } : {}) });
    if (path === "/terminals" || path.startsWith("/terminals/")) {
      let response: Response | null = null;
      try {
        await handleTerminalRoute(terminals, req.method, path, url, body, (status: number, obj: unknown) => {
          response = json(status, obj);
        });
      } catch (error) {
        const e = error as { message?: string; code?: string };
        return json(terminalErrorStatus(error), { error: String(e.message ?? error), code: e.code ?? "terminal_error" });
      }
      if (response) return response;
    }
    if (path === "/models") return json(200, { models: MODELS, profileId: null, providerId: "fake", source: "fake" });
    if (path === "/debug/wire") {
      if (req.method === "POST" && body.clear) wire.length = 0;
      return json(200, { enabled: true, entries: wire.slice(-100) });
    }
    if (path === "/debug/relay" && req.method === "GET") {
      return json(200, { enabled: true, status: "up", startedAt: "2026-10-07T11:59:00.000Z", lastSuccessAt: "2026-10-07T12:00:00.000Z", lastFailureAt: "2026-10-07T12:00:01.000Z", error: null,
        entries: [
          { id: 1, at: "2026-10-07T12:00:00.000Z", method: "POST", path: "/v1/responses", status: 200, durationMs: 145, requestBytes: 72, responseBytes: 104, stage: "complete", errorType: null },
          { id: 2, at: "2026-10-07T12:00:01.000Z", method: "POST", path: "/v1/responses", status: 502, durationMs: 22, requestBytes: 72, responseBytes: 0, stage: "proxy", errorType: "URLError" },
        ] });
    }
    const mToolOutput = path.match(/^\/sessions\/([^/]+)\/tools\/output$/);
    if (mToolOutput && req.method === "POST") {
      const session = sessions.get(decodeURIComponent(mToolOutput[1]!));
      const ref = typeof body.outputRef === "string" ? body.outputRef : "";
      const output = toolOutputs.get(ref);
      const belongs = session?.events.some((event) => {
        const item = event.item as { itemId?: string; outputRef?: { id?: string }; patchRef?: { id?: string } } | undefined;
        return item?.itemId === body.itemId && (item?.outputRef?.id === ref || item?.patchRef?.id === ref);
      });
      if (!belongs || output === undefined || !Number.isSafeInteger(body.offsetBytes) || body.offsetBytes < 0) {
        return json(404, { error: "tool output not found" });
      }
      const bytes = Buffer.from(output, "utf8");
      const chunk = bytes.subarray(body.offsetBytes, Math.min(bytes.length, body.offsetBytes + 256 * 1024));
      return json(200, { content: chunk.toString("utf8"), encoding: "utf8", byteLen: chunk.length,
        offsetBytes: body.offsetBytes, eof: body.offsetBytes + chunk.length >= bytes.length, mediaType: ref.startsWith("patch-") ? "application/json" : "text/plain" });
    }
    if (path === "/sessions" && req.method === "GET") {
      return json(200, [...sessions.values()].map((s) => ({ sessionId: s.id, title: s.title, name: s.name ?? null, modelId: s.modelId, status: s.openTurn ? "running" : "idle" })));
    }
    if (path === "/sessions" && req.method === "POST") {
      if (ADMIT_DELAY_MS > 0) await sleep(ADMIT_DELAY_MS);
      if (body.modelId && !MODELS.some((model) => model.modelId === body.modelId)) {
        return json(403, { error: "Model is not available.", code: "model_unavailable" });
      }
      const appSessionId = typeof body.workspaceName === "string" ? body.workspaceName : null;
      const existing = appSessionId ? [...sessions.values()].find((s) => s.appSessionId === appSessionId) : null;
      if (existing) {
        if (body.prompt && !existing.initialTurnId) {
          existing.initialTurnId = await runTurn(existing, String(body.prompt));
          saveState();
        }
        return json(200, { sessionId: existing.id, turnId: existing.initialTurnId ?? null, modelId: existing.modelId, name: existing.name ?? null });
      }
      const workspaceRoot = typeof body.workspaceRoot === "string" ? body.workspaceRoot : null;
      if (HOME && workspaceRoot && !workspaceRoot.startsWith(`${HOME}/`)) {
        return json(500, { error: `fake pilot: workspaceRoot ${workspaceRoot} is not under ${HOME}` });
      }
      const session: Session = {
        id: `fake-${crypto.randomUUID()}`,
        title: String(body.title ?? "untitled"),
        ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
        ...(typeof body.workspaceRoot === "string" ? { workspaceRoot: body.workspaceRoot } : {}),
        ...(appSessionId ? { appSessionId } : {}),
        initialTurnId: null,
        modelId: String(body.modelId || (MODELS.find((m) => m.isDefault) ?? MODELS[0]!).modelId),
        events: [],
        openTurn: null,
        cancel: null,
        inputs: new Map(),
      };
      sessions.set(session.id, session);
      push(session, "session_started", { meta: { title: session.title, modelId: session.modelId } });
      const turnId = body.prompt ? await runTurn(session, String(body.prompt)) : null;
      session.initialTurnId = turnId;
      saveState();
      return json(200, { sessionId: session.id, turnId, modelId: session.modelId, name: session.name ?? null });
    }

    // Agent-to-agent messages, like the real pilot (deliverAgentMessage).
    if (path === "/agents" && req.method === "GET") {
      return json(200, { agents: [...sessions.values()].filter((x) => x.name).map((x) => ({ name: x.name, sessionId: x.id, busy: !!x.openTurn, workspaceRoot: x.workspaceRoot ?? null })), assistant: { name: assistant.name, color: assistant.color } });
    }
    if (path === "/assistant") {
      if (req.method === "POST") {
        const next = { ...assistant };
        if (body.name !== undefined) {
          if (typeof body.name !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u.test(body.name.trim())) return json(400, { error: "name must be 1–40 letters, digits, spaces, - or _" });
          if ([...sessions.values()].some((item) => item.name?.toLowerCase() === body.name.trim().toLowerCase())) return json(400, { error: "an agent already has that name" });
          next.name = body.name.trim();
        }
        if (body.color !== undefined) {
          if (typeof body.color !== "string" || !/^#[0-9a-f]{6}$/i.test(body.color)) return json(400, { error: "color must be #rrggbb" });
          next.color = body.color.toLowerCase();
        }
        if (body.avatar_data_url !== undefined) {
          if (body.avatar_data_url !== null) {
            const error = validateAssistantAvatar(body.avatar_data_url);
            if (error) return json(400, { error });
          }
          next.avatar_data_url = body.avatar_data_url;
        }
        Object.assign(assistant, next);
        saveState();
      }
      return json(200, assistant);
    }
    if (path === "/messages/muse" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return json(200, { messages: museInbox.filter((m) => m.seq > since), latest: museInbox.at(-1)?.seq ?? since });
    }
    if (path === "/messages" && req.method === "POST") {
      const byName = (ref: string) => [...sessions.values()].find((x) => x.id === ref || x.name?.toLowerCase() === String(ref).replace(/^@/, "").toLowerCase());
      if (String(body.from ?? "").toLowerCase() !== "muse") {
        return json(403, { ok: false, code: "mcp_required", error: "agents must use the Code Space send_message MCP tool" });
      }
      const museRef = { kind: "muse", name: assistant.name, color: assistant.color, sessionId: null };
      const fromRef = museRef;
      const text = String(body.text ?? "").trim();
      if (!text) return json(400, { ok: false, code: "bad_request", error: "message text is empty" });
      const messageId = crypto.randomUUID();
      if (isReserved(body.to)) return json(400, { ok: false, code: "bad_request", error: "Muse can't message itself" });
      const target = byName(String(body.to));
      if (!target) return json(404, { ok: false, code: "unknown_agent", error: `no agent named "${body.to}"` });
      const toRef = { kind: "agent", name: target.name ?? target.id, sessionId: target.id };
      const queued = !!target.openTurn;
      push(target, "agent_message", { direction: "in", messageId, from: fromRef, to: toRef, text, queued });
      if (!target.openTurn) void runTurn(target, `Message from ${fromRef.name}: ${text}`);
      return json(200, { ok: true, messageId, to: toRef, queued });
    }

    const m = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
    if (!m) return json(404, { error: "not found" });
    if (req.method === "DELETE" && !m[2]) {
      const id = decodeURIComponent(m[1]!);
      const existing = sessions.get(id);
      if (existing?.openTurn) return json(409, { ok: false, code: "turn_running", error: "a turn is running; stop it before deleting the session" });
      sessions.delete(id);
      saveState();
      return json(200, { ok: true, sessionId: id, existed: !!existing });
    }
    const session = sessions.get(decodeURIComponent(m[1]!));
    if (!session) return json(404, { error: "unknown session", code: "unknown_session" });
    const sub = m[2] ?? "";

    if (sub === "/files/read" && req.method === "POST") {
      if (body.path === "alpha.ts") return json(200, { ok: true, path: "alpha.ts", content: "const x: number = 3;\nconsole.log(x)\n" });
      if (body.path === "test.rs") return json(200, { ok: true, path: "test.rs", content: "ALPHA\nBETA\nGAMMA\n" });
      if (body.path === "notes.unknown") return json(200, { ok: true, path: "notes.unknown", content: "const x = 3;\n" });
      return json(404, { error: "File not found in this agent's working directory." });
    }

    if (sub === "/poll") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return json(200, {
        events: session.events.filter((e) => e.seq > since),
        latestSeq: session.events.at(-1)?.seq ?? since,
        sessionId: session.id,
        backendSessionId: session.id,
        hasOpenTurn: session.openTurn !== null,
      });
    }
    if (sub === "/turns" && req.method === "POST") {
      if (ADMIT_DELAY_MS > 0) await sleep(ADMIT_DELAY_MS);
      if (session.openTurn) return json(409, { error: "turn already running" });
      const modelId = String(body.modelId ?? session.modelId);
      if (!MODELS.some((model) => model.modelId === modelId)) {
        return json(403, { error: "Model is not available.", code: "model_unavailable" });
      }
      const modelSwitched = modelId !== session.modelId;
      session.modelId = modelId;
      const turnId = await runTurn(session, String(body.text ?? ""));
      return json(200, { turnId, admitMs: 1, modelSwitched, modelId });
    }
    if (sub === "/turns/interrupt" && req.method === "POST") {
      const turnId = session.openTurn;
      session.cancel?.();
      return json(200, { ok: true, turnId });
    }
    if (sub === "/recover" && req.method === "POST") return json(200, { sessionId: session.id, recovered: false });
    if (sub === "/rename" && req.method === "POST") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return json(400, { error: "name required", code: "bad_request" });
      if (isReserved(name)) return json(409, { error: `"${name}" is reserved for the user's Muse assistant`, code: "reserved_name" });
      session.name = name;
      saveState();
      push(session, "name_changed", { name });
      return json(200, { name });
    }
    const agentRoute = sub.match(/^\/(workflows)\/([^/]+)\/(cancel)$/);
    if (agentRoute && req.method === "POST") {
      const target = decodeURIComponent(agentRoute[2]!);
      const wf = workflows.get(target);
      if (!wf) return json(409, { error: "unknown workflow run", code: "agent_control_rejected" });
      wf.cancelled = true;
      for (const timer of wf.timers) clearTimeout(timer);
      push(session, "item", { item: { kind: "workflow", itemId: wf.itemId, status: "cancelled", workflowRunId: target, entryId: "Alpha Beta parallel", recordedAt: new Date().toISOString(), message: "Cancelled by the user.", children: [
        { childId: "child-alpha", attempt: 1, label: "alpha", status: "cancelled" },
        { childId: "child-beta", attempt: 1, label: "beta", status: "cancelled" },
      ] } });
      return json(200, { ok: true });
    }
    if (sub === "/user-inputs" && req.method === "GET") {
      return json(200, {
        inputs: [...session.inputs.values()].map(({ resolve: _r, ...rest }) => ({ ...rest, autoResolutionMs: null })),
      });
    }
    if (sub === "/user-inputs/answer" && req.method === "POST") {
      const input = session.inputs.get(String(body.userInputId));
      if (!input) return json(404, { error: "unknown user input" });
      session.inputs.delete(input.userInputId);
      const answers = (body.answers ?? []) as Array<{ selectedLabel?: string; selectedLabels?: string[]; freeText?: string }>;
      const first = answers[0];
      input.resolve(first?.selectedLabel || first?.selectedLabels?.join(", ") || first?.freeText || "(no answer)");
      return json(200, { ok: true, userInputId: input.userInputId });
    }
    if (sub === "/user-inputs/cancel" && req.method === "POST") {
      const input = session.inputs.get(String(body.userInputId));
      if (input) {
        session.inputs.delete(input.userInputId);
        input.resolve("(cancelled)");
      }
      return json(200, { ok: true, userInputId: String(body.userInputId) });
    }
    return json(404, { error: `fake pilot: no route ${req.method} ${path}` });
  },
});

console.log(`[fake-pilot] listening on http://127.0.0.1:${PORT}`);

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
//   "long-transcript [N] [live]" (or "benchmark [N] [live]") → generates a
//              realistic N-item transcript (default 200, up to 1500) covering
//              reasoning, TS/Py/CSS/Rust file reads & writes, structured edit
//              patches, multi-file searches, bash runs, peer/assistant messages,
//              workflows, and rich Markdown replies. Add "live" (or "stream")
//              to stream the tail steps over time after the bulk history lands.
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
const sessionFiles = new Map<string, Map<string, string>>();
const museInbox: Array<{ seq: number; messageId: string; at: string; from: unknown; text: string }> = [];
// The user's Muse assistant (like the real pilot: default Jolly, Muse blue).
const assistant = { name: "Jolly", color: "#d0e4fc", avatar_data_url: null as string | null };
const isReserved = (name: unknown) => ["muse", "jolly", assistant.name.toLowerCase()].includes(String(name ?? "").trim().replace(/^@/, "").toLowerCase());
loadState();
const wire: Array<{ at: string; dir: string; method: string; ms?: number; ok?: boolean; params?: string }> = [];

function saveState() {
  if (!STATE_FILE) return;
  const serializedFiles = [...sessionFiles.entries()].map(([id, map]) => [id, [...map.entries()]] as const);
  const data = { seq, assistant, toolOutputs: [...toolOutputs], sessionFiles: serializedFiles, sessions: [...sessions.values()].map(({ id, title, name, workspaceRoot, appSessionId, initialTurnId, modelId, events }) => ({ id, title, name, workspaceRoot, appSessionId, initialTurnId, modelId, events })) };
  writeFileSync(STATE_FILE, JSON.stringify(data));
}
function loadState() {
  if (!STATE_FILE || !existsSync(STATE_FILE)) return;
  const data = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { seq: number; assistant?: typeof assistant; toolOutputs?: Array<[string, string]>; sessionFiles?: Array<[string, Array<[string, string]>]>; sessions: Array<Pick<Session, "id" | "title" | "name" | "workspaceRoot" | "appSessionId" | "initialTurnId" | "modelId" | "events">> };
  seq = data.seq;
  if (data.assistant) {
    assistant.name = data.assistant.name;
    assistant.color = data.assistant.color;
    assistant.avatar_data_url = data.assistant.avatar_data_url != null && !validateAssistantAvatar(data.assistant.avatar_data_url)
      ? data.assistant.avatar_data_url : null;
  }
  for (const [id, output] of data.toolOutputs ?? []) toolOutputs.set(id, output);
  for (const [id, entries] of data.sessionFiles ?? []) sessionFiles.set(id, new Map(entries));
  for (const saved of data.sessions) {
    sessions.set(saved.id, { ...saved, openTurn: null, cancel: null, inputs: new Map() });
  }
  console.log(`[fake-pilot] restored ${sessions.size} sessions from ${STATE_FILE}`);
}

function push(session: Session, type: string, extra: Record<string, unknown> = {}, save = true) {
  session.events.push({ seq: ++seq, type, at: new Date().toISOString(), ...extra });
  if (save) saveState();
}
function logWire(method: string, params?: unknown) {
  wire.push({ at: new Date().toISOString(), dir: "→", method, ok: true, params: params ? JSON.stringify(params).slice(0, 300) : undefined });
  if (wire.length > 200) wire.shift();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Background workflows: runId -> timers + state (so cancel can stop them).
const workflows = new Map<string, { sessionId: string; timers: Timer[]; itemId: string; cancelled: boolean }>();

// Simulated PR monitoring ("pr-monitor" prompt keyword): the github_monitor_pr
// tool call starts it, then pr_monitor events update the transcript row —
// CI fails (with the monitor's injected turn), then the PR merges. Mirrors
// pilot/prMonitor.mjs payloads so the UI row can be exercised locally.
function startFakePrMonitor(session: Session) {
  const monitorId = crypto.randomUUID();
  const base = {
    id: monitorId, owner: "dreveman", repo: "muse-code-space", number: 6,
    title: "Number terminal tabs only when there is more than one",
    url: "https://github.com/dreveman/muse-code-space/pull/6",
    approvals: 0, comments: 1,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const emit = (monitor: Record<string, unknown>) => push(session, "pr_monitor", { monitor });
  const monitorTurn = (text: string, reply: string) => {
    const hostTurn = crypto.randomUUID();
    session.openTurn = hostTurn;
    push(session, "host_turn_started", { turnId: hostTurn });
    push(session, "item", { item: { kind: "userMessage", text, status: "completed" } });
    push(session, "item", { item: { kind: "agentMessage", status: "completed", text: reply } });
    push(session, "turn_completed", { turnId: hostTurn, outcome: { status: "completed" } });
    if (session.openTurn === hostTurn) session.openTurn = null;
  };
  emit({ ...base, status: "monitoring", checks: { passed: 2, failed: 0, pending: 1, failing: [] }, changes: [] });
  setTimeout(() => {
    emit({ ...base, status: "monitoring", checks: { passed: 2, failed: 1, pending: 0, failing: ["typecheck"] },
      changes: [{ at: new Date().toISOString(), text: "CI check failed: typecheck" }] });
    monitorTurn("[GitHub PR monitor] dreveman/muse-code-space#6: CI check failed: typecheck. https://github.com/dreveman/muse-code-space/pull/6",
      "I see the typecheck failure — taking a look now.");
  }, 3000);
  setTimeout(() => {
    emit({ ...base, status: "merged", checks: { passed: 3, failed: 0, pending: 0, failing: [] },
      changes: [
        { at: new Date().toISOString(), text: "CI check failed: typecheck" },
        { at: new Date().toISOString(), text: "All checks passed (3 checks)" },
        { at: new Date().toISOString(), text: "PR was merged" },
      ] });
    monitorTurn("[GitHub PR monitor] dreveman/muse-code-space#6: PR was merged. https://github.com/dreveman/muse-code-space/pull/6",
      "All done — PR #6 is merged and monitoring has ended.");
  }, 6500);
}

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

const SAMPLE_TS_LINES = [
  'import { useEffect, useMemo, useRef, useState } from "react";',
  'import type { Session, TranscriptEvent } from "./types";',
  "",
  "export interface TranscriptWindowProps {",
  "  session: Session;",
  "  events: readonly TranscriptEvent[];",
  "  showReasoning: boolean;",
  "  expandTools: boolean;",
  "  onSelectEvent?: (id: number) => void;",
  "}",
  "",
  "const DEFAULT_WINDOW_SIZE = 120;",
  "const OVERSCAN_ROWS = 16;",
  "",
  "export function computeVisibleSlice(total: number, scrollTop: number, rowHeight: number) {",
  "  const start = Math.max(0, Math.floor(scrollTop / Math.max(1, rowHeight)) - OVERSCAN_ROWS);",
  "  const end = Math.min(total, start + DEFAULT_WINDOW_SIZE + OVERSCAN_ROWS * 2);",
  "  return { start, end, hiddenAbove: start, hiddenBelow: Math.max(0, total - end) };",
  "}",
  "",
  "export function summarizeDurations(events: readonly TranscriptEvent[]): Map<string, number> {",
  "  const totals = new Map<string, number>();",
  "  for (const event of events) {",
  '    if (event.kind !== "tool" || !event.startedAt || !event.finishedAt) continue;',
  "    const elapsed = Math.max(0, Date.parse(event.finishedAt) - Date.parse(event.startedAt));",
  '    const toolName = event.content.split("·")[0]?.trim() || "tool";',
  "    totals.set(toolName, (totals.get(toolName) ?? 0) + elapsed);",
  "  }",
  "  return totals;",
  "}",
  "",
  "export function formatBytes(bytes: number): string {",
  '  if (bytes < 1024) return `${bytes} B`;',
  '  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;',
  '  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;',
  "}",
];

const SAMPLE_PY_LINES = [
  "from __future__ import annotations",
  "import dataclasses",
  "import json",
  "import time",
  "from typing import Iterable",
  "",
  "@dataclasses.dataclass(frozen=True)",
  "class RelayMetric:",
  "    method: str",
  "    path: str",
  "    status: int",
  "    duration_ms: float",
  "    request_bytes: int",
  "    response_bytes: int",
  "",
  "def summarize_metrics(entries: Iterable[RelayMetric]) -> dict[str, object]:",
  "    items = list(entries)",
  "    if not items:",
  '        return {"count": 0, "p50_ms": 0.0, "p95_ms": 0.0, "errors": 0}',
  "    durations = sorted(item.duration_ms for item in items)",
  "    errors = sum(1 for item in items if item.status >= 400)",
  "    p50 = durations[len(durations) // 2]",
  "    p95 = durations[min(len(durations) - 1, int(len(durations) * 0.95))]",
  '    return {"count": len(items), "p50_ms": round(p50, 2), "p95_ms": round(p95, 2), "errors": errors}',
];

const SAMPLE_CSS_LINES = [
  ".transcript-stream {",
  "  display: flex;",
  "  flex-direction: column;",
  "  gap: 0.75rem;",
  "  padding: 1rem 1.25rem 2.5rem;",
  "  contain: layout style;",
  "}",
  "",
  ".tool-row-card {",
  "  border: 1px solid var(--border-subtle);",
  "  border-radius: 0.5rem;",
  "  background: var(--surface-elevated);",
  "  transition: border-color 120ms ease, background-color 120ms ease;",
  "}",
  "",
  ".tool-row-card:hover {",
  "  border-color: var(--border-strong);",
  "}",
];

const SAMPLE_RS_LINES = [
  "use std::collections::BTreeMap;",
  "",
  "#[derive(Debug, Clone, PartialEq, Eq)]",
  "pub struct DiffSummary {",
  "    pub files: usize,",
  "    pub added: usize,",
  "    pub removed: usize,",
  "}",
  "",
  "pub fn summarize_hunks(lines: &[&str]) -> DiffSummary {",
  "    let mut added = 0usize;",
  "    let mut removed = 0usize;",
  "    for line in lines {",
  '        if line.starts_with(\'+\') && !line.starts_with("+++") {',
  "            added += 1;",
  '        } else if line.starts_with(\'-\') && !line.starts_with("---") {',
  "            removed += 1;",
  "        }",
  "    }",
  "    DiffSummary { files: 1, added, removed }",
  "}",
];

function rememberSessionFile(session: Session, path: string, content: string) {
  let files = sessionFiles.get(session.id);
  if (!files) {
    files = new Map<string, string>();
    sessionFiles.set(session.id, files);
  }
  files.set(path, content);
}

// Builds a sequence of realistic coding-session closures so we can generate
// transcripts of any length (e.g. `long-transcript 300` or `long-transcript 600 live`)
// that exercise every renderer in App.tsx: Markdown, Reasoning, Read/Write with
// Shiki syntax highlighting, structured Edit diffs, multi-file Search, Bash
// (short, long paginated, and failing), JSON tools, Agent messages, and Workflows.
function buildRealisticTranscriptClosures(session: Session, turnId: string, targetItems: number): Array<(save: boolean) => void> {
  const closures: Array<(save: boolean) => void> = [];
  const baseMs = Date.now() - targetItems * 4000;
  let clockOffset = 0;
  const nextIso = (advanceMs = 850) => {
    clockOffset += advanceMs;
    return new Date(baseMs + clockOffset).toISOString();
  };
  let round = 0;
  while (closures.length < targetItems) {
    const r = ++round;
    const mod = r % 6;

    const reasoningId = `reasoning-${turnId}-${r}`;
    const reasoningStart = nextIso(300);
    const reasoningEnd = nextIso(1200);
    closures.push((save) => {
      push(session, "item", {
        at: reasoningEnd,
        item: {
          kind: "reasoning",
          itemId: reasoningId,
          status: "completed",
          recordedAt: reasoningStart,
          summary: [
            `Investigating step **#${r}** in \`/home/hatch/workspace/code/client/src/App.tsx\` and checking how \`visibleTranscriptEvents\` interacts with tool rows and scroll anchoring.`,
            `We should verify the selector output, inspect the relevant module (\`round_${r}\`), and run the unit test suite before applying the patch.`,
          ],
        },
      }, save);
    });
    if (closures.length >= targetItems) break;

    const readItemId = `read-${turnId}-${r}`;
    const readVariant = r % 5;
    const readPath = readVariant === 0 ? `client/src/TranscriptWindow_${(r % 4) + 1}.tsx`
      : readVariant === 1 ? `pilot/metrics_${(r % 3) + 1}.py`
      : readVariant === 2 ? `client/src/transcript_${(r % 3) + 1}.css`
      : readVariant === 3 ? `src/diff_summary_${(r % 3) + 1}.rs`
      : `server/src/actions.ts`;
    const baseLines = readVariant === 0 ? SAMPLE_TS_LINES
      : readVariant === 1 ? SAMPLE_PY_LINES
      : readVariant === 2 ? SAMPLE_CSS_LINES
      : readVariant === 3 ? SAMPLE_RS_LINES
      : SAMPLE_TS_LINES;
    const startLine = readVariant === 4 ? 140 : 1;
    const numberedBody = baseLines.map((line, idx) => `${startLine + idx}|${line}`).join("\n");
    const readOutput = `Read text file \`${readPath}\`.\n${numberedBody}`;
    const readRefId = `output-${readItemId}`;
    toolOutputs.set(readRefId, readOutput);
    const readStart = nextIso(200);
    const readEnd = nextIso(450);
    closures.push((save) => {
      push(session, "item", {
        at: readEnd,
        item: {
          kind: "toolCall",
          itemId: readItemId,
          tool: "read_file",
          status: "inProgress",
          recordedAt: readStart,
          args: JSON.stringify({ path: readPath, ...(startLine > 1 ? { offset: startLine, limit: baseLines.length } : {}) }),
        },
      }, false);
      push(session, "item", {
        at: readEnd,
        item: {
          kind: "toolCall",
          itemId: readItemId,
          tool: "read_file",
          status: "completed",
          recordedAt: readEnd,
          args: JSON.stringify({ path: readPath, ...(startLine > 1 ? { offset: startLine, limit: baseLines.length } : {}) }),
          visibleOutput: readOutput,
          truncated: false,
          outputRef: { id: readRefId, byteLen: Buffer.byteLength(readOutput), availability: "available", mediaType: "text/plain" },
        },
      }, save);
    });
    if (closures.length >= targetItems) break;

    const searchItemId = `search-${turnId}-${r}`;
    const searchEmpty = r % 9 === 0;
    const searchPattern = searchEmpty ? `UNUSED_LEGACY_FLAG_${r}` : `computeVisibleSlice`;
    const searchOutput = searchEmpty ? "" : [
      `client/src/App.tsx-${100 + r}-  const follow = followTranscriptRef.current;`,
      `client/src/App.tsx:${101 + r}:  const slice = computeVisibleSlice(visibleTranscriptEvents.length, scrollTop, 44);`,
      `client/src/App.tsx-${102 + r}-  return slice.end > slice.start;`,
      `client/src/TranscriptWindow_${(r % 4) + 1}.tsx-18-export function computeVisibleSlice(total: number, scrollTop: number, rowHeight: number) {`,
      `client/src/TranscriptWindow_${(r % 4) + 1}.tsx:19:  const start = Math.max(0, Math.floor(scrollTop / Math.max(1, rowHeight)) - OVERSCAN_ROWS);`,
      `client/src/TranscriptWindow_${(r % 4) + 1}.tsx-20-  const end = Math.min(total, start + DEFAULT_WINDOW_SIZE + OVERSCAN_ROWS * 2);`,
      `client/src/scrollSnap.test.mjs-41-test("slice bounds stay clamped", () => {`,
      `client/src/scrollSnap.test.mjs:42:  const res = computeVisibleSlice(500, 1200, 40);`,
      `client/src/scrollSnap.test.mjs-43-  assert.equal(res.start >= 0, true);`,
    ].join("\n");
    const searchRefId = `output-${searchItemId}`;
    toolOutputs.set(searchRefId, searchOutput);
    const searchStart = nextIso(180);
    const searchEnd = nextIso(520);
    closures.push((save) => {
      push(session, "item", {
        at: searchStart,
        item: {
          kind: "toolCall",
          itemId: searchItemId,
          tool: "search",
          status: "inProgress",
          recordedAt: searchStart,
          args: JSON.stringify({ pattern: searchPattern, paths: ["client/src"], output_mode: "text", context_before: 1, context_after: 1 }),
        },
      }, false);
      push(session, "item", {
        at: searchEnd,
        item: {
          kind: "toolCall",
          itemId: searchItemId,
          tool: "search",
          status: "completed",
          recordedAt: searchEnd,
          args: JSON.stringify({ pattern: searchPattern, paths: ["client/src"], output_mode: "text", context_before: 1, context_after: 1 }),
          visibleOutput: searchOutput,
          truncated: false,
          outputRef: { id: searchRefId, byteLen: Buffer.byteLength(searchOutput), availability: "available", mediaType: "text/plain" },
        },
      }, save);
    });
    if (closures.length >= targetItems) break;

    const editItemId = `edit-${turnId}-${r}`;
    const editPath = `client/src/TranscriptWindow_${(r % 4) + 1}.tsx`;
    const patchObj = r % 2 === 0 ? {
      files: [{
        path: editPath,
        hunks: [{
          oldStart: 1,
          oldLines: 8,
          newStart: 1,
          newLines: 10,
          lines: [
            ' import { useEffect, useMemo, useRef, useState } from "react";',
            ' import type { Session, TranscriptEvent } from "./types";',
            " ",
            " export interface TranscriptWindowProps {",
            "   session: Session;",
            "   events: readonly TranscriptEvent[];",
            "-  showReasoning: boolean;",
            "+  showReasoning?: boolean;",
            "+  overscanRows?: number;",
            "+  measureRowHeight?: (index: number) => number;",
            "   expandTools: boolean;",
            " }",
          ],
        }],
      }],
    } : {
      files: [{
        path: editPath,
        hunks: [{
          oldStart: 15,
          oldLines: 6,
          newStart: 15,
          newLines: 7,
          lines: [
            "-const DEFAULT_WINDOW_SIZE = 120;",
            "-const OVERSCAN_ROWS = 16;",
            "+const DEFAULT_WINDOW_SIZE = 80;",
            "+const OVERSCAN_ROWS = 12;",
            "+const MIN_ROW_HEIGHT = 36;",
            " ",
            " export function computeVisibleSlice(total: number, scrollTop: number, rowHeight: number) {",
            "-  const start = Math.max(0, Math.floor(scrollTop / Math.max(1, rowHeight)) - OVERSCAN_ROWS);",
            "+  const clampedHeight = Math.max(MIN_ROW_HEIGHT, rowHeight);",
            "+  const start = Math.max(0, Math.floor(scrollTop / clampedHeight) - OVERSCAN_ROWS);",
          ],
        }],
      }],
    };
    const patchStr = JSON.stringify(patchObj);
    const patchRefId = `patch-${editItemId}`;
    const editOutRefId = `output-${editItemId}`;
    const editOutput = `Applied patch to ${editPath}`;
    toolOutputs.set(patchRefId, patchStr);
    toolOutputs.set(editOutRefId, editOutput);
    const editStart = nextIso(200);
    const editEnd = nextIso(650);
    closures.push((save) => {
      push(session, "item", {
        at: editStart,
        item: {
          kind: "toolCall",
          itemId: editItemId,
          tool: "edit_file",
          status: "inProgress",
          recordedAt: editStart,
          args: JSON.stringify({ path: editPath, find: "DEFAULT_WINDOW_SIZE", replace: "clampedHeight" }),
        },
      }, false);
      push(session, "item", {
        at: editEnd,
        item: {
          kind: "toolCall",
          itemId: editItemId,
          tool: "edit_file",
          status: "completed",
          recordedAt: editEnd,
          args: JSON.stringify({ path: editPath, find: "DEFAULT_WINDOW_SIZE", replace: "clampedHeight" }),
          patchRef: { id: patchRefId, kind: "tool_patch", byteLen: Buffer.byteLength(patchStr), availability: "available", mediaType: "application/json" },
          patchSummary: { files: 1, added: r % 2 === 0 ? 3 : 5, removed: r % 2 === 0 ? 1 : 3 },
          visibleOutput: editOutput,
          truncated: false,
          outputRef: { id: editOutRefId, byteLen: Buffer.byteLength(editOutput), availability: "available", mediaType: "text/plain" },
        },
      }, save);
    });
    if (closures.length >= targetItems) break;

    if (mod === 0 || mod === 3) {
      const writeItemId = `write-${turnId}-${r}`;
      const writePath = mod === 0
        ? `client/src/perf_helper_${(r % 5) + 1}.ts`
        : `client/src/perf_styles_${(r % 3) + 1}.css`;
      const writeContent = (mod === 0 ? SAMPLE_TS_LINES : SAMPLE_CSS_LINES).join("\n") + "\n";
      const byteLen = Buffer.byteLength(writeContent);
      const writeOutput = `wrote ${byteLen} bytes to ${writePath}`;
      const writeRefId = `output-${writeItemId}`;
      toolOutputs.set(writeRefId, writeOutput);
      rememberSessionFile(session, writePath, writeContent);
      const writeStart = nextIso(150);
      const writeEnd = nextIso(420);
      closures.push((save) => {
        push(session, "item", {
          at: writeStart,
          item: {
            kind: "toolCall",
            itemId: writeItemId,
            tool: "write_file",
            status: "inProgress",
            recordedAt: writeStart,
            args: JSON.stringify({ path: writePath, content: writeContent }),
          },
        }, false);
        push(session, "item", {
          at: writeEnd,
          item: {
            kind: "toolCall",
            itemId: writeItemId,
            tool: "write_file",
            status: "completed",
            recordedAt: writeEnd,
            args: JSON.stringify({ path: writePath, content: writeContent }),
            visibleOutput: writeOutput,
            truncated: false,
            outputRef: { id: writeRefId, byteLen: Buffer.byteLength(writeOutput), availability: "available", mediaType: "text/plain" },
          },
        }, save);
      });
      if (closures.length >= targetItems) break;
    }

    const bashItemId = `bash-${turnId}-${r}`;
    const isLongBash = mod === 2;
    const isFailedBash = mod === 5;
    const bashCmd = isFailedBash
      ? `bun x tsc --noEmit -p client/tsconfig.json && node --test client/src/perf_${r}.test.mjs`
      : isLongBash
        ? `node --test client/src/*.test.mjs server/src/*.test.mjs`
        : `bun run typecheck`;
    const bashDesc = isFailedBash
      ? `Run typecheck and perf_${r}.test.mjs`
      : isLongBash
        ? `Run full client and server unit test suite (batch #${r})`
        : `Typecheck client and server bundles`;
    const fullBashOutput = isLongBash
      ? Array.from({ length: 90 }, (_, idx) => `✔ test case #${idx + 1} in suite round_${r} (${12 + (idx % 19)}ms)`).join("\n")
      : isFailedBash
        ? `✖ failing assertion in client/src/perf_${r}.test.mjs:42\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n+ actual - expected\n+ 128\n- 120`
        : `$ bun x tsc --noEmit -p client/tsconfig.json && bun x tsc --noEmit -p server/tsconfig.json\nChecked 64 files in 312ms. No errors found.`;
    const visibleBashOutput = isLongBash ? fullBashOutput.split("\n").slice(0, 18).join("\n") : fullBashOutput;
    const bashRefId = `output-${bashItemId}`;
    toolOutputs.set(bashRefId, fullBashOutput);
    const bashStart = nextIso(200);
    const bashEnd = nextIso(1450);
    closures.push((save) => {
      push(session, "item", {
        at: bashStart,
        item: {
          kind: "toolCall",
          itemId: bashItemId,
          tool: "bash",
          status: "inProgress",
          recordedAt: bashStart,
          args: JSON.stringify({ command: bashCmd, description: bashDesc }),
        },
      }, false);
      push(session, "item", {
        at: bashEnd,
        item: {
          kind: "toolCall",
          itemId: bashItemId,
          tool: "bash",
          status: isFailedBash ? "failed" : "completed",
          ...(isFailedBash ? { failureReason: "process exited with status 1" } : {}),
          recordedAt: bashEnd,
          args: JSON.stringify({ command: bashCmd, description: bashDesc }),
          visibleOutput: visibleBashOutput,
          truncated: isLongBash,
          outputRef: { id: bashRefId, byteLen: Buffer.byteLength(fullBashOutput), availability: "available", mediaType: "text/plain" },
        },
      }, save);
    });
    if (closures.length >= targetItems) break;

    if (mod === 1) {
      const msgAt = nextIso(400);
      const fromMuse = r % 12 === 1;
      const peerName = (session.name ?? session.title).trim().toLowerCase() === "pip" ? "juno" : "pip";
      closures.push((save) => {
        push(session, "agent_message", {
          at: msgAt,
          direction: "in",
          messageId: `msg-in-${turnId}-${r}`,
          from: fromMuse
            ? { kind: "muse", name: assistant.name, color: assistant.color, sessionId: null }
            : { kind: "agent", name: peerName, sessionId: `fake-${peerName}` },
          to: { kind: "agent", name: session.name ?? session.title, sessionId: session.id },
          text: fromMuse
            ? `Quick check-in on round #${r}: please make sure the scroll position stays pinned when new tool output arrives.`
            : `I finished checking the server schema in round #${r}. Ready for your client changes whenever you are!`,
          queued: false,
        }, save);
      });
      if (closures.length >= targetItems) break;
    } else if (mod === 4) {
      const sendToolId = `send-${turnId}-${r}`;
      const sendOut = "Delivered to juno.";
      const sendRef = `output-${sendToolId}`;
      toolOutputs.set(sendRef, sendOut);
      const sendAt = nextIso(350);
      closures.push((save) => {
        push(session, "item", {
          at: sendAt,
          item: {
            kind: "toolCall",
            itemId: sendToolId,
            tool: "mcp__code_space__send_message",
            status: "completed",
            recordedAt: sendAt,
            args: JSON.stringify({ to: "juno", text: `Round #${r} client benchmark numbers look solid.` }),
            visibleOutput: sendOut,
            truncated: false,
            outputRef: { id: sendRef, byteLen: Buffer.byteLength(sendOut), availability: "available", mediaType: "text/plain" },
          },
        }, false);
        push(session, "agent_message", {
          at: sendAt,
          direction: "out",
          messageId: `msg-out-${turnId}-${r}`,
          from: { kind: "agent", name: session.name ?? session.title, sessionId: session.id },
          to: { kind: "agent", name: "juno", sessionId: "fake-juno" },
          text: `Round #${r} client benchmark numbers look solid.`,
          queued: false,
        }, save);
      });
      if (closures.length >= targetItems) break;
    } else if (mod === 2) {
      const jsonItemId = `json-${turnId}-${r}`;
      const jsonPayload = JSON.stringify({
        ok: true,
        round: r,
        metrics: { renderMs: 4.2 + (r % 5), domNodes: 1420 + r * 18, memoHitRate: 0.94 },
        files: [`client/src/TranscriptWindow_${(r % 4) + 1}.tsx`, "client/src/App.tsx"],
      });
      const jsonRef = `output-${jsonItemId}`;
      toolOutputs.set(jsonRef, jsonPayload);
      const jsonAt = nextIso(320);
      closures.push((save) => {
        push(session, "item", {
          at: jsonAt,
          item: {
            kind: "toolCall",
            itemId: jsonItemId,
            tool: "inspect_perf_snapshot",
            status: "completed",
            recordedAt: jsonAt,
            args: JSON.stringify({ round: r, includeDomMetrics: true }),
            visibleOutput: jsonPayload,
            truncated: false,
            outputRef: { id: jsonRef, byteLen: Buffer.byteLength(jsonPayload), availability: "available", mediaType: "text/plain" },
          },
        }, save);
      });
      if (closures.length >= targetItems) break;
    } else if (mod === 5) {
      const wfItemId = `wf-${turnId}-${r}`;
      const wfRunId = `wf-run-${turnId}-${r}`;
      const wfAt = nextIso(2400);
      const envelope = `<workflow-launch-reconciled>${JSON.stringify({
        type: "workflow_launch_reconciled",
        final_summary: {
          status: "completed",
          summary: `Verified render profile across 3 subagents in round #${r}: no regressions detected.`,
        },
        latest_failure: null,
      })}</workflow-launch-reconciled>`;
      closures.push((save) => {
        push(session, "item", {
          at: wfAt,
          item: {
            kind: "workflow",
            itemId: wfItemId,
            turnId,
            status: "completed",
            workflowRunId: wfRunId,
            entryId: `Parallel verification #${r}`,
            recordedAt: wfAt,
            message: envelope,
            children: [
              { childId: `c1-${r}`, attempt: 1, label: "typecheck-worker", status: "terminal", terminal: "completed", durationMs: 1120 },
              { childId: `c2-${r}`, attempt: 1, label: "unit-test-worker", status: "terminal", terminal: "completed", durationMs: 2180 },
              { childId: `c3-${r}`, attempt: 1, label: "bundle-audit", status: "terminal", terminal: "completed", durationMs: 1640 },
            ],
          },
        }, save);
      });
      if (closures.length >= targetItems) break;
    }

    const msgAt = nextIso(900);
    const markdownReply = [
      `### Phase ${r}: Completed \`TranscriptWindow_${(r % 4) + 1}.tsx\` updates`,
      "",
      `I updated \`/home/hatch/workspace/code/${editPath}\` and verified the behavior against the test suite:`,
      "",
      `- **Windowed slice calculation:** clamped row height and adjusted \`OVERSCAN_ROWS\` for smoother scrolling.`,
      `- **Verification:** ran \`${bashDesc}\` and inspected ${searchEmpty ? "0 legacy references" : "3 matching call sites"}.`,
      `- **Next step:** continue profiling [Chrome DevTools Performance](https://developer.chrome.com/docs/devtools/performance) traces.`,
      "",
      "> Note: Finished tool rows stay memoized while active rows update their local elapsed timer.",
      "",
      "```ts",
      `const slice = computeVisibleSlice(events.length, scrollTop, ${36 + (r % 8)});`,
      `console.log("round ${r} visible range:", slice.start, slice.end);`,
      "```",
    ].join("\n");
    closures.push((save) => {
      push(session, "item", {
        at: msgAt,
        item: {
          kind: "agentMessage",
          status: "completed",
          recordedAt: msgAt,
          text: markdownReply,
        },
      }, save);
    });
  }
  return closures;
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

  const longTranscriptMatch = /\b(?:long-transcript|benchmark|perf-transcript)(?:[:\s]+(\d+))?\b/i.exec(text);
  if (longTranscriptMatch) {
    const requestedCount = longTranscriptMatch[1] ? Number(longTranscriptMatch[1]) : 200;
    const targetItems = Math.max(12, Math.min(1500, Number.isFinite(requestedCount) ? requestedCount : 200));
    const streamLiveTail = /\b(?:live|stream|slow)\b/i.test(text);
    const liveTailCount = streamLiveTail ? Math.min(20, Math.max(6, Math.floor(targetItems * 0.15))) : 0;
    const bulkCount = targetItems - liveTailCount;
    const liveDelayMs = /\bslow\b/i.test(text) ? Math.min(2000, slowStepMs) : 250;

    void (async () => {
      rememberSessionFile(session, "alpha.ts", SAMPLE_TS_LINES.join("\n") + "\n");
      rememberSessionFile(session, "test.rs", SAMPLE_RS_LINES.join("\n") + "\n");
      push(session, "item", { item: { kind: "userMessage", text, status: "completed" } }, false);
      const closures = buildRealisticTranscriptClosures(session, turnId, targetItems);
      for (let i = 0; i < bulkCount && i < closures.length; i++) {
        if (cancelled) break;
        closures[i]!(false);
      }
      saveState();

      for (let i = bulkCount; i < closures.length; i++) {
        if (cancelled) break;
        await sleep(liveDelayMs);
        if (cancelled) break;
        closures[i]!(true);
      }

      if (cancelled) {
        push(session, "turn_completed", { turnId, cancelled: true, outcome: { status: "cancelled" } });
      } else {
        push(session, "item", {
          item: {
            kind: "agentMessage",
            status: "completed",
            text: `## Benchmark transcript ready (${closures.length} items)\n\nGenerated **${closures.length}** realistic transcript events across reasoning, syntax-highlighted file reads/writes, structured edit diffs, multi-file searches, bash runs, peer/assistant messages, workflows, and Markdown replies.\n\n- Use **Expand tools by default** or click individual tool rows to profile tool views.\n- Send another message (e.g. \`slow\`, \`thinking\`, \`edit-diff\`, or \`long-transcript 100 live\`) to profile live streaming on top of this transcript.`,
          },
        }, false);
        push(session, "turn_completed", { turnId, outcome: { status: "completed" } }, true);
      }
      if (session.openTurn === turnId) {
        session.openTurn = null;
        session.cancel = null;
      }
    })();
    return turnId;
  }

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
    const monitorTool = /\bpr-monitor\b/i.test(text);
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
      : monitorTool ? (
        "Now monitoring 2 PR(s). You will be notified automatically via an incoming message when something changes — continue with other work.\n\n" +
        "Current state:\n" +
        "  #6 — OPEN · CI: 2 passed, 1 running · 1 comment · dreveman/muse-code-space\n" +
        "  #7 — DRAFT · CI: 3 passed · 0 comments · dreveman/muse-code-space\n\n" +
        "Active subscriptions: #6, #7."
      )
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
      kind: "toolCall", itemId: toolItemId, tool: editDiff ? "edit_file" : readTool ? "read_file" : writeTool ? "write_file" : monitorTool ? "mcp__code_space__github_monitor_pr" : listAgentsTool ? "mcp__code_space__list_agents" : sendMessageTool ? "mcp__code_space__send_message" : searchTool ? "search" : jsonTool ? "mystery" : "bash", status,
      recordedAt: new Date().toISOString(), args: JSON.stringify(editDiff ? { path: "test.rs", find: "OLD", replace: "NEW" } : readTool ? { path: readTsTool ? "alpha.ts" : "test.rs" } : writeTool ? (writeTsTool ? { path: "alpha.ts", content: tsWriteContent } : { path: "test.rs", content: "ALPHA\nBETA\nGAMMA\n" }) : monitorTool ? { action: "subscribe", pr_ids: ["#6", "#7"] } : listAgentsTool ? {} : sendMessageTool ? { to: "pip", text: "Please run tests" } : searchTool ? { pattern: "MCS_SEARCH_PROBE", paths: ["."], output_mode: "text", context_before: 1, context_after: 1 } : jsonTool ? { query: "test" } : bashNonzero ? { command: "printf PROBE_OUTPUT; exit 7", description: "Check a failing command" } : { command: "echo hello" }),
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
      ...(monitorTool ? [() => startFakePrMonitor(session)] : []),
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
      push(session, "session_started", {
        meta: {
          title: session.title,
          name: session.name ?? session.title,
          modelId: session.modelId,
          workspaceRoot: session.workspaceRoot ?? null,
          appSessionId: session.appSessionId ?? null,
          createdAt: new Date().toISOString(),
        },
      });
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
      const requestedPath = typeof body.path === "string" ? body.path : "";
      const dynamicContent = sessionFiles.get(session.id)?.get(requestedPath);
      if (dynamicContent !== undefined) return json(200, { ok: true, path: requestedPath, content: dynamicContent });
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

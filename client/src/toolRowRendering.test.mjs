// Tool rows must not redo presentation/preview work on every transcript
// tick. Run: node --test client/src/toolRowRendering.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const side = readFileSync(new URL("./SidePanel.tsx", import.meta.url), "utf8");

test("finished tool rows are memoized and do not receive the global clock", () => {
  assert.ok(app.includes("const ToolEvent = memo(function ToolEvent("), "ToolEvent is memoized");
  assert.ok(!app.includes("nowMs={nowMs} expandedByDefault={expandTools}"), "the 1s App clock is not a tool-row prop");
  assert.ok(app.includes("onOpenFile={openFileTabForDetail}") && app.includes("const openFileTab = useCallback("),
    "the file-open callback is referentially stable");
});

test("only running tool rows keep a local ticking clock", () => {
  const toolEvent = app.slice(app.indexOf("const ToolEvent = memo("), app.indexOf("});", app.indexOf("const ToolEvent = memo(")));
  assert.ok(toolEvent.includes("if (!running) return;") && toolEvent.includes("setInterval"), "tick effect is gated on running");
  assert.ok(toolEvent.includes("toolElapsedMs(startedAt, finishedAt, tickMs)"), "elapsed uses the local tick");
});

test("the artifacts menu is memoized against stable props", () => {
  assert.ok(side.includes("export const OwnedArtifactMenu = memo("), "menu is memoized");
  assert.ok(app.includes("placeholderData: keepPreviousData"), "refetches keep previous files mounted");
});

test("markdown, message, and workflow rows are memoized and decoupled from 1s ticks", () => {
  const agentsEvent = readFileSync(new URL("./AgentsEvent.tsx", import.meta.url), "utf8");
  const messageTime = readFileSync(new URL("./messageTime.ts", import.meta.url), "utf8");
  const transcriptCompanion = readFileSync(new URL("./TranscriptCompanion.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("const Markdown = memo(function Markdown("), "Markdown is memoized");
  assert.ok(app.includes("const MessageEvent = memo(function MessageEvent("), "MessageEvent is memoized");
  assert.ok(app.includes("const TranscriptEventRow = memo(function TranscriptEventRow("), "TranscriptEventRow is memoized");
  assert.ok(app.includes("const SessionRow = memo(function SessionRow("), "SessionRow is memoized");
  assert.ok(transcriptCompanion.includes("export const TranscriptCompanion = memo(function TranscriptCompanion("), "TranscriptCompanion is memoized");
  assert.ok(messageTime.includes("const formatterCache = new Map<string, Intl.DateTimeFormat>()"), "Intl.DateTimeFormat instances are cached");
  assert.ok(agentsEvent.includes("export const AgentsEvent = memo(function AgentsEvent("), "AgentsEvent is memoized");
  assert.ok(agentsEvent.includes("prev.finishedAt !== null || prev.nowMs === next.nowMs"), "finished workflow rows ignore 1s clock ticks");
  assert.ok(app.includes('const time = event.kind === "stdout" ? formatMessageTime(event.created_at, nowMs) : "";'),
    "formatMessageTime only runs for stdout rows");
  assert.ok(app.includes("const renderedTranscriptEvents = useMemo("),
    "transcript event list is memoized against composer state and 1s ticks");
  assert.ok(app.includes("const sidebarElement = useMemo("),
    "sidebar is memoized against composer state and 1s ticks");
});

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

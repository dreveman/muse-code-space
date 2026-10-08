import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redundantSendToolIds } from "./messageToolVisibility.ts";
const at = (n) => new Date(Date.parse("2026-10-06T12:00:00Z") + n * 1000).toISOString();
const tool = (id, to = "pip", text = "hello", extra = {}) => ({ id, kind: "tool", content: "send_message", created_at: at(id),
  tool_details: { tool: "mcp__code_space__send_message", status: "completed", args: JSON.stringify({ to, text }), output: "Delivered to pip.", failureReason: null, ...extra } });
const message = (id, to = "pip", text = "hello", kind = "agent") => ({ id, kind: "message", created_at: at(id), content: JSON.stringify({ direction: "out", to: { kind, name: to }, text }) });

test("a matching outgoing To event replaces only its successful send tool row", () => {
  assert.deepEqual([...redundantSendToolIds([tool(1), message(2)])], [1]);
  assert.equal(redundantSendToolIds([tool(1)]).size, 0, "missing To event leaves the tool visible");
  assert.equal(redundantSendToolIds([tool(1), message(2, "juno")]).size, 0, "wrong recipient does not match");
  assert.equal(redundantSendToolIds([tool(1), message(2, "pip", "different")]).size, 0);
  assert.equal(redundantSendToolIds([message(1), tool(2)]).size, 0, "an older To event cannot hide a later tool");
});

test("failed deliveries stay visible, even if the pilot already recorded a To row", () => {
  assert.equal(redundantSendToolIds([tool(1, "pip", "hello", { status: "failed", failureReason: "delivery failed" }), message(2)]).size, 0);
  assert.equal(redundantSendToolIds([tool(1, "pip", "hello", { output: "Not delivered: offline" }), message(2)]).size, 0);
  assert.deepEqual([...redundantSendToolIds([tool(1, "pip", "hello", { status: "inProgress", output: null }), message(2)])], [1]);
});

test("repeated identical sends pair one-to-one and assistant aliases resolve to the To box", () => {
  assert.deepEqual([...redundantSendToolIds([tool(1), message(2), tool(3), message(4)])], [1, 3]);
  assert.deepEqual([...redundantSendToolIds([tool(1, "muse"), message(2, "Jolly", "hello", "muse")])], [1]);
  assert.deepEqual([...redundantSendToolIds([tool(1, "Jolly"), message(2, "Jolly", "hello", "muse")])], [1]);
});

test("normal UI hides only matched tools; global raw mode reveals them", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes('return showRawToolOutput ? events : events.filter((event) => !redundantMessageTools.has(event.id))'));
  assert.ok(app.includes('<MessageEvent key={event.id} content={event.content} agents={sessions}'));
});

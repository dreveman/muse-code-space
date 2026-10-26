import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentVisualStatus, transcriptAtBottom } from "./agentStatus.ts";
import { countsAsUnread, isLifecycleMessage } from "../../server/src/transcriptVisibility.ts";

const agent = (status, output_revision, seen_output_revision) => ({ status, output_revision, seen_output_revision });

test("unread output wins over work; seen success is checked; seen work spins", () => {
  assert.equal(agentVisualStatus(agent("running", 2, 1)), "unread");
  assert.equal(agentVisualStatus(agent("running", 2, 2)), "working");
  assert.equal(agentVisualStatus(agent("queued", 0, 0)), "working");
  assert.equal(agentVisualStatus(agent("succeeded", 2, 1)), "unread");
  assert.equal(agentVisualStatus(agent("succeeded", 2, 2)), "complete");
  assert.equal(agentVisualStatus(agent("failed", 1, 1)), "failed");
  assert.equal(agentVisualStatus(agent("stopped", 0, 0)), "idle");
});

test("seen completions use a small neutral check while unread output stays green", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  const complete = css.match(/\.status-dot\.complete\s*\{[^}]*\}/)?.[0] ?? "";
  const icon = css.match(/\.status-dot\.complete svg\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(complete, /width:\s*11px; height:\s*11px/);
  assert.match(complete, /color:\s*var\(--dim\)/);
  assert.match(icon, /width:\s*11px; height:\s*11px/);
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const statusMark = app.slice(app.indexOf("function StatusMark("), app.indexOf("function shortenHomePaths("));
  assert.match(statusMark, /d="m3 7\.5 4 3\.7L13 4\.5"[^>]*strokeWidth="3"/, "small check has balanced arms and a heavier stroke");
  assert.ok(!complete.includes("var(--live)"));
  assert.match(css, /\.status-dot\.unread\s*\{[^}]*background:\s*var\(--live\)/);
});

test("only visible agent output counts as unread, not our prompts or lifecycle notices", () => {
  for (const kind of ["stdout", "tool", "agents", "message", "system"]) {
    assert.equal(countsAsUnread({ kind, content: "Agent did work" }), true, kind);
  }
  assert.equal(countsAsUnread({ kind: "user", content: "My own prompt" }), false);
  assert.equal(countsAsUnread({ kind: "result", content: "Hidden result" }), false);
  assert.equal(countsAsUnread({ kind: "thinking", content: "Summarizing the approach" }), false, "reasoning alone does not mark an agent unread");
  const notice = { kind: "system", content: "Continuation picked up by supervisor" };
  assert.equal(isLifecycleMessage(notice), true);
  assert.equal(countsAsUnread(notice), false);
});

test("bottom detection tolerates rounding and iOS bottom overscroll, but not unread output below the viewport", () => {
  assert.equal(transcriptAtBottom({ scrollHeight: 2000, scrollTop: 1600, clientHeight: 400 }), true);
  assert.equal(transcriptAtBottom({ scrollHeight: 2000, scrollTop: 1578, clientHeight: 400 }), true);
  assert.equal(transcriptAtBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 400 }), false);
  assert.equal(transcriptAtBottom({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 }), true);
  // column-reverse (.terminal-body): scrollTop > 0 is iOS rubber-band overscroll beyond the bottom.
  const terminalClassList = { contains: (cls) => cls === "terminal-body" };
  assert.equal(transcriptAtBottom({ scrollHeight: 2000, scrollTop: 64, clientHeight: 400, classList: terminalClassList }), true);
  assert.equal(transcriptAtBottom({ scrollHeight: 2000, scrollTop: -12, clientHeight: 400, classList: terminalClassList }), true);
  assert.equal(transcriptAtBottom({ scrollHeight: 2000, scrollTop: -80, clientHeight: 400, classList: terminalClassList }), false);
});

// Regression tests for the transcript working indicator.
// Run: node --test client/src/workingLabel.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { getWorkingLabel } from "./workingLabel.ts";

const T0 = new Date("2026-09-30T18:00:00.000Z").getTime();
const iso = (ms) => new Date(ms).toISOString();
const ev = (kind, content, at) => ({ kind, content, created_at: iso(at) });

const tool = (name, status = "inProgress", at = T0 + 1000) => ({
  ...ev("tool", "raw tool label", at),
  started_at: iso(at), finished_at: status === "inProgress" ? null : iso(at + 100),
  tool_details: { tool: name, status, args: null, output: null, failureReason: null,
    truncated: false, outputRef: null, patchRef: null, patchSummary: null },
});
const working = (events) => getWorkingLabel({ status: "running", promptStartedMs: T0, events, nowMs: T0 + 60_000 });

test("active tools use the same friendly names as transcript tool rows", () => {
  for (const [name, label] of [["bash", "Running bash"], ["edit_file", "Editing"],
    ["read_file", "Reading"], ["write_file", "Writing"], ["search", "Searching"],
    ["custom_tool", "Running custom_tool"]]) {
    assert.equal(working([tool(name)]), label);
  }
});

test("completed tools return to Thinking instead of looking permanently active", () => {
  assert.equal(working([tool("bash", "completed")]), "Thinking");
  assert.equal(working([tool("edit_file", "failed")]), "Thinking");
});

test("another tool completing does not hide a tool that is still running", () => {
  assert.equal(working([tool("edit_file"), tool("read_file", "completed", T0 + 2000)]), "Editing");
});

test("a prior prompt's tools do not label a follow-up prompt", () => {
  assert.equal(working([tool("bash", "inProgress", T0 - 1000)]), "Thinking");
});

test("queued status still shows Starting even with a tool event", () => {
  const label = getWorkingLabel({
    status: "queued",
    promptStartedMs: T0,
    events: [ev("tool", "bash · $ sleep 10", T0 + 1000)],
    nowMs: T0 + 60_000,
  });
  assert.equal(label, "Starting");
});

test("recent stdout shows Typing", () => {
  const label = getWorkingLabel({
    status: "running",
    promptStartedMs: T0,
    events: [ev("stdout", "hello", T0 + 1000)],
    nowMs: T0 + 3000,
  });
  assert.equal(label, "Typing");
});

test("stale stdout without tools still shows Thinking", () => {
  const label = getWorkingLabel({
    status: "running",
    promptStartedMs: T0,
    events: [ev("stdout", "hello", T0 + 1000)],
    nowMs: T0 + 60_000,
  });
  assert.equal(label, "Thinking");
});

test("brand-new session shows Starting", () => {
  const label = getWorkingLabel({
    status: "running",
    promptStartedMs: T0,
    events: [],
    nowMs: T0 + 1000,
  });
  assert.equal(label, "Starting");
});

test("a follow-up with prior activity starts Thinking", () => {
  assert.equal(working([ev("stdout", "Previous reply", T0 - 1000)]), "Thinking");
});

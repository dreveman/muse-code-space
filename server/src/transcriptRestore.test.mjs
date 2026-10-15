// Tests for transcript-driven restore (server/src/transcriptRestore.ts).
// Run: node --test server/src/transcriptRestore.test.mjs
//
// Covers the pure heart of reconcile: what a transcript file becomes when
// a session is rebuilt from it alone (the empty-DB restore and husk-heal
// paths in actions.ts both feed through transcriptToRows), how deleted
// conversations stay deleted at the id layer, and malformed input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscriptPrompt, safeTranscriptId, summarizeTranscript, transcriptToRows } from "./transcriptRestore.ts";

const FALLBACK = new Date("2026-10-15T00:00:00.000Z");
const at = (s) => `2026-10-15T00:00:${String(s).padStart(2, "0")}.000Z`;

function conversation() {
  return [
    { seq: 1, type: "session_started", at: at(1), meta: { appSessionId: "app-1", title: "Nova", name: "Nova", modelId: "muse-wonder-1.0", workspaceRoot: "/home/hatch/workspace/code/x" } },
    { seq: 2, type: "item", at: at(2), item: { kind: "userMessage", status: "completed", text: "[Code Space] You are agent \"Nova\".\n---\n\nFix the flaky test" } },
    { seq: 3, type: "item", at: at(3), item: { kind: "reasoning", itemId: "r1", status: "completed", summary: ["Looking at the test"] } },
    { seq: 4, type: "item", at: at(4), item: { kind: "toolCall", itemId: "t1", status: "inProgress", tool: "bash", args: JSON.stringify({ description: "run tests" }) } },
    { seq: 5, type: "item", at: at(5), item: { kind: "toolCall", itemId: "t1", status: "completed", tool: "bash", args: JSON.stringify({ description: "run tests" }), visibleOutput: "ok" } },
    { seq: 6, type: "item", at: at(6), item: { kind: "agentMessage", status: "completed", text: "Fixed it." } },
    { seq: 7, type: "turn_completed", at: at(7) },
  ];
}

test("a transcript alone rebuilds the conversation (empty-DB restore core)", () => {
  const imported = transcriptToRows(conversation(), FALLBACK);
  assert.equal(imported.status, "succeeded");
  assert.equal(imported.latestSeq, 7);
  const kinds = imported.rows.map((r) => r.kind);
  assert.deepEqual(kinds, ["user", "thinking", "tool", "stdout"]);
  assert.equal(imported.rows[0].content, "Fix the flaky test", "the [Code Space] preamble is stripped");
  assert.match(imported.rows[2].content, /bash/);
  assert.equal(imported.rows[2].finishedAt !== null, true, "completed tool revision wins over inProgress");
  assert.equal(imported.rows.filter((r) => r.kind === "tool").length, 1, "tool revisions dedupe by itemId");
});

test("cleanTranscriptPrompt only strips the agent preamble", () => {
  assert.equal(cleanTranscriptPrompt("hello"), "hello");
  assert.equal(cleanTranscriptPrompt("[Code Space] You are agent \"Pip\".\n---\n\nDo it"), "Do it");
  assert.equal(cleanTranscriptPrompt("[Code Space] You are agent \"Pip\" (no separator)"), "[Code Space] You are agent \"Pip\" (no separator)");
});

test("failed and stopped turns restore with their status and summary", () => {
  const failed = transcriptToRows([
    { seq: 1, type: "item", at: at(1), item: { kind: "userMessage", status: "completed", text: "go" } },
    { seq: 2, type: "turn_error", at: at(2), error: "backend exploded" },
  ], FALLBACK);
  assert.equal(failed.status, "failed");
  assert.equal(failed.summary, "backend exploded");
  assert.equal(failed.rows.at(-1).systemIsError, true);

  const stopped = transcriptToRows([
    { seq: 1, type: "turn_completed", at: at(1), cancelled: true },
  ], FALLBACK);
  assert.equal(stopped.status, "stopped");
});

test("malformed and in-progress events are skipped, never fatal", () => {
  const imported = transcriptToRows([
    null, 42, "junk", {}, { type: "mystery", seq: 9 },
    { seq: 2, type: "item", at: at(2), item: { kind: "userMessage", status: "inProgress", text: "draft" } },
    { seq: 3, type: "item", at: at(3), item: { kind: "toolCall", status: "completed", tool: "bash" } }, // no itemId: skipped
    { seq: 4, type: "item", at: at(4), item: { kind: "agentMessage", status: "completed", text: "real answer" } },
    { seq: 5, type: "turn_completed", at: at(5) },
  ].filter((e) => e && typeof e === "object"), FALLBACK);
  assert.equal(imported.status, "succeeded");
  assert.deepEqual(imported.rows.map((r) => r.content), ["real answer"]);
  assert.equal(transcriptToRows([], FALLBACK).rows.length, 0);
});

test("agent messages restore in both directions", () => {
  const imported = transcriptToRows([
    { seq: 1, type: "agent_message", direction: "in", from: { kind: "agent", name: "Pip" }, to: { kind: "agent", name: "Nova" }, text: "please check", messageId: "m1", at: at(1) },
  ], FALLBACK);
  assert.equal(imported.rows.length, 1);
  const parsed = JSON.parse(imported.rows[0].content);
  assert.equal(parsed.text, "please check");
  assert.equal(parsed.from.name, "Pip");
});

test("summary extracts only what reconcile consumes, from the head", () => {
  const raw = conversation().map((e) => JSON.stringify(e)).join("\n");
  const mtime = new Date("2026-10-15T01:02:03.000Z");
  const summary = summarizeTranscript("pilot-1", raw, mtime);
  assert.equal(summary.app_session_id, "app-1");
  assert.equal(summary.name, "Nova");
  assert.equal(summary.model_id, "muse-wonder-1.0");
  assert.equal(summary.workspace_root, "/home/hatch/workspace/code/x");
  assert.equal(summary.prompt, "Fix the flaky test", "DB prompt is the first prompt; the assistant fills session_summary later");
  assert.equal(summary.updated_at, mtime.toISOString(), "updated_at is the file mtime, no tail scan needed");
  assert.equal("latest_text" in summary, false);
  assert.equal(summarizeTranscript("pilot-2", JSON.stringify({ seq: 1, type: "session_started", meta: {} }), mtime), null,
    "a transcript with no user prompt is not a past conversation");
  assert.equal(summarizeTranscript("pilot-3", "not json\n{\"broken\"", mtime), null, "malformed heads are skipped");
});

// Deletion finality at the id layer: reconcile only ever resurrects a
// transcript whose file still exists, and deleteSession removes that file
// (via the pilot) before removing app rows. The id that a restore will
// use is derived here; traversal-shaped ids must never become file paths.
test("transcript ids that could escape the state dir are rejected", () => {
  assert.equal(safeTranscriptId("01a13a82-e57e-71c0-bdd2-99482d16b063"), true);
  assert.equal(safeTranscriptId("restored-abc_1.2"), true);
  for (const bad of ["../secret", "..\\secret", "a/b", "a\\b", "..", ".hidden", "", "a/../b", "a b", "a%2fb"]) {
    assert.equal(safeTranscriptId(bad), false, JSON.stringify(bad));
  }
});

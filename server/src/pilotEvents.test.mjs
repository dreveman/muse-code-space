// Tests for pilot system-event rendering and backend-change detection.
// Run: node --test server/src/pilotEvents.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
buildUserInputAnswers,
pilotBackendChanged,
pilotSystemText,
pilotTurnCancelled,
pilotTurnOutcomeError,
} from "./pilotEvents.ts";

test("session_recovered renders a notice, session_started stays silent", () => {
  const notice = pilotSystemText({
    seq: 1,
    type: "session_recovered",
    text: "Backend restarted; resumed.",
  });
  assert.ok(notice?.includes("Backend restarted"));
  assert.equal(pilotSystemText({ seq: 2, type: "session_started" }), null);
});

test("recovery_failed always carries actionable text", () => {
  const withReason = pilotSystemText({ seq: 1, type: "recovery_failed", error: "workspace gone" });
  assert.ok(withReason?.includes("needs attention"));
  assert.ok(withReason?.includes("workspace gone"));
  const bare = pilotSystemText({ seq: 2, type: "recovery_failed" });
  assert.ok(bare?.includes("needs attention"));
});

test("host_restarted renders a notice; unknown kinds stay silent", () => {
  assert.ok(pilotSystemText({ seq: 1, type: "host_restarted" })?.includes("restarted"));
  assert.equal(pilotSystemText({ seq: 2, type: "item", item: { kind: "toolCall" } }), null);
});

test("turn outcome errors surface instead of reading as success", () => {
  assert.equal(pilotTurnOutcomeError({ status: "completed" }), null);
  assert.equal(pilotTurnOutcomeError(null), null);
  assert.ok(
    (pilotTurnOutcomeError({ status: "error", error: "transport blew up" }) ?? "").includes("transport blew up"),
  );
  assert.ok((pilotTurnOutcomeError({ errorMessage: "model 500" }) ?? "").includes("model 500"));
  assert.equal(
    pilotSystemText({ seq: 1, type: "turn_completed", outcome: { status: "completed" } }),
    null,
  );
  assert.ok(
    (pilotSystemText({ seq: 2, type: "turn_completed", outcome: { status: "failed" } }) ?? "").includes("failed"),
  );
});

test("cancelled turns read as stopped, never failed", () => {
  const sdkOutcome = { kind: "completed", params: { terminal: "cancelled", turnId: "t1" } };
  assert.equal(pilotTurnCancelled(sdkOutcome), true);
  assert.equal(pilotTurnOutcomeError(sdkOutcome), null);
  assert.equal(pilotTurnCancelled({ status: "cancelled" }), true);
  assert.equal(pilotTurnCancelled({ status: "Canceled" }), true);
  assert.equal(pilotTurnCancelled("cancelled"), true);
  assert.equal(pilotTurnCancelled({ status: "completed" }), false);
  assert.equal(pilotTurnCancelled({ kind: "completed", params: { terminal: "completed" } }), false);
  assert.equal(pilotTurnCancelled(null), false);
});

test("failed terminals surface the runtime error text", () => {
  const outcome = {
    kind: "completed",
    params: { terminal: "failed", error: { kind: "modelError", message: "model 500", retryable: true } },
  };
  assert.ok((pilotTurnOutcomeError(outcome) ?? "").includes("model 500"));
  assert.equal(pilotTurnOutcomeError({ kind: "completed", params: { terminal: "completed" } }), null);
});

test("user_input_requested renders a marker; settled and answered stay silent", () => {
  const marker = pilotSystemText({
    seq: 1,
    type: "user_input_requested",
    questions: [{ id: "q1" }, { id: "q2" }],
  });
  assert.ok(marker?.includes("waiting for your input"));
  assert.ok(marker?.includes("2 questions"));
  assert.equal(pilotSystemText({ seq: 2, type: "user_input_settled" }), null);
  assert.equal(pilotSystemText({ seq: 3, type: "user_input_answered" }), null);
});

test("user_input_error surfaces the send failure", () => {
  const text = pilotSystemText({ seq: 1, type: "user_input_error", error: "answer rejected: stale" });
  assert.ok(text?.includes("failed"));
  assert.ok(text?.includes("stale"));
});

const singleQuestion = [
  { id: "q1", selection: { mode: "single" }, options: [{ label: "A" }, { label: "B" }] },
];

test("buildUserInputAnswers shapes single-select answers", () => {
  const result = buildUserInputAnswers(singleQuestion, [
    { questionId: "q1", selectedLabels: ["B"] },
  ]);
  assert.deepEqual(result, {
    ok: true,
    answers: [{ questionId: "q1", selectedLabel: "B" }],
  });
});

test("buildUserInputAnswers validates multi-select bounds and options", () => {
  const questions = [
    { id: "q1", selection: { mode: "multiple", minSelections: 1, maxSelections: 2 }, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
  ];
  assert.deepEqual(
    buildUserInputAnswers(questions, [{ questionId: "q1", selectedLabels: ["A", "C"] }]),
    { ok: true, answers: [{ questionId: "q1", selectedLabels: ["A", "C"] }] },
  );
  assert.equal(
    buildUserInputAnswers(questions, [{ questionId: "q1", selectedLabels: ["A", "B", "C"] }]).ok,
    false,
  );
  assert.equal(
    buildUserInputAnswers(questions, [{ questionId: "q1", selectedLabels: ["Z"] }]).ok,
    false,
  );
  assert.equal(buildUserInputAnswers(questions, []).ok, false);
});

test("buildUserInputAnswers accepts free text and rejects mixed answers", () => {
  assert.deepEqual(
    buildUserInputAnswers(singleQuestion, [{ questionId: "q1", freeText: "something else" }]),
    { ok: true, answers: [{ questionId: "q1", freeText: "something else" }] },
  );
  assert.equal(
    buildUserInputAnswers(singleQuestion, [{ questionId: "q1", selectedLabels: ["A"], freeText: "both" }]).ok,
    false,
  );
  assert.equal(
    buildUserInputAnswers(singleQuestion, [{ questionId: "q1", freeText: "x".repeat(501) }]).ok,
    false,
  );
});

test("backend replacement resets the poll watermark", () => {
  // Same backend: keep filtering against the stored watermark.
  assert.equal(pilotBackendChanged("b1", "b1", 944, 950), false);
  // Recovery swapped the backend id: the old watermark is dead.
  assert.equal(pilotBackendChanged("b-old", "b-new", 944, 150), true);
  // First poll that learns the backend id adopts the live stream.
  assert.equal(pilotBackendChanged(null, "b1", 0, 0), true);
  // Old pilot without backend ids: a restarted sequence still resets.
  assert.equal(pilotBackendChanged(null, undefined, 944, 12), true);
  assert.equal(pilotBackendChanged("b1", undefined, 100, 200), false);
});

test("pilotToolLabel labels tool calls in any status", async () => {
  const { pilotToolLabel } = await import("./pilotEvents.ts");
  const args = JSON.stringify({ command: "sleep 2" });
  assert.equal(pilotToolLabel({ kind: "toolCall", tool: "bash", status: "inProgress", args }), "bash · $ sleep 2");
  assert.equal(pilotToolLabel({ kind: "toolCall", tool: "bash", status: "completed", args }), "bash · $ sleep 2");
  assert.equal(pilotToolLabel({ kind: "agentMessage", status: "completed", text: "hi" }), null);
});

test("pilotItemTime prefers recordedAt (microseconds ok), then the event time", async () => {
  const { pilotItemTime } = await import("./pilotEvents.ts");
  assert.equal(pilotItemTime("2026-10-03T01:21:17.257059Z", undefined)?.toISOString(), "2026-10-03T01:21:17.257Z");
  assert.equal(pilotItemTime(undefined, "2026-10-03T01:21:18.000Z")?.toISOString(), "2026-10-03T01:21:18.000Z");
  assert.equal(pilotItemTime("nope", "also nope"), null);
});

// Tests for the open-session detail polling policy.
// Run: node --test client/src/sessionDetailPoll.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isLiveToTerminalTransition, isStartedListSession, isTurnLiveStatus, shouldEnableSessionDetail, shouldPollSessionDetail, shouldShowConversationLoading } from "./sessionDetailPoll.ts";

test("only queued/running count as live", () => {
  assert.equal(isTurnLiveStatus("queued"), true);
  assert.equal(isTurnLiveStatus("running"), true);
  for (const status of ["succeeded", "failed", "stopped", null, undefined]) {
    assert.equal(isTurnLiveStatus(status), false, String(status));
  }
});

test("detail keeps polling while either the list or the detail copy is live", () => {
  // The strand: list flips terminal first, detail still holds the mid-turn
  // live snapshot. Polling must continue so the view converges on its own.
  assert.equal(shouldPollSessionDetail("succeeded", "running"), true);
  assert.equal(shouldPollSessionDetail("failed", "queued"), true);
  assert.equal(shouldPollSessionDetail("running", "succeeded"), true);
  assert.equal(shouldPollSessionDetail(null, "running"), true);
  assert.equal(shouldPollSessionDetail("running", null), true);
});

test("detail polling stops once both copies agree the session is terminal/idle", () => {
  assert.equal(shouldPollSessionDetail("succeeded", "succeeded"), false);
  assert.equal(shouldPollSessionDetail("failed", "failed"), false);
  assert.equal(shouldPollSessionDetail("stopped", null), false);
  assert.equal(shouldPollSessionDetail(null, null), false);
});

test("live -> terminal is detected per turn, including repeated turns", () => {
  assert.equal(isLiveToTerminalTransition("running", "succeeded"), true);
  assert.equal(isLiveToTerminalTransition("queued", "failed"), true);
  assert.equal(isLiveToTerminalTransition("running", "stopped"), true);
  assert.equal(isLiveToTerminalTransition("running", "running"), false);
  assert.equal(isLiveToTerminalTransition("succeeded", "succeeded"), false);
  // Terminal -> live is the next turn starting, not a finish.
  assert.equal(isLiveToTerminalTransition("succeeded", "running"), false);
  // First sighting of a session is not a transition.
  assert.equal(isLiveToTerminalTransition(null, "succeeded"), false);
  assert.equal(isLiveToTerminalTransition("running", null), false);
});

test("the server having started a session is recognised from the list copy", () => {
  assert.equal(isStartedListSession({ pilot_session_id: "pilot-1", status: "queued" }), true);
  assert.equal(isStartedListSession({ pilot_session_id: null, status: "running" }), true);
  assert.equal(isStartedListSession({ pilot_session_id: null, status: "succeeded" }), true);
  assert.equal(isStartedListSession({ pilot_session_id: null, status: "queued" }), false);
  assert.equal(isStartedListSession({ pilot_session_id: "", status: "queued" }), false);
  assert.equal(isStartedListSession(null), false);
  assert.equal(isStartedListSession(undefined), false);
});

test("a local draft does not gate off the detail query once the list says the session started", () => {
  // Regression: draft X exists while the list returns session X started ->
  // the detail query is enabled and getSession can load the transcript.
  const started = { pilot_session_id: "pilot-1", status: "succeeded" };
  assert.equal(shouldEnableSessionDetail({ selectedId: "X", draftId: "X", listSession: started }), true);
  assert.equal(shouldEnableSessionDetail({ selectedId: "X", draftId: "X", listSession: { pilot_session_id: null, status: "running" } }), true);
  // A genuinely unstarted draft stays gated: no server session to load yet.
  assert.equal(shouldEnableSessionDetail({ selectedId: "X", draftId: "X", listSession: { pilot_session_id: null, status: "queued" } }), false);
  assert.equal(shouldEnableSessionDetail({ selectedId: "X", draftId: "X", listSession: null }), false);
  // Ordinary sessions and no selection behave as before.
  assert.equal(shouldEnableSessionDetail({ selectedId: "X", draftId: "Y", listSession: null }), true);
  assert.equal(shouldEnableSessionDetail({ selectedId: "X", draftId: null, listSession: null }), true);
  assert.equal(shouldEnableSessionDetail({ selectedId: null, draftId: null, listSession: started }), false);
});

test("a pending detail query with list data renders from the list, not an endless spinner", () => {
  assert.equal(shouldShowConversationLoading({ isPending: true, hasDetailSession: true, hasListSession: true }), false);
  assert.equal(shouldShowConversationLoading({ isPending: true, hasDetailSession: false, hasListSession: false }), true);
  assert.equal(shouldShowConversationLoading({ isPending: true, hasDetailSession: true, hasListSession: false }), true);
  assert.equal(shouldShowConversationLoading({ isPending: false, hasDetailSession: false, hasListSession: true }), true);
  assert.equal(shouldShowConversationLoading({ isPending: false, hasDetailSession: true, hasListSession: true }), false);
});

test("App wires the detail query to both copies and forces a full fetch on live -> terminal", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const detailQuery = app.slice(app.indexOf('queryKey: ["code-session", selectedId]'), app.indexOf("const detailLoadedSession"));
  // Poll gating reads the detail query's own status, not only the list's.
  assert.match(detailQuery, /shouldPollSessionDetail\(selectedSession\?\.status, detailStatus\)/);
  // The incremental merge is skipped when a full fetch was requested.
  assert.match(detailQuery, /forceFullDetailRef\.current\.has\(id\)/);
  assert.match(detailQuery, /!forceFull/);
  // The list's live -> terminal transition requests the full fetch and refetches.
  assert.match(app, /isLiveToTerminalTransition\(prev\.status, selectedSession\.status\)/);
  assert.match(app, /forceFullDetailRef\.current\.add\(selectedId\)/);
});

test("App enables the detail query for a converted draft, reconciles draft state, and falls back to the list copy", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const detailQuery = app.slice(app.indexOf('queryKey: ["code-session", selectedId]'), app.indexOf("const detailLoadedSession"));
  assert.match(detailQuery, /enabled: shouldEnableSessionDetail\(\{ selectedId, draftId: draft\?\.id \?\? null, listSession: selectedSession \}\)/);
  // Local start state is cleared once the list shows the session started.
  assert.match(app, /isStartedListSession\(listSession\)/);
  assert.match(app, /setDraft\(\(current\) => \(current\?\.id === id \? null : current\)\)/);
  assert.match(app, /setStartingDraft\(\(current\) => \(current\?\.draft\.id === id \? null : current\)\)/);
  // The loading branch falls back to the list session instead of spinning.
  assert.match(app, /shouldShowConversationLoading\(\{ isPending: detailQuery\.isPending, hasDetailSession: detailSession !== null && detailSession !== undefined, hasListSession: selectedSession !== null \}\)/);
});

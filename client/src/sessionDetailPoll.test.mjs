// Tests for the open-session detail polling policy.
// Run: node --test client/src/sessionDetailPoll.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isLiveToTerminalTransition, isTurnLiveStatus, shouldPollSessionDetail } from "./sessionDetailPoll.ts";

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


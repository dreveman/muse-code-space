// Regression tests for the transcript bottom-snap decision.
// Run: node --test client/src/scrollSnap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSnapToBottom, shouldFollowTranscript } from "./scrollSnap.ts";

test("snaps on first load of a session", () => {
  assert.equal(shouldSnapToBottom(null, "a", 12), true);
});

test("does not snap twice without leaving", () => {
  assert.equal(shouldSnapToBottom("a", "a", 15), false);
});

test("snaps again after leaving and coming back", () => {
  // Leaving clears the stored id (see App.tsx); re-entry must snap.
  assert.equal(shouldSnapToBottom(null, "a", 12), true);
});

test("snaps when switching to a session that has not been snapped", () => {
  assert.equal(shouldSnapToBottom("b", "a", 12), true);
});

test("does not snap before the transcript loads", () => {
  assert.equal(shouldSnapToBottom(null, "a", 0), false);
});

test("follows output once events arrive, including a completed turn's final response", () => {
  assert.equal(shouldFollowTranscript(true, 12, false), true);
});

test("follows the pending echo even before it lands as an event", () => {
  // Regression: the dimmed echo appears without changing the event count,
  // so following on event count alone never scrolled it into view.
  assert.equal(shouldFollowTranscript(true, 12, true), true);
  assert.equal(shouldFollowTranscript(true, 0, true), true);
});

test("pauses following while the reader has scrolled up", () => {
  assert.equal(shouldFollowTranscript(false, 12, false), false);
  assert.equal(shouldFollowTranscript(false, 12, true), false);
  assert.equal(shouldFollowTranscript(false, 0, false), false);
});

test("does not follow an empty transcript with no echo", () => {
  assert.equal(shouldFollowTranscript(true, 0, false), false);
});

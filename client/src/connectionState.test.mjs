import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideSubmit, isConnectionLost, isNetworkFailure } from "./connectionState.ts";

const ok = { browserOnline: true, listFailed: false, sendFailedAt: 0, listUpdatedAt: 1000 };

test("connected when the browser is online and the list loads", () => {
  assert.equal(isConnectionLost(ok), false);
});

test("lost when the browser is offline or the list fetch fails", () => {
  assert.equal(isConnectionLost({ ...ok, browserOnline: false }), true);
  assert.equal(isConnectionLost({ ...ok, listFailed: true }), true);
});

test("a failed send counts as lost until the list loads again", () => {
  assert.equal(isConnectionLost({ ...ok, sendFailedAt: 2000, listUpdatedAt: 1000 }), true);
  assert.equal(isConnectionLost({ ...ok, sendFailedAt: 2000, listUpdatedAt: 2500 }), false);
});

test("only network failures (fetch TypeError) count, not server errors", () => {
  assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkFailure(new Error("action sendInput error: boom")), false);
  assert.equal(isNetworkFailure(null), false);
});

test("submit sends when connected, queues one prompt when not", () => {
  assert.equal(decideSubmit(false, false), "send");
  assert.equal(decideSubmit(false, true), "send");
  assert.equal(decideSubmit(true, false), "queue");
  assert.equal(decideSubmit(true, true), "queue-full");
});

test("a disconnected pilot is visible even while the app can list sessions", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../../server/src/actions.ts", import.meta.url), "utf8");
  assert.ok(actions.includes("pilot_available: false"), "a failed pilot poll is not an empty successful poll");
  assert.ok(actions.includes("pilot_available: true"), "successful poll clears the outage");
  const companion = readFileSync(new URL("./TranscriptCompanion.tsx", import.meta.url), "utf8");
  assert.equal((app.match(/connecting=\{connectionLost \|\| pilotUnavailable\}/g) ?? []).length, 2, "both conversation headers receive app and pilot outage signals");
  assert.ok(companion.includes('connecting ? "is connecting"'), "connection state takes priority in the companion bubble");
  assert.ok(!companion.includes('className="working-spinner"'), "connection status has no spinner");
  assert.ok(!app.includes('className="connection-banner"'), "no separate floating connection indicator");
  assert.ok(!app.includes("Pilot disconnected — transcript saved"), "the user never sees an implementation-specific service name");
  assert.ok(app.includes("liveWork ? 1000 : 5000"), "idle selected agents are rechecked too");
  assert.ok(app.includes("!pilotUnavailable && <WorkingIndicator"), "an unreachable running turn does not keep an unexplained spinner");
});

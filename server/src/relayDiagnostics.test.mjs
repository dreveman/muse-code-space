import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const relay = readFileSync(new URL("../../pilot/muse_relay.py", import.meta.url), "utf8");
const pilot = readFileSync(new URL("../../pilot/pilot.mjs", import.meta.url), "utf8");
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../../client/src/RelayDebug.tsx", import.meta.url), "utf8");

test("VM relay diagnostics are bounded, redacted and readable only through an owner action", () => {
  assert.ok(relay.includes("DIAGNOSTICS = deque(maxlen=100)"));
  assert.ok(relay.includes('self.path == "/__code_space/diagnostics"'));
  assert.ok(relay.includes('self.path == "/__code_space/health"'));
  assert.ok(!relay.includes("MUSERELAY_DEBUG") && !relay.includes("relay-debug.log"), "unsafe header dump was removed");
  const record = relay.slice(relay.indexOf("def record_diagnostic("), relay.indexOf("def fresh_surrogate("));
  assert.ok(!record.includes("Authorization") && !record.includes("surrogate") && !record.includes("headers") && !record.includes("body"));
  assert.ok(pilot.includes('path === "/debug/relay"') && pilot.includes('data.entries.slice(-100)'));
  assert.ok(pilot.includes('["/v1/responses", "/models", "/other"].includes(item.path)'), "pilot never passes raw URL paths to the app");
  const action = actions.slice(actions.indexOf("getRelayDebug: defineAction({"), actions.indexOf("setWireDebug: defineAction({"));
  assert.ok(action.includes("ctx.viewer && !ctx.viewer.isOwner"));
  assert.ok(action.includes('pilotRequest(baseUrl, "/debug/relay"'));
  assert.ok(ui.includes('aria-label="Relay diagnostics"') && ui.includes('entry.stage'));
});

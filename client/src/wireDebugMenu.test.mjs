import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./WireDebug.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

test("the three debugging controls share a DEBUG section after Color mode", () => {
  const color = source.indexOf('role="group" aria-label="Color mode"');
  const debug = source.indexOf('role="group" aria-label="Debug"');
  const raw = source.indexOf('label="Show raw tool output"');
  const log = source.indexOf('label={panelVisible ? "Hide wire log" : "Show wire log"}');
  const relay = source.indexOf('label={relayVisible ? "Hide relay log" : "Show relay log"}');
  assert.ok(color >= 0 && color < debug && debug < raw && raw < log && log < relay);
  assert.ok(source.includes('<details className="session-menu-section" role="group" aria-label="Debug">'));
  assert.ok(source.includes('<summary className="session-menu-heading">Debug'));
  assert.ok(css.includes('.session-menu-heading {'), "Debug uses the same heading style as Color mode");
});

test("wire traffic grows downward and follows only if the reader was at the bottom", () => {
  assert.ok(source.includes('entries.map((entry, index) => ('), "keep the pilot's oldest-first order");
  assert.ok(!source.includes('entries.slice().reverse()'), "the newest event no longer jumps to the top");
  assert.ok(source.includes('wireBodyRef.current.scrollTop = wireBodyRef.current.scrollHeight'));
  assert.ok(source.includes('body.scrollHeight - body.scrollTop - body.clientHeight <= 4'));
  assert.ok(source.includes('followWireRef.current = true; setRelayVisible(false); setPanelVisible'), "reopening the log lands on the latest entry");
  assert.ok(source.includes('<RelayDebugPanel data={relayQuery.data} pending={relayQuery.isPending} />'), "relay diagnostics are a separate panel");
  const relay = readFileSync(new URL("./RelayDebug.tsx", import.meta.url), "utf8");
  assert.ok(relay.includes('recentFailure ? "Recent model request failed" : "Relay reachable"'), "a reachable relay with failed model requests is visibly flagged");
  assert.ok(relay.includes('Logging since:'), "a restarted relay's empty in-memory history is identifiable");
});

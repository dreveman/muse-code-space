// Regression test for the composer submit wiring: on a touch-primary device
// Enter must never submit — only the send button does. The composers must
// feed shouldSubmitOnEnter the environment check directly, never AND-ed with
// the visual-viewport open heuristic that misreported on real devices and
// let a virtual Return submit.
// Run: node --test client/src/composerSubmit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");

test("both composers gate Enter on the environment check alone", () => {
  const calls = app.match(/virtualKeyboard:\s*isVirtualKeyboardEnvironment\(\)[^,]*/g) ?? [];
  assert.equal(calls.length, 2, "expected both composers to pass the environment check");
  for (const call of calls) {
    assert.ok(!call.includes("virtualKeyboardOpenRef"), `viewport heuristic leaked in: ${call}`);
  }
});

test("no viewport keyboard tracking remains in the composer", () => {
  assert.ok(!app.includes("virtualKeyboardOpenRef"), "stale viewport ref must be gone");
  assert.ok(
    !app.includes("isVirtualKeyboardOpen"),
    "viewport open heuristic must not be consulted",
  );
});

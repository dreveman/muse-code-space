// Regression test for the interrupt affordance: the stop-mode send button
// must render cream (#e8d8cf), and the rule must actually win the cascade
// over the default blue send button and the disabled wash.
// Run: node --test client/src/interruptButton.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(root, "theme.css"), "utf8");
const app = readFileSync(path.join(root, "App.tsx"), "utf8");

test("interrupt button renders cream #e8d8cf in stop mode", () => {
  const stopRule = css.match(/\.composer-send\.composer-send-stop\s*\{[^}]*\}/);
  assert.ok(stopRule, "expected a .composer-send.composer-send-stop rule");
  assert.ok(
    stopRule[0].toLowerCase().includes("#e8d8cf"),
    "stop-mode button background must be #e8d8cf",
  );
});

test("stop-mode cream wins over base and disabled backgrounds", () => {
  const baseIndex = css.indexOf(".composer-send {");
  const stopIndex = css.indexOf(".composer-send.composer-send-stop {");
  const disabledIndex = css.indexOf(".composer-send:disabled");
  assert.ok(baseIndex !== -1 && stopIndex !== -1 && disabledIndex !== -1);
  // Later in the file wins at equal specificity; the double-class stop
  // selector already outranks the single-class base, and placing it after
  // the disabled rule keeps cream on the stopping (disabled) button too.
  assert.ok(stopIndex > baseIndex, "stop rule must come after the base send rule");
  assert.ok(stopIndex > disabledIndex, "stop rule must come after the disabled rule");
  assert.ok(
    /\.composer-send\.composer-send-stop:disabled\s*\{[^}]*#e8d8cf/i.test(css),
    "expected a disabled stop-mode rule that keeps #e8d8cf",
  );
});

test("composer swaps the send button for the stop affordance while active", () => {
  assert.ok(
    app.includes("composer-send-stop"),
    "expected App.tsx to apply the stop-mode class",
  );
  assert.ok(
    app.includes("sendingDirection || sessionActive"),
    "expected the stop button to render while a turn is in flight",
  );
});

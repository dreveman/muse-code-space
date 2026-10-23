import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANION_EFFORTS, customCompanionNameError, soulTemplate } from "./companionCustom.ts";

test("the SOUL template is fixed, balanced, and names the companion", () => {
  const soul = soulTemplate("Willow");
  assert.ok(soul.startsWith("You are Willow, an AI-powered code companion."));
  assert.ok(soul.includes("smallest complete, useful result"));
  assert.ok(soul.includes("never claim to have checked something you did not"));
  assert.ok(soul.includes("ask before adding a new one"));
  assert.ok(!soul.includes("this app"));
  assert.equal(soulTemplate(""), soulTemplate("New companion"));
  // Same template regardless of who asks: only the name line differs.
  assert.equal(soulTemplate("Fern").replace("Fern", "X"), soulTemplate("Willow").replace("Willow", "X"));
});

test("companion efforts span minimal to max", () => {
  assert.deepEqual([...COMPANION_EFFORTS], ["minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("custom companion names reject reserved and duplicate names", () => {
  assert.equal(customCompanionNameError("", []), null);
  assert.match(customCompanionNameError("Jolly", []), /reserved/);
  assert.match(customCompanionNameError(" muse ", []), /reserved/);
  assert.match(customCompanionNameError(" willow ", ["Willow"]), /already exists/);
  assert.match(customCompanionNameError("Poppy", ["Poppy"]), /already exists/);
  assert.equal(customCompanionNameError("Fern", ["Willow"]), null);
});

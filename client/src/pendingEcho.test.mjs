// Regression tests for the submitted-prompt echo matcher.
// Run: node --test client/src/pendingEcho.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingHasArrived } from "./pendingEcho.ts";

const user = (content) => ({ kind: "user", content });
const stdout = (content) => ({ kind: "stdout", content });

test("matches the exact prompt", () => {
  assert.equal(pendingHasArrived([user("hello there")], "hello there"), true);
});

test("matches the legacy model-header-wrapped prompt", () => {
  assert.equal(
    pendingHasArrived([user("[Model: muse-spark-1.3 | Effort: high]\n\nhello there")], "hello there"),
    true,
  );
});

test("ignores non-user events with the same text", () => {
  assert.equal(pendingHasArrived([stdout("hello there")], "hello there"), false);
});

test("ignores unrelated prompts", () => {
  assert.equal(pendingHasArrived([user("something else")], "hello there"), false);
});

test("empty transcript means not arrived", () => {
  assert.equal(pendingHasArrived([], "hello there"), false);
});

test("older identical message before the anchor does not clear the echo", () => {
  const events = [user("run it again"), user("something else")];
  assert.equal(pendingHasArrived(events, "run it again", 2), false);
  assert.equal(
    pendingHasArrived([...events, user("run it again")], "run it again", 2),
    true,
  );
});

test("anchor defaults to the whole transcript", () => {
  assert.equal(pendingHasArrived([user("hello there")], "hello there"), true);
});

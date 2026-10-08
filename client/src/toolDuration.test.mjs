import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolDuration, toolElapsedMs } from "./toolDuration.ts";

test("finished tools: tenths under 10s, then s / m s / h m", () => {
  assert.equal(formatToolDuration(84, false), "0s");
  assert.equal(formatToolDuration(412, false), "0.4s");
  assert.equal(formatToolDuration(5_000, false), "5s");
  assert.equal(formatToolDuration(5_999, false), "5.9s");
  assert.equal(formatToolDuration(7_299, false), "7.2s");
  assert.equal(formatToolDuration(9_999, false), "9.9s");
  assert.equal(formatToolDuration(10_000, false), "10s");
  assert.equal(formatToolDuration(42_900, false), "42s");
  assert.equal(formatToolDuration(245_000, false), "4m 5s");
  assert.equal(formatToolDuration(240_000, false), "4m 0s");
  assert.equal(formatToolDuration(3_725_000, false), "1h 2m");
  assert.equal(formatToolDuration(3_600_000, false), "1h 0m");
});

test("running tools tick in whole seconds", () => {
  assert.equal(formatToolDuration(0, true), "0s");
  assert.equal(formatToolDuration(3_900, true), "3s");
  assert.equal(formatToolDuration(61_000, true), "1m 1s");
});

test("elapsed: live while running, frozen once finished, null without a start", () => {
  const start = "2026-10-04T10:00:00.000Z";
  const now = Date.parse("2026-10-04T10:00:12.500Z");
  assert.equal(toolElapsedMs(start, null, now), 12_500);
  assert.equal(toolElapsedMs(start, "2026-10-04T10:00:03.250Z", now), 3_250);
  assert.equal(toolElapsedMs(null, null, now), null);
  assert.equal(toolElapsedMs("garbage", null, now), null);
  assert.equal(toolElapsedMs(start, null, Date.parse(start) - 50), 0, "clock skew never goes negative");
});

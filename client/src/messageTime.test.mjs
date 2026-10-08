// Regression tests for model-response timestamps.
// Run: node --test client/src/messageTime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatMessageTime } from "./messageTime.ts";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-08T13:02:00.000Z");
const before = (ms) => new Date(NOW - ms).toISOString();

test("recent replies show only local time, without a leading zero", () => {
  assert.equal(formatMessageTime("2026-10-08T07:02:00.000Z", NOW, "UTC"), "7:02 AM");
  assert.equal(formatMessageTime("2026-10-08T00:05:00.000Z", NOW, "UTC"), "12:05 AM");
  assert.equal(formatMessageTime("2026-10-08T12:00:00.000Z", NOW, "UTC"), "12:00 PM");
});

test("at 24h switch to Yesterday; at 48h show the exact local date", () => {
  assert.equal(formatMessageTime(before(DAY - 1), NOW, "UTC"), "1:02 PM");
  assert.equal(formatMessageTime(before(DAY), NOW, "UTC"), "Yesterday, 1:02 PM");
  assert.equal(formatMessageTime(before(2 * DAY - 1), NOW, "UTC"), "Yesterday, 1:02 PM");
  assert.equal(formatMessageTime(before(2 * DAY), NOW, "UTC"), "Oct 6, 1:02 PM");
  assert.equal(formatMessageTime("2026-10-07T07:02:00Z", Date.parse("2026-10-10T07:02:00Z"), "UTC"), "Oct 7, 7:02 AM");
});

test("date follows the viewer's time zone; older years are unambiguous", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(formatMessageTime("2026-10-07T01:02:00Z", now, "America/Los_Angeles"), "Oct 6, 6:02 PM");
  assert.equal(formatMessageTime("2026-12-30T19:02:00Z", Date.parse("2027-01-03T19:02:00Z"), "UTC"), "Dec 30, 2026, 7:02 PM");
});

test("invalid or missing input renders nothing, and the UI supplies its updating clock", () => {
  for (const input of ["not-a-date", "", null, undefined]) assert.equal(formatMessageTime(input, NOW, "UTC"), "");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("formatMessageTime(event.created_at, nowMs)"));
  assert.ok(app.includes('window.setInterval(() => setNowMs(Date.now()), 60_000)'), "idle transcripts update their labels without a reload");
});

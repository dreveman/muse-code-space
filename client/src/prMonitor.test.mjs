import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePrMonitor, prMonitorStatusLine, prMonitorSummary } from "./prMonitor.ts";

const row = (overrides = {}) => JSON.stringify({
  id: "mon-1", owner: "dreveman", repo: "muse-code-space", number: 6, title: "Work",
  url: "https://github.com/dreveman/muse-code-space/pull/6", status: "monitoring",
  checks: { passed: 3, failed: 1, pending: 2, failing: ["typecheck"] },
  approvals: 2, comments: 4,
  changes: [{ at: "2026-10-16T00:00:00Z", text: "CI check failed: typecheck" }],
  startedAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:01:00Z",
  ...overrides,
});

test("parsePrMonitor validates the row and fills defaults", () => {
  const parsed = parsePrMonitor(row());
  assert.equal(parsed.number, 6);
  assert.equal(parsed.checks.failing[0], "typecheck");
  assert.equal(parsePrMonitor("{}"), null);
  assert.equal(parsePrMonitor("not json"), null);
  assert.equal(parsePrMonitor(row({ checks: null })).checks.passed, 0);
});

test("status and summary lines read plainly", () => {
  const parsed = parsePrMonitor(row());
  assert.equal(prMonitorStatusLine(parsed), "Monitoring");
  assert.equal(prMonitorStatusLine(parsePrMonitor(row({ status: "merged" }))), "Merged");
  assert.equal(prMonitorSummary(parsed), "CI: 3 passed, 1 failed (typecheck), 2 running · 2 approvals · 4 comments");
  assert.equal(prMonitorSummary(parsePrMonitor(row({ checks: { passed: 0, failed: 0, pending: 0, failing: [] }, approvals: 0, comments: 0 }))), "");
});

test("the transcript renders pr_monitor rows with the dedicated component", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("./PrMonitorEvent.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(app.includes('event.kind === "pr_monitor" ? ('));
  assert.ok(app.includes("<PrMonitorEvent content={event.content} />"));
  assert.ok(component.includes('row.status === "monitoring"'), "spinner only while active");
  assert.ok(css.includes(".pr-monitor-row {"), "row has dedicated styling");
});

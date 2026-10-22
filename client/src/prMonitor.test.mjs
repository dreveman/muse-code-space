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
  assert.equal(parsed.scope, "ci", "rows default to the CI scope");
  assert.equal(prMonitorStatusLine(parsed), "Monitoring CI");
  assert.equal(prMonitorStatusLine(parsePrMonitor(row({ status: "monitoring", scope: "full" }))), "Monitoring");
  assert.equal(prMonitorStatusLine(parsePrMonitor(row({ status: "merged" }))), "Merged");
  assert.equal(prMonitorStatusLine(parsePrMonitor(row({ status: "ci-passed" }))), "CI passed — monitoring ended");
  assert.equal(prMonitorStatusLine(parsePrMonitor(row({ status: "ci-failed" }))), "CI failed — monitoring ended");
  assert.equal(prMonitorStatusLine(parsePrMonitor(row({ status: "ci-none" }))), "No CI checks — monitoring ended");
  assert.equal(prMonitorSummary(parsed), "CI: 3 passed, 1 failed (typecheck), 2 running · 2 approvals · 4 comments");
  assert.equal(prMonitorSummary(parsePrMonitor(row({ checks: { passed: 0, failed: 0, pending: 0, failing: [] }, approvals: 0, comments: 0 }))), "");
});

test("the transcript renders pr_monitor rows with the dedicated component", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("./PrMonitorEvent.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../drizzle/0024_add_pr_monitor_events.sql", import.meta.url), "utf8");
  const journal = readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8");
  assert.ok(app.includes('event.kind === "pr_monitor" ? ('));
  assert.ok(app.includes("<PrMonitorEvent content={event.content} />"));
  assert.ok(app.includes('(ev.kind === "pr_monitor" && parsePrMonitor(ev.content)?.status === "monitoring")'), "incremental getSession cutoff includes active pr_monitor rows");
  assert.ok(app.includes('if (event.kind === "pr_monitor") return parsePrMonitor(event.content)?.status === "monitoring";'), "session keeps live polling while a PR monitor is active");
  assert.ok(component.includes('row.status === "monitoring"'), "spinner only while active");
  assert.ok(css.includes(".pr-monitor-row {"), "row has dedicated styling");
  assert.ok(journal.includes('"0024_add_pr_monitor_events"'), "migration is registered in drizzle journal");
  for (const required of ["'pr_monitor'", "system_is_error", "tool_details", "CREATE INDEX output_events_session_id_idx", "CREATE INDEX output_events_item_idx"]) {
    assert.ok(migration.includes(required), `migration preserves ${required}`);
  }
});

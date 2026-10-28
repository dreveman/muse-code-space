// Run: node --test server/src/companionStatistics.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPrMonitorSnapshot,
  companionAccomplishments,
  createdPullRequestFromToolEvent,
  summarizeCompanionStatistics,
} from "./companionStatistics.ts";

const createEvent = (overrides = {}) => ({
  kind: "tool",
  content: "Created PR #6",
  tool_details: {
    tool: "mcp__code_space__github_create_pr",
    args: JSON.stringify({ title: "Add stats", head: "stats", base: "main" }),
    status: "completed",
    failureReason: null,
    output: "Created PR #6 Add stats\nhttps://github.com/o/r/pull/6\nstats → main",
    ...overrides,
  },
});

test("extracts a created PR from a completed github_create_pr tool event", () => {
  assert.deepEqual(createdPullRequestFromToolEvent(createEvent()), {
    repo: "o/r", number: 6, title: "Add stats", url: "https://github.com/o/r/pull/6", draft: false,
  });
});

test("extracts a created PR from a gh pr create bash event", () => {
  const created = createdPullRequestFromToolEvent({
    kind: "tool",
    content: "Ran bash",
    tool_details: {
      tool: "bash",
      args: JSON.stringify({ command: "gh pr create --title \"Second\"" }),
      status: "completed",
      failureReason: null,
      visibleOutput: "https://github.com/o/r/pull/7\n",
    },
  });
  assert.equal(created?.number, 7);
});

test("ignores failed, incomplete, and non-creation tool events", () => {
  assert.equal(createdPullRequestFromToolEvent(createEvent({ status: "inProgress" })), null);
  assert.equal(createdPullRequestFromToolEvent(createEvent({ failureReason: "boom" })), null);
  assert.equal(createdPullRequestFromToolEvent(createEvent({ output: "Failed: nope" })), null);
  assert.equal(createdPullRequestFromToolEvent(createEvent({ tool: "mcp__code_space__github_pr_status" })), null);
  assert.equal(createdPullRequestFromToolEvent({ kind: "user", content: "hi", tool_details: null }), null);
});

const trackedPr = (overrides = {}) => ({
  companionId: "poppy", repo: "o/r", number: 6, state: "open",
  linesCounted: false, additions: null, deletions: null, filesChanged: null, ...overrides,
});

test("a merge counts its lines exactly once", () => {
  const merged = applyPrMonitorSnapshot(trackedPr(), {
    status: "merged", additions: 120, deletions: 30, filesChanged: 4,
  });
  assert.equal(merged.tracked.state, "merged");
  assert.deepEqual(merged.linesDelta, { additions: 120, deletions: 30, filesChanged: 4 });

  const replayed = applyPrMonitorSnapshot(merged.tracked, {
    status: "merged", additions: 120, deletions: 30, filesChanged: 4,
  });
  assert.equal(replayed.linesDelta, null);
});

test("a merge without line counts waits for an enriched snapshot", () => {
  const merged = applyPrMonitorSnapshot(trackedPr(), { status: "merged" });
  assert.equal(merged.tracked.state, "merged");
  assert.equal(merged.linesDelta, null);
  assert.equal(merged.tracked.linesCounted, false);

  const enriched = applyPrMonitorSnapshot(merged.tracked, {
    status: "merged", additions: 10, deletions: 2, filesChanged: 1,
  });
  assert.deepEqual(enriched.linesDelta, { additions: 10, deletions: 2, filesChanged: 1 });
});

test("closed and reopened transitions never count lines", () => {
  const closed = applyPrMonitorSnapshot(trackedPr(), { status: "closed", additions: 5, deletions: 1, filesChanged: 1 });
  assert.equal(closed.tracked.state, "closed");
  assert.equal(closed.linesDelta, null);

  const reopened = applyPrMonitorSnapshot(closed.tracked, { status: "monitoring" });
  assert.equal(reopened.tracked.state, "open");
  assert.equal(reopened.linesDelta, null);
});

test("summary derives PR counts and net lines from tracked rows and counters", () => {
  const summary = summarizeCompanionStatistics("poppy",
    { linesAdded: 200, linesRemoved: 50, filesChanged: 9, toolCalls: 42, userTurns: 7, runtimeMs: 90_000, lastActiveAt: "2026-10-28T00:00:00.000Z" },
    [trackedPr(), trackedPr({ number: 7, state: "merged", linesCounted: true }), trackedPr({ number: 8, state: "closed" })]);
  assert.deepEqual(summary, {
    companion_id: "poppy",
    prs_created: 3, prs_merged: 1, prs_closed: 1, prs_open: 1,
    merge_rate: 0.5,
    lines_added: 200, lines_removed: 50, net_lines: 150, files_changed: 9,
    tool_calls: 42, user_turns: 7, runtime_ms: 90_000,
    last_active_at: "2026-10-28T00:00:00.000Z",
  });
});

test("accomplishments report the highest earned tier and the next target", () => {
  const accomplishments = companionAccomplishments({ prs_merged: 12, lines_added: 1_500, files_changed: 40 });
  assert.deepEqual(accomplishments, [
    { id: "prs-landed", label: "PRs landed", icon: "medal", earnedThreshold: 10, nextThreshold: 25, current: 12 },
    { id: "lines-shipped", label: "Lines shipped", icon: "badge", earnedThreshold: 1_000, nextThreshold: 10_000, current: 1_500 },
    { id: "files-touched", label: "Files touched", icon: "badge", earnedThreshold: 25, nextThreshold: 100, current: 40 },
  ]);
});

test("accomplishments start unearned and top out at the trophy tier", () => {
  const fresh = companionAccomplishments({ prs_merged: 0, lines_added: 0, files_changed: 0 });
  assert.ok(fresh.every((item) => item.earnedThreshold === 0 && item.icon === "badge"));
  const maxed = companionAccomplishments({ prs_merged: 120, lines_added: 60_000, files_changed: 600 });
  assert.ok(maxed.every((item) => item.icon === "trophy" && item.nextThreshold === null));
});

test("summary is all zeros before anything is tracked", () => {
  const summary = summarizeCompanionStatistics("poppy", null, []);
  assert.equal(summary.prs_created, 0);
  assert.equal(summary.merge_rate, null);
  assert.equal(summary.net_lines, 0);
  assert.equal(summary.last_active_at, null);
});

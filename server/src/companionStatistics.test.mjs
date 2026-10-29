// Run: node --test server/src/companionStatistics.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPrMonitorSnapshot,
  companionAccomplishments,
  createdPullRequestFromToolEvent,
  formatAccomplishmentNotice,
  newlyEarnedAccomplishments,
  parseAccomplishmentNotice,
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

test("newlyEarnedAccomplishments detects newly crossed badge, medal, and trophy thresholds", () => {
  const noneYet = newlyEarnedAccomplishments(
    { prs_merged: 0, lines_added: 20, files_changed: 2 },
    { prs_merged: 0, lines_added: 80, files_changed: 9 },
  );
  assert.deepEqual(noneYet, []);

  const firstMerge = newlyEarnedAccomplishments(
    { prs_merged: 0, lines_added: 80, files_changed: 9 },
    { prs_merged: 1, lines_added: 120, files_changed: 11 },
  );
  assert.deepEqual(firstMerge, [
    { id: "prs-landed", label: "PRs landed", icon: "badge", tierName: "Badge", threshold: 1, current: 1, milestoneText: "1 PR landed" },
    { id: "lines-shipped", label: "Lines shipped", icon: "badge", tierName: "Badge", threshold: 100, current: 120, milestoneText: "100 lines shipped" },
    { id: "files-touched", label: "Files touched", icon: "badge", tierName: "Badge", threshold: 10, current: 11, milestoneText: "10 files touched" },
  ]);

  const medalAndTrophy = newlyEarnedAccomplishments(
    { prs_merged: 9, lines_added: 9_500, files_changed: 490 },
    { prs_merged: 10, lines_added: 10_200, files_changed: 510 },
  );
  assert.deepEqual(medalAndTrophy, [
    { id: "prs-landed", label: "PRs landed", icon: "medal", tierName: "Medal", threshold: 10, current: 10, milestoneText: "10 PRs landed" },
    { id: "lines-shipped", label: "Lines shipped", icon: "medal", tierName: "Medal", threshold: 10_000, current: 10_200, milestoneText: "10,000 lines shipped" },
    { id: "files-touched", label: "Files touched", icon: "trophy", tierName: "Trophy", threshold: 500, current: 510, milestoneText: "500 files touched" },
  ]);
});

test("formatAccomplishmentNotice and parseAccomplishmentNotice round-trip single and combined milestones", () => {
  const single = formatAccomplishmentNotice({
    companionName: "Poppy",
    items: [{ icon: "medal", milestoneText: "10,000 lines shipped" }],
  });
  assert.equal(single, "[Accomplishment:medal] Poppy earned a Medal · 10,000 lines shipped");
  assert.deepEqual(parseAccomplishmentNotice(single), {
    companionName: "Poppy",
    icons: ["medal"],
    summaryText: "earned a Medal",
    milestones: ["10,000 lines shipped"],
  });

  const combined = formatAccomplishmentNotice({
    companionName: "Poppy",
    items: [
      { icon: "badge", milestoneText: "1 PR landed" },
      { icon: "badge", milestoneText: "100 lines shipped" },
      { icon: "badge", milestoneText: "10 files touched" },
    ],
  });
  assert.equal(combined, "[Accomplishment:badge,badge,badge] Poppy earned 3 Badges · 1 PR landed · 100 lines shipped · 10 files touched");
  assert.deepEqual(parseAccomplishmentNotice(combined), {
    companionName: "Poppy",
    icons: ["badge", "badge", "badge"],
    summaryText: "earned 3 Badges",
    milestones: ["1 PR landed", "100 lines shipped", "10 files touched"],
  });

  const mixed = formatAccomplishmentNotice({
    companionName: "Remy",
    items: [
      { icon: "medal", milestoneText: "10 PRs landed" },
      { icon: "badge", milestoneText: "1,000 lines shipped" },
    ],
  });
  assert.equal(mixed, "[Accomplishment:medal,badge] Remy earned a Medal and a Badge · 10 PRs landed · 1,000 lines shipped");
  assert.deepEqual(parseAccomplishmentNotice(mixed), {
    companionName: "Remy",
    icons: ["medal", "badge"],
    summaryText: "earned a Medal and a Badge",
    milestones: ["10 PRs landed", "1,000 lines shipped"],
  });

  assert.equal(parseAccomplishmentNotice("Ordinary system notice"), null);
});

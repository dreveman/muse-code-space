// Run: node --test client/src/ownedPullRequests.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownedPullRequestsFromEvents } from "./ownedPullRequests.ts";

test("tracks PRs created by github_create_pr and gh pr create, and enriches with pr_monitor state", () => {
  const events = [
    {
      kind: "tool",
      content: "Created PR #6",
      tool_details: {
        tool: "mcp__code_space__github_create_pr",
        args: JSON.stringify({ title: "Add repo picker", head: "repo-picker", base: "main" }),
        status: "completed",
        failureReason: null,
        visibleOutput: [
          "Created PR #6 Add repo picker",
          "https://github.com/dreveman/muse-code-space/pull/6",
          "repo-picker → main",
        ].join("\n"),
      },
    },
    {
      kind: "tool",
      content: "Ran bash",
      tool_details: {
        tool: "bash",
        args: JSON.stringify({ command: "gh pr create --title \"Second PR\" --body \"test\"" }),
        status: "completed",
        failureReason: null,
        visibleOutput: "https://github.com/dreveman/muse-code-space/pull/7\n",
      },
    },
    {
      kind: "pr_monitor",
      content: JSON.stringify({
        id: "s1:dreveman/muse-code-space#6",
        owner: "dreveman",
        repo: "muse-code-space",
        number: 6,
        title: "Add repo picker",
        url: "https://github.com/dreveman/muse-code-space/pull/6",
        status: "merged",
        checks: { passed: 2, failed: 0, pending: 0, failing: [] },
        approvals: 1,
        comments: 0,
        changes: [],
        startedAt: "2026-10-18T17:00:00Z",
        updatedAt: "2026-10-18T18:00:00Z",
      }),
    },
  ];

  const owned = ownedPullRequestsFromEvents(events);
  assert.equal(owned.length, 2);
  assert.deepEqual(owned[0], {
    key: "dreveman/muse-code-space#6",
    repo: "dreveman/muse-code-space",
    number: 6,
    title: "Add repo picker",
    url: "https://github.com/dreveman/muse-code-space/pull/6",
    branchLine: "repo-picker → main",
    draft: false,
    state: "merged",
    checks: "success",
    checksSummary: "CI: 2 passed · 1 approval",
    latestChange: null,
    monitoring: false,
  });
  assert.deepEqual(owned[1], {
    key: "dreveman/muse-code-space#7",
    repo: "dreveman/muse-code-space",
    number: 7,
    title: null,
    url: "https://github.com/dreveman/muse-code-space/pull/7",
    branchLine: null,
    draft: false,
    state: "open",
    checks: null,
    checksSummary: null,
    latestChange: null,
    monitoring: false,
  });
});

test("ignores failed tool calls and non-creation tools", () => {
  const events = [
    {
      kind: "tool",
      content: "Checked PR #6",
      tool_details: {
        tool: "mcp__code_space__github_get_pr",
        args: JSON.stringify({ number: 6 }),
        status: "completed",
        failureReason: null,
        visibleOutput: "PR #6 Title — open\nhttps://github.com/dreveman/muse-code-space/pull/6",
      },
    },
    {
      kind: "tool",
      content: "Failed PR create",
      tool_details: {
        tool: "mcp__code_space__github_create_pr",
        args: JSON.stringify({ title: "Nope" }),
        status: "completed",
        failureReason: null,
        visibleOutput: "Failed: Validation Failed",
      },
    },
  ];
  assert.deepEqual(ownedPullRequestsFromEvents(events), []);
});

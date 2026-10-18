// Run: node --test pilot/vcsSmartlog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SMARTLOG_GIT_FORMAT,
  parseGitSmartlogCommits,
  parseGitWorkingTreeStatus,
  readGitVcsStatus,
} from "./vcsSmartlog.mjs";

test("parseGitWorkingTreeStatus parses porcelain status and numstat churn", () => {
  const porcelain = [
    " M client/src/App.tsx",
    "?? client/src/SmartLogPanel.tsx",
    "D  old-file.ts",
  ].join("\n");
  const numstat = [
    "14\t3\tclient/src/App.tsx",
    "0\t22\told-file.ts",
  ].join("\n");

  const status = parseGitWorkingTreeStatus(porcelain, numstat);
  assert.equal(status.uncommittedFileCount, 3);
  assert.equal(status.totalAdditions, 14);
  assert.equal(status.totalDeletions, 25);
  assert.deepEqual(status.files, [
    { path: "client/src/App.tsx", status: "M", additions: 14, deletions: 3 },
    { path: "client/src/SmartLogPanel.tsx", status: "A", additions: null, deletions: null },
    { path: "old-file.ts", status: "D", additions: 0, deletions: 22 },
  ]);
});

test("parseGitSmartlogCommits classifies draft stack commits and public remote commits", () => {
  const h1 = "1111111111111111111111111111111111111111";
  const h2 = "2222222222222222222222222222222222222222";
  const h3 = "3333333333333333333333333333333333333333";
  const raw = [
    `${h1}\x1f${h2}\x1fDavid Reveman\x1f2026-10-18T18:00:00Z\x1fHEAD -> repo-picker\x1fAdd Smart Log support\x1e`,
    `${h2}\x1f${h3}\x1fDavid Reveman\x1f2026-10-18T17:00:00Z\x1f\x1fAdd repo picker for new companions\x1e`,
    `${h3}\x1f\x1fDavid Reveman\x1f2026-10-18T15:00:00Z\x1forigin/main, origin/HEAD, main\x1fInitial main commit\x1e`,
  ].join("\n");

  const commits = parseGitSmartlogCommits(raw, {
    headFullHash: h1,
    publicHashes: new Set([h3]),
  });

  assert.equal(commits.length, 3);
  assert.deepEqual(commits[0], {
    hash: "111111111111",
    parents: ["222222222222"],
    phase: "draft",
    isDot: true,
    title: "Add Smart Log support",
    author: "David Reveman",
    date: "2026-10-18T18:00:00Z",
    bookmarks: ["repo-picker"],
    remoteBookmarks: [],
  });
  assert.equal(commits[1].phase, "draft");
  assert.equal(commits[1].isDot, false);
  assert.deepEqual(commits[2], {
    hash: "333333333333",
    parents: [],
    phase: "public",
    isDot: false,
    title: "Initial main commit",
    author: "David Reveman",
    date: "2026-10-18T15:00:00Z",
    bookmarks: ["main"],
    remoteBookmarks: ["origin/main"],
  });
});

test("readGitVcsStatus returns isGitCheckout: false when directory is not a git repo", async () => {
  const status = await readGitVcsStatus({
    dir: "/tmp/not-a-repo",
    gitExec: async () => null,
  });
  assert.equal(status.isGitCheckout, false);
  assert.equal(status.branch, null);
  assert.equal(status.headSha, null);
  assert.deepEqual(status.smartlogCommits, []);
});

test("readGitVcsStatus returns branch, headSha, and smartlog when inside a git work tree", async () => {
  const h1 = "abcdef1234567890abcdef1234567890abcdef12";
  const status = await readGitVcsStatus({
    dir: "/tmp/repo",
    gitExec: async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true";
      if (args[0] === "symbolic-ref") return "repo-picker";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return h1;
      if (args[0] === "status") return "";
      if (args[0] === "diff") return "";
      if (args[0] === "rev-list") return h1;
      if (args[0] === "log") {
        return `${h1}\x1f\x1fDavid Reveman\x1f2026-10-18T18:00:00Z\x1fHEAD -> repo-picker, origin/main\x1fCommit subject\x1e`;
      }
      return null;
    },
  });
  assert.equal(status.isGitCheckout, true);
  assert.equal(status.branch, "repo-picker");
  assert.equal(status.headSha, "abcdef123456");
  assert.equal(status.smartlogCommits.length, 1);
  assert.ok(SMARTLOG_GIT_FORMAT.includes("%H"));
});

// Run: node --test client/src/smartlogLayout.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSmartlogLayout,
  displaySmartlogBookmarks,
  filterSmartlogForDisplay,
  smartlogCheckoutLabel,
} from "./smartlogLayout.ts";

test("smartlogCheckoutLabel returns branch name or short SHA only when isGitCheckout is true", () => {
  assert.equal(smartlogCheckoutLabel(null), null);
  assert.equal(smartlogCheckoutLabel({ isGitCheckout: false, branch: "main", headSha: "1234567" }), null);
  assert.equal(smartlogCheckoutLabel({ isGitCheckout: true, branch: "repo-picker", headSha: "7968c76" }), "repo-picker");
  assert.equal(smartlogCheckoutLabel({ isGitCheckout: true, branch: null, headSha: "7968c7612345" }), "7968c7612345");
});

test("computeSmartlogLayout places public spine on lane 0 and draft stack on lane 1 converging into base", () => {
  const commits = [
    {
      hash: "draft2222222",
      parents: ["draft1111111"],
      phase: "draft",
      isDot: true,
      title: "Second draft commit",
      author: "David Reveman",
      date: "2026-10-18T18:00:00Z",
      bookmarks: ["feature"],
      remoteBookmarks: [],
    },
    {
      hash: "draft1111111",
      parents: ["pub000000000"],
      phase: "draft",
      isDot: false,
      title: "First draft commit",
      author: "David Reveman",
      date: "2026-10-18T17:00:00Z",
      bookmarks: [],
      remoteBookmarks: [],
    },
    {
      hash: "pub000000000",
      parents: [],
      phase: "public",
      isDot: false,
      title: "Base trunk commit",
      author: "David Reveman",
      date: "2026-10-18T16:00:00Z",
      bookmarks: ["main"],
      remoteBookmarks: ["origin/main"],
    },
  ];

  const visible = filterSmartlogForDisplay(commits);
  assert.equal(visible.length, 3);
  const rows = computeSmartlogLayout(visible);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].lane, 1, "head draft sits on lane 1");
  assert.equal(rows[1].lane, 1, "parent draft continues on lane 1");
  assert.deepEqual(rows[1].splits, [0], "first draft splits into public lane 0");
  assert.equal(rows[2].lane, 0, "public base sits on lane 0");
  assert.deepEqual(displaySmartlogBookmarks(commits[2]), ["main", "origin/main"]);
});

// Run: node --test server/src/repoSlug.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepoSlug } from "./repoSlug.ts";

test("parseRepoSlug canonicalizes owner/repo and github.com URLs", () => {
  assert.equal(parseRepoSlug("dreveman/muse-code-space"), "dreveman/muse-code-space");
  assert.equal(parseRepoSlug("https://github.com/dreveman/muse-code-space.git"), "dreveman/muse-code-space");
  assert.equal(parseRepoSlug("git@github.com:dreveman/muse-code-space.git"), "dreveman/muse-code-space");
  assert.equal(parseRepoSlug("ssh://git@github.com/dreveman/muse-code-space"), "dreveman/muse-code-space");
});

test("parseRepoSlug rejects everything else", () => {
  for (const bad of ["", "onlyowner", "a/b/c", "https://gitlab.com/o/r", "https://github.com/o/r/issues", "../o/r", null, 7]) {
    assert.equal(parseRepoSlug(bad), null, JSON.stringify(bad));
  }
});

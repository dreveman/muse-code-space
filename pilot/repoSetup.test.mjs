// Run: node --test pilot/repoSetup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureRepoCloned, listGitHubRepos, originSlug, parseGitCloneProgress, parseRepoInput } from "./repoSetup.mjs";

test("parseRepoInput accepts owner/repo and github.com URLs", () => {
  const expected = {
    owner: "dreveman", repo: "muse-code-space",
    slug: "dreveman/muse-code-space",
    cloneUrl: "https://github.com/dreveman/muse-code-space.git",
  };
  assert.deepEqual(parseRepoInput("dreveman/muse-code-space"), expected);
  assert.deepEqual(parseRepoInput("  dreveman/muse-code-space  "), expected);
  assert.deepEqual(parseRepoInput("https://github.com/dreveman/muse-code-space"), expected);
  assert.deepEqual(parseRepoInput("https://github.com/dreveman/muse-code-space.git"), expected);
  assert.deepEqual(parseRepoInput("git@github.com:dreveman/muse-code-space.git"), expected);
  assert.deepEqual(parseRepoInput("ssh://git@github.com/dreveman/muse-code-space.git"), expected);
});

test("parseRepoInput rejects non-GitHub, partial, and unsafe input", () => {
  for (const bad of [
    "", "onlyowner", "a/b/c", "owner/", "/repo", "owner/re po",
    "https://gitlab.com/owner/repo", "https://github.com/onlyowner",
    "https://github.com/owner/repo/issues", "https://user:pw@github.com/owner/repo",
    "../owner/repo", "owner/../repo", null, undefined, 42,
  ]) {
    assert.equal(parseRepoInput(bad), null, JSON.stringify(bad));
  }
});

test("originSlug identifies https, ssh, and broker-rewritten remotes", () => {
  assert.equal(originSlug("https://github.com/Dreveman/Muse-Code-Space.git"), "dreveman/muse-code-space");
  assert.equal(originSlug("git@github.com:dreveman/muse-code-space.git"), "dreveman/muse-code-space");
  assert.equal(originSlug("https://127.0.0.1:443/dreveman/muse-code-space"), "dreveman/muse-code-space");
  assert.equal(originSlug("not a remote"), null);
  assert.equal(originSlug(null), null);
});

function fakeBroker(routes) {
  const calls = [];
  return {
    calls,
    async brokerRequest(method, path) {
      calls.push(`${method} ${path}`);
      return routes[path] ?? { status: 404, json: { message: "Not Found" } };
    },
  };
}

test("listGitHubRepos prefers GraphQL viewer.topRepositories and preserves its rank order", async () => {
  const { brokerRequest, calls } = fakeBroker({
    "/graphql": {
      status: 200,
      json: {
        data: {
          viewer: {
            topRepositories: {
              nodes: [
                { nameWithOwner: "google/perfetto", isPrivate: false, updatedAt: "2026-01-01T00:00:00Z", defaultBranchRef: { name: "main" } },
                { nameWithOwner: "dreveman/muse-code-space", isPrivate: true, updatedAt: "2026-02-01T00:00:00Z", description: "Code Space" },
              ],
            },
          },
        },
      },
    },
  });
  const result = await listGitHubRepos({ enabled: () => true, brokerRequest });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.repos.map((r) => r.slug), ["google/perfetto", "dreveman/muse-code-space"]);
  assert.equal(result.repos[0].default_branch, "main");
  assert.equal(result.repos[1].private, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "POST /graphql");
});

test("listGitHubRepos maps and dedupes /user/repos when GraphQL topRepositories is unavailable", async () => {
  const { brokerRequest, calls } = fakeBroker({
    "/user/repos?per_page=100&sort=updated&direction=desc": {
      status: 200,
      json: [
        { full_name: "o/old", private: false, updated_at: "2026-01-01T00:00:00Z", default_branch: "main" },
        { full_name: "o/new", private: true, updated_at: "2026-02-01T00:00:00Z", description: "Newer" },
        { full_name: "O/NEW", private: true, updated_at: "2026-02-01T00:00:00Z" },
        { full_name: "bad" },
      ],
    },
  });
  const result = await listGitHubRepos({ enabled: () => true, brokerRequest });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.repos.map((r) => r.slug), ["o/new", "o/old"]);
  assert.equal(result.repos[0].private, true);
  assert.equal(result.repos[0].html_url, "https://github.com/o/new");
  assert.equal(calls.length, 2);
});

test("listGitHubRepos falls back to installation repositories for App tokens", async () => {
  const { brokerRequest } = fakeBroker({
    "/installation/repositories?per_page=100": {
      status: 200,
      json: { total_count: 1, repositories: [{ full_name: "o/app-repo", private: true }] },
    },
  });
  const result = await listGitHubRepos({ enabled: () => true, brokerRequest });
  assert.deepEqual(result.repos.map((r) => r.slug), ["o/app-repo"]);
});

test("listGitHubRepos reports disabled and broker failures", async () => {
  assert.deepEqual(
    await listGitHubRepos({ enabled: () => false, brokerRequest: async () => { throw new Error("must not be called"); } }),
    { enabled: false, repos: [] },
  );
  const { brokerRequest } = fakeBroker({});
  await assert.rejects(listGitHubRepos({ enabled: () => true, brokerRequest }), /HTTP 404/);
});

test("ensureRepoCloned clones into a missing or empty directory", async () => {
  const repo = parseRepoInput("o/r");
  for (const entries of [null, []]) {
    const clones = [];
    const result = await ensureRepoCloned({
      dir: "/w/x", repo,
      gitClone: async (url, dir) => { clones.push([url, dir]); },
      gitOrigin: async () => null,
      listDir: () => entries,
    });
    assert.deepEqual(result, { cloned: true, reused: false });
    assert.deepEqual(clones, [["https://github.com/o/r.git", "/w/x"]]);
  }
});

test("ensureRepoCloned reuses the same repo on retry and refuses any other content", async () => {
  const repo = parseRepoInput("o/r");
  const reused = await ensureRepoCloned({
    dir: "/w/x", repo,
    gitClone: async () => { throw new Error("must not clone"); },
    gitOrigin: async () => "git@github.com:o/r.git",
    listDir: () => [".git", "README.md"],
  });
  assert.deepEqual(reused, { cloned: false, reused: true });

  await assert.rejects(ensureRepoCloned({
    dir: "/w/x", repo,
    gitClone: async () => {},
    gitOrigin: async () => "https://github.com/other/repo.git",
    listDir: () => [".git"],
  }), /different repository/);

  await assert.rejects(ensureRepoCloned({
    dir: "/w/x", repo,
    gitClone: async () => {},
    gitOrigin: async () => null,
    listDir: () => ["notes.txt"],
  }), /not empty/);
});

test("parseGitCloneProgress extracts phase, percentage, and transfer size from git stderr", () => {
  let state = parseGitCloneProgress("Cloning into '/tmp/ws'...\nremote: Enumerating objects: 4120, done.\n");
  assert.deepEqual(state, { phase: "Enumerating objects", percent: null, transferred: null });
  state = parseGitCloneProgress("Receiving objects:  42% (1730/4120), 14.20 MiB | 9.10 MiB/s\r", state);
  assert.deepEqual(state, { phase: "Receiving objects", percent: 42, transferred: "14.20 MiB" });
  state = parseGitCloneProgress("Resolving deltas:  85% (885/1041)\r", state);
  assert.deepEqual(state, { phase: "Resolving deltas", percent: 85, transferred: "14.20 MiB" });
});

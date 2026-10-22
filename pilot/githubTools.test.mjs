import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGitHubToolset, parseGitHubRemote, GITHUB_TOOLS } from "./githubTools.mjs";
import { handleMcpRequest, MCP_TOOLS } from "./mcp.mjs";

const entry = { logId: "s1", meta: { name: "nova", workspaceRoot: "/w/nova" } };

function fakeToolset({ enabled = true, context = {}, responses = {} } = {}) {
  const calls = [];
  const toolset = createGitHubToolset({
    enabled: () => enabled,
    gitContext: async () => context,
    brokerRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      const canned = responses[`${method} ${path}`] ?? responses[path];
      if (!canned) return { status: 404, json: { message: "Not Found" } };
      return canned;
    },
  });
  return { toolset, calls };
}

test("parseGitHubRemote accepts https, scp-style, and broker URLs", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/dreveman/muse-code-space.git"), { owner: "dreveman", repo: "muse-code-space" });
  assert.deepEqual(parseGitHubRemote("https://github.com/dreveman/muse-code-space"), { owner: "dreveman", repo: "muse-code-space" });
  assert.deepEqual(parseGitHubRemote("git@github.com:dreveman/muse-code-space.git"), { owner: "dreveman", repo: "muse-code-space" });
  assert.deepEqual(parseGitHubRemote("https://127.0.0.1/dreveman/muse-code-space.git"), { owner: "dreveman", repo: "muse-code-space" });
  assert.equal(parseGitHubRemote("https://github.com/onlyowner"), null);
  assert.equal(parseGitHubRemote(""), null);
  assert.equal(parseGitHubRemote(undefined), null);
});

test("github tools are hidden and refuse when GitHub is not set up", async () => {
  const { toolset } = fakeToolset({ enabled: false });
  const result = await toolset.call(entry, "github_list_prs", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /isn't set up/);
});

test("github_create_pr infers repo and head from the workspace", async () => {
  const { toolset, calls } = fakeToolset({
    context: { remote: "https://github.com/dreveman/muse-code-space.git", branch: "dev/nova/x" },
    responses: {
      "POST /repos/dreveman/muse-code-space/pulls": {
        status: 201,
        json: { number: 7, title: "Fix it", html_url: "https://github.com/dreveman/muse-code-space/pull/7", draft: false, head: { ref: "dev/nova/x" }, base: { ref: "main" } },
      },
    },
  });
  const result = await toolset.call(entry, "github_create_pr", { title: "Fix it", body: "details" });
  assert.equal(result.isError, undefined);
  assert.match(result.text, /Created PR #7 Fix it/);
  assert.match(result.text, /pull\/7/);
  assert.deepEqual(calls[0].body, { title: "Fix it", head: "dev/nova/x", draft: false, body: "details" });
});

test("github_create_pr validates input and surfaces GitHub errors", async () => {
  const { toolset } = fakeToolset({
    responses: {
      "POST /repos/o/r/pulls": {
        status: 422,
        json: { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] },
      },
    },
  });
  assert.equal((await toolset.call(entry, "github_create_pr", {})).isError, true);
  assert.equal((await toolset.call(entry, "github_create_pr", { title: "x", repo: "bad" })).isError, true);
  const failed = await toolset.call(entry, "github_create_pr", { title: "x", repo: "o/r", head: "gone" });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /Validation Failed \(PullRequest head invalid\)/);
  const noBranch = fakeToolset({ context: { remote: "https://github.com/o/r.git" } });
  assert.match((await noBranch.toolset.call(entry, "github_create_pr", { title: "x" })).text, /pass `head` explicitly/);
});

function monitorSpy() {
  const started = [];
  return {
    started,
    monitors: {
      start: async (spec) => {
        started.push(spec);
        return { created: true, monitor: { active: true, status: "monitoring", snapshot: { title: "Work", checks: { passed: 1, failed: 0, pending: 2, failing: [] } } } };
      },
      stop: () => null,
    },
  };
}

test("github_create_pr monitors CI by default and can opt out", async () => {
  const spy = monitorSpy();
  const responses = {
    "POST /repos/o/r/pulls": {
      status: 201,
      json: { number: 7, title: "Fix it", html_url: "https://github.com/o/r/pull/7", draft: false, head: { ref: "feat" }, base: { ref: "main" } },
    },
  };
  const make = () => createGitHubToolset({
    enabled: () => true,
    gitContext: async () => ({ remote: "https://github.com/o/r.git", branch: "feat" }),
    brokerRequest: async (method, path) => responses[`${method} ${path}`] ?? { status: 404, json: { message: "Not Found" } },
    monitors: spy.monitors,
  });
  const created = await make().call(entry, "github_create_pr", { title: "Fix it" });
  assert.match(created.text, /Monitoring CI until it finishes/);
  assert.deepEqual(spy.started[0], { logId: "s1", owner: "o", repo: "r", number: 7, scope: "ci" });

  spy.started.length = 0;
  const optedOut = await make().call(entry, "github_create_pr", { title: "Fix it", monitor: "none" });
  assert.doesNotMatch(optedOut.text, /Monitoring CI/);
  assert.equal(spy.started.length, 0, "monitor none starts nothing");

  const full = await make().call(entry, "github_create_pr", { title: "Fix it", monitor: "full" });
  assert.match(full.text, /Monitoring this PR until it merges or closes/);
  assert.equal(spy.started.at(-1).scope, "full");
});

test("github_update_pr patches fields and re-arms CI monitoring for the new head", async () => {
  const spy = monitorSpy();
  const calls = [];
  const toolset = createGitHubToolset({
    enabled: () => true,
    gitContext: async () => ({ remote: "https://github.com/o/r.git", branch: "feat" }),
    brokerRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "PATCH") return { status: 200, json: { number: 7, title: "New title", html_url: "https://github.com/o/r/pull/7" } };
      return { status: 200, json: { number: 7, title: "Fix it", html_url: "https://github.com/o/r/pull/7" } };
    },
    monitors: spy.monitors,
  });
  const updated = await toolset.call(entry, "github_update_pr", { number: 7, title: "New title", repo: "o/r" });
  assert.match(updated.text, /Updated PR #7 New title/);
  assert.match(updated.text, /Monitoring CI until it finishes/);
  assert.deepEqual(calls[0], { method: "PATCH", path: "/repos/o/r/pulls/7", body: { title: "New title" } });
  assert.deepEqual(spy.started[0], { logId: "s1", owner: "o", repo: "r", number: 7, scope: "ci" });

  calls.length = 0;
  const rearmed = await toolset.call(entry, "github_update_pr", { number: 7, repo: "o/r" });
  assert.match(rearmed.text, /PR #7 Fix it/);
  assert.equal(calls[0].method, "GET", "a field-less update just re-reads and re-arms");
  assert.equal((await toolset.call(entry, "github_update_pr", { number: 0, repo: "o/r" })).isError, true);
  assert.equal((await toolset.call(entry, "github_update_pr", { number: 7, title: "  ", repo: "o/r" })).isError, true);
});

test("github_pr_status reports state, mergeability, and a check rollup", async () => {
  const { toolset } = fakeToolset({
    responses: {
      "GET /repos/o/r/pulls/3": {
        status: 200,
        json: { number: 3, title: "Work", state: "open", draft: false, merged_at: null, mergeable: true, html_url: "https://github.com/o/r/pull/3", head: { ref: "feat", sha: "abc" }, base: { ref: "main" } },
      },
      "GET /repos/o/r/commits/abc/check-runs?per_page=100": {
        status: 200,
        json: { check_runs: [
          { name: "fast", status: "completed", conclusion: "success" },
          { name: "pilot", status: "completed", conclusion: "failure" },
          { name: "typecheck", status: "in_progress", conclusion: null },
        ] },
      },
    },
  });
  const result = await toolset.call(entry, "github_pr_status", { number: 3, repo: "o/r" });
  assert.match(result.text, /PR #3 Work — open, mergeable/);
  assert.match(result.text, /Checks: 1 passed, 1 failed, 1 pending\./);
  assert.match(result.text, /failed: pilot \(failure\)/);
  assert.equal((await toolset.call(entry, "github_pr_status", { number: 0, repo: "o/r" })).isError, true);
});

test("github_list_prs formats, caps the limit, and handles empty", async () => {
  const { toolset, calls } = fakeToolset({
    responses: {
      "GET /repos/o/r/pulls?state=open&per_page=30&sort=created&direction=desc": {
        status: 200,
        json: [{ number: 5, title: "New", draft: true, html_url: "https://github.com/o/r/pull/5", head: { ref: "a" }, base: { ref: "main" } }],
      },
    },
  });
  const result = await toolset.call(entry, "github_list_prs", { repo: "o/r", limit: 99 });
  assert.match(result.text, /#5 New \(draft\)/);
  assert.equal(calls.length, 1);
  const empty = fakeToolset({ responses: { "GET /repos/o/r/pulls?state=closed&per_page=10&sort=created&direction=desc": { status: 200, json: [] } } });
  assert.match((await empty.toolset.call(entry, "github_list_prs", { repo: "o/r", state: "closed" })).text, /No closed pull requests/);
});

test("github_monitor_pr starts, dedupes, stops, and requires the registry", async () => {
  const started = [];
  const monitors = {
    start: async (spec) => {
      started.push(spec);
      return { created: started.length === 1, monitor: { active: true, status: "monitoring", snapshot: { title: "Work", url: "https://github.com/o/r/pull/3", checks: { passed: 2, failed: 0, pending: 1, failing: [] } } } };
    },
    stop: (spec) => (started.length ? { ...spec } : null),
  };
  const withMonitors = createGitHubToolset({
    enabled: () => true,
    gitContext: async () => ({ remote: "https://github.com/o/r.git", branch: "main" }),
    brokerRequest: async () => ({ status: 200, json: {} }),
    monitors,
  });
  const begin = await withMonitors.call(entry, "github_monitor_pr", { number: 3 });
  assert.match(begin.text, /Monitoring o\/r#3 — Work \(until CI finishes; checks: 2 passed, 0 failed, 1 pending\)/);
  assert.match(begin.text, /until CI finishes/);
  assert.deepEqual(started[0], { logId: "s1", owner: "o", repo: "r", number: 3, scope: "ci" });
  const full = await withMonitors.call(entry, "github_monitor_pr", { number: 3, until: "merge" });
  assert.match(full.text, /until merge\/close/);
  assert.deepEqual(started.at(-1), { logId: "s1", owner: "o", repo: "r", number: 3, scope: "full" });
  const halt = await withMonitors.call(entry, "github_monitor_pr", { number: 3, stop: true });
  assert.match(halt.text, /Stopped monitoring o\/r#3\./);
  assert.equal((await withMonitors.call(entry, "github_monitor_pr", { number: -1 })).isError, true);

  const { toolset } = fakeToolset({});
  const unavailable = await toolset.call(entry, "github_monitor_pr", { number: 3, repo: "o/r" });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.text, /Failed: PR monitoring isn't available/);
});

test("the MCP server lists GitHub tools only when enabled and dispatches calls", async () => {
  const { toolset } = fakeToolset({
    context: { remote: "https://github.com/o/r.git", branch: "main" },
    responses: { "GET /repos/o/r/pulls?state=open&per_page=10&sort=created&direction=desc": { status: 200, json: [] } },
  });
  const deps = {
    agentForToken: (token) => (token === "tok" ? entry : undefined),
    listAgents: () => "agents",
    sendMessage: async () => ({ ok: true }),
    github: toolset,
  };
  const call = (message) => handleMcpRequest("tok", message, deps);
  const tools = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(tools.result.tools.map((t) => t.name), [...MCP_TOOLS, ...GITHUB_TOOLS].map((t) => t.name));
  const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "github_list_prs", arguments: {} } });
  assert.match(listed.result.content[0].text, /No open pull requests in o\/r\./);

  const disabled = fakeToolset({ enabled: false });
  const offDeps = { ...deps, github: disabled.toolset };
  const offTools = await handleMcpRequest("tok", { jsonrpc: "2.0", id: 3, method: "tools/list" }, offDeps);
  assert.deepEqual(offTools.result.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name));
  const offCall = await handleMcpRequest("tok", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "github_list_prs", arguments: {} } }, offDeps);
  assert.equal(offCall.result.isError, true);

  const noGithub = await handleMcpRequest("tok", { jsonrpc: "2.0", id: 5, method: "tools/list" }, { agentForToken: deps.agentForToken, listAgents: deps.listAgents, sendMessage: deps.sendMessage });
  assert.deepEqual(noGithub.result.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name));
});

test("the pilot wires the toolset into the MCP deps through the broker", () => {
  const pilot = readFileSync(new URL("./pilot.mjs", import.meta.url), "utf8");
  assert.ok(pilot.includes("github: githubToolset,"));
  assert.ok(pilot.includes('createGitHubToolset({'));
  assert.ok(pilot.includes("MUSE_CODE_SPACE_GITHUB_BROKER_CONFIG"));
  assert.ok(pilot.includes('authorization: `Bearer ${GITHUB_SENTINEL}`'));
  assert.ok(pilot.includes("github-broker-cert.pem"));
});

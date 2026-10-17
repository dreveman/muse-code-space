import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrMonitorRegistry, prChanges, prSnapshot } from "./prMonitor.mjs";

const pr = (overrides = {}) => ({
  state: "open", merged_at: null, draft: false, title: "Work", html_url: "https://github.com/o/r/pull/3",
  head: { sha: "abc", ref: "feat" }, base: { ref: "main" }, ...overrides,
});
const run = (name, status, conclusion = null) => ({ name, status, conclusion });

function harness({ storePath = null } = {}) {
  const state = {
    pr: pr(),
    runs: [run("fast", "completed", "success"), run("typecheck", "in_progress")],
    reviews: [],
    issueComments: [],
    reviewComments: [],
    failWith: null,
  };
  const broadcasts = [];
  const notifications = [];
  const registry = createPrMonitorRegistry({
    storePath,
    pollIntervalMs: 0,
    mintId: () => "mon-1",
    now: () => "2026-10-16T00:00:00.000Z",
    broadcast: (logId, event) => broadcasts.push({ logId, event }),
    notify: async (monitor, changes) => { notifications.push({ id: monitor.id, changes }); },
    brokerRequest: async (method, path) => {
      if (state.failWith) throw state.failWith;
      if (path.endsWith("/pulls/3")) return { status: 200, json: state.pr };
      if (path.includes("/check-runs")) return { status: 200, json: { check_runs: state.runs } };
      if (path.endsWith("/reviews?per_page=100")) return { status: 200, json: state.reviews };
      if (path.endsWith("/issues/3/comments?per_page=100")) return { status: 200, json: state.issueComments };
      if (path.endsWith("/pulls/3/comments?per_page=100")) return { status: 200, json: state.reviewComments };
      return { status: 404, json: { message: "Not Found" } };
    },
  });
  return { state, broadcasts, notifications, registry };
}

test("start snapshots the PR, broadcasts the row, and dedupes", async () => {
  const { registry, broadcasts } = harness();
  const first = await registry.start({ logId: "s1", owner: "o", repo: "r", number: 3 });
  assert.equal(first.created, true);
  assert.equal(first.monitor.snapshot.checks.passed, 1);
  assert.equal(first.monitor.snapshot.checks.pending, 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event.type, "pr_monitor");
  assert.equal(broadcasts[0].event.monitor.status, "monitoring");
  const again = await registry.start({ logId: "s1", owner: "o", repo: "r", number: 3 });
  assert.equal(again.created, false);
  assert.equal(broadcasts.length, 1, "no duplicate row for a duplicate start");
});

test("poll detects CI failure, approval, comments, then merge — notifying once per poll", async () => {
  const { state, registry, broadcasts, notifications } = harness();
  await registry.start({ logId: "s1", owner: "o", repo: "r", number: 3 });

  state.runs = [run("fast", "completed", "success"), run("typecheck", "completed", "failure")];
  state.reviews = [{ id: 10, state: "APPROVED", user: { login: "rev" } }];
  state.issueComments = [{ id: 20, user: { login: "kim" } }];
  await registry.pollNow();
  assert.deepEqual(notifications.at(-1).changes, ["CI check failed: typecheck", "Approved by rev", "1 new comment (latest by kim)"]);
  assert.equal(broadcasts.at(-1).event.monitor.approvals, 1);

  await registry.pollNow();
  assert.equal(notifications.length, 1, "unchanged polls stay silent");

  state.pr = pr({ state: "closed", merged_at: "2026-10-16T01:00:00Z" });
  await registry.pollNow();
  assert.deepEqual(notifications.at(-1).changes, ["PR was merged"]);
  const monitor = registry.list()[0];
  assert.equal(monitor.active, false);
  assert.equal(monitor.status, "merged");
  assert.equal(broadcasts.at(-1).event.monitor.status, "merged");
  await registry.pollNow();
  assert.equal(notifications.length, 2, "terminal monitors stop polling");
});

test("stop ends monitoring and emits the final row", async () => {
  const { registry, broadcasts } = harness();
  await registry.start({ logId: "s1", owner: "o", repo: "r", number: 3 });
  const stopped = registry.stop({ logId: "s1", owner: "o", repo: "r", number: 3 });
  assert.equal(stopped.status, "stopped");
  assert.equal(broadcasts.at(-1).event.monitor.status, "stopped");
  assert.equal(registry.stop({ logId: "s1", owner: "o", repo: "r", number: 3 }), null);
});

test("monitors persist across a restart and drop with their session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prmon-"));
  const storePath = join(dir, "pr-monitors.json");
  try {
    const a = harness({ storePath });
    await a.registry.start({ logId: "s1", owner: "o", repo: "r", number: 3 });
    assert.equal(JSON.parse(readFileSync(storePath, "utf8")).length, 1);

    const b = harness({ storePath });
    assert.equal(b.registry.boot(), 1, "active monitor resumes after restart");
    assert.equal(b.registry.list()[0].snapshot.checks.passed, 1, "snapshot survives");

    b.registry.forgetSession("s1");
    assert.equal(b.registry.list().length, 0);
    assert.equal(JSON.parse(readFileSync(storePath, "utf8")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("starting a monitor for a missing PR fails without registering", async () => {
  const reg = createPrMonitorRegistry({
    storePath: null, pollIntervalMs: 0,
    broadcast: () => {}, notify: async () => {},
    brokerRequest: async () => ({ status: 404, json: { message: "Not Found" } }),
  });
  await assert.rejects(() => reg.start({ logId: "s1", owner: "o", repo: "r", number: 3 }), /Not Found/);
  assert.equal(reg.list().length, 0);
});

test("repeated poll failures stop the monitor with an error row and notice", async () => {
  const { state, registry, broadcasts, notifications } = harness();
  await registry.start({ logId: "s1", owner: "o", repo: "r", number: 3 });
  state.failWith = new Error("broker down");
  await registry.pollNow();
  await registry.pollNow();
  assert.equal(registry.list()[0].active, true, "two failures are tolerated");
  await registry.pollNow();
  const monitor = registry.list()[0];
  assert.equal(monitor.active, false);
  assert.equal(monitor.status, "error");
  assert.equal(broadcasts.at(-1).event.monitor.status, "error");
  assert.match(notifications.at(-1).changes[0], /monitoring stopped/);
});

test("snapshot and change helpers handle the terminal wording", () => {
  const open = prSnapshot(pr(), [run("a", "completed", "success")], [], [], []);
  const merged = prSnapshot(pr({ state: "closed", merged_at: "x" }), [], [], [], []);
  assert.equal(open.state, "open");
  assert.deepEqual(prChanges(open, merged), ["PR was merged"]);
  assert.deepEqual(prChanges(null, open), [], "the initial snapshot is not a change");
});

// Background pull-request monitoring, owned by the pilot.
//
// An agent starts a monitor with the github_monitor_pr MCP tool; the pilot
// then polls the PR through the GitHub broker once a minute and watches
// for material changes: reviews (approval / changes requested / review
// comments), new comments, CI check transitions, draft/ready flips, and
// merge/close. Monitors persist in the pilot state dir (pr-monitors.json)
// and resume on boot, so they survive pilot, VM, and app restarts; the
// transcript row they drive is a normal persisted session event
// (type "pr_monitor", upserted by monitor id app-side), so it survives
// with the rest of the transcript. On a material change the pilot also
// delivers a turn to the owning session (queued if busy) so the agent
// actually learns about it instead of having to poll.
//
// The registry is transport-agnostic for tests: GitHub reads go through
// the injected brokerRequest (same helper the GitHub tools use).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const PR_MONITOR_POLL_MS = 60_000;
// A CI-scoped monitor whose head reports no checks at all ends after this
// grace (GitHub cannot distinguish "not reported yet" from "no CI").
export const PR_MONITOR_NO_CHECKS_GRACE_MS = 15 * 60_000;
const MAX_CHANGE_LOG = 5;
const MAX_CONSECUTIVE_FAILURES = 3;

function checksRollup(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const done = list.filter((run) => run.status === "completed");
  const failed = done.filter((run) => !["success", "skipped", "neutral"].includes(run.conclusion));
  return {
    total: list.length,
    passed: done.filter((run) => run.conclusion === "success").length,
    failed: failed.length,
    pending: list.length - done.length,
    failing: failed.map((run) => run.name).slice(0, 5),
  };
}

/** Monitor scope: "ci" (until CI finishes, the default) or "full" (until merge/close). */
export function normalizeMonitorScope(scope) {
  return scope === "full" ? "full" : "ci";
}

function ciChecksTerminal(checks) {
  return checks.total > 0 && checks.pending === 0;
}

function ciTerminalStatus(checks) {
  return checks.failed > 0 ? "ci-failed" : "ci-passed";
}

function ciTerminalChange(checks) {
  if (checks.failed > 0) {
    return `CI finished: ${checks.passed} passed, ${checks.failed} failed${checks.failing.length ? ` (${checks.failing.join(", ")})` : ""} — monitoring ended`;
  }
  return `All checks passed (${checks.passed} checks) — monitoring ended`;
}

/** Changes a CI-scoped monitor reports: state flips and the terminal CI result only. */
function ciChanges(prev, next) {
  if (!prev) return [];
  const changes = [];
  if (next.state === "merged" && prev.state !== "merged") changes.push("PR was merged");
  else if (next.state === "closed" && prev.state === "open") changes.push("PR was closed without merging");
  else if (next.state === "open" && prev.state === "closed") changes.push("PR was reopened");
  if (next.state === "open" && ciChecksTerminal(next.checks) && !ciChecksTerminal(prev.checks)) {
    changes.push(ciTerminalChange(next.checks));
  }
  return changes;
}

/** Reduce GitHub API payloads to the signals worth diffing. */
export function prSnapshot(pr, checkRuns, reviews, issueComments, reviewComments) {
  const reviewList = Array.isArray(reviews) ? reviews : [];
  const comments = [...(Array.isArray(issueComments) ? issueComments : []), ...(Array.isArray(reviewComments) ? reviewComments : [])];
  return {
    state: pr.merged_at ? "merged" : pr.state,
    draft: pr.draft === true,
    title: typeof pr.title === "string" ? pr.title : "",
    url: typeof pr.html_url === "string" ? pr.html_url : "",
    headSha: typeof pr.head?.sha === "string" ? pr.head.sha : "",
    checks: checksRollup(checkRuns),
    approvals: reviewList.filter((review) => review.state === "APPROVED").length,
    reviewIds: reviewList.map((review) => review.id),
    latestReview: reviewList.length
      ? { id: reviewList.at(-1).id, state: reviewList.at(-1).state, user: reviewList.at(-1).user?.login ?? "someone" }
      : null,
    commentCount: comments.length,
    latestCommentUser: comments.length ? (comments.at(-1).user?.login ?? "someone") : null,
    // Final diff totals from the PR payload; companion statistics count
    // these once, when the PR merges.
    additions: Number.isSafeInteger(pr.additions) && pr.additions >= 0 ? pr.additions : null,
    deletions: Number.isSafeInteger(pr.deletions) && pr.deletions >= 0 ? pr.deletions : null,
    filesChanged: Number.isSafeInteger(pr.changed_files) && pr.changed_files >= 0 ? pr.changed_files : null,
  };
}

/** Material changes between two snapshots, as human sentences. */
export function prChanges(prev, next) {
  if (!prev) return [];
  const changes = [];
  if (next.state === "merged" && prev.state !== "merged") changes.push("PR was merged");
  else if (next.state === "closed" && prev.state === "open") changes.push("PR was closed without merging");
  else if (next.state === "open" && prev.state === "closed") changes.push("PR was reopened");
  if (next.draft !== prev.draft) changes.push(next.draft ? "PR was converted to a draft" : "PR was marked ready for review");

  const was = prev.checks, is = next.checks;
  const newFailing = is.failing.filter((name) => !was.failing.includes(name));
  if (newFailing.length) changes.push(`CI check failed: ${newFailing.join(", ")}`);
  if (is.pending === 0 && is.failed === 0 && (was.pending > 0 || was.failed > 0)) {
    changes.push(`All checks passed (${is.passed} checks)`);
  }

  if (next.latestReview && next.latestReview.id !== prev.latestReview?.id && !prev.reviewIds.includes(next.latestReview.id)) {
    const { state, user } = next.latestReview;
    if (state === "APPROVED") changes.push(`Approved by ${user}`);
    else if (state === "CHANGES_REQUESTED") changes.push(`Changes requested by ${user}`);
    else if (state === "COMMENTED") changes.push(`Review comments by ${user}`);
    else if (state === "DISMISSED") changes.push(`A review by ${user} was dismissed`);
  }

  if (next.commentCount > prev.commentCount) {
    const n = next.commentCount - prev.commentCount;
    changes.push(`${n} new comment${n === 1 ? "" : "s"}${next.latestCommentUser ? ` (latest by ${next.latestCommentUser})` : ""}`);
  }
  return changes;
}

/** The transcript-row payload for a monitor (stored as event content app-side). */
export function monitorRow(monitor) {
  const snap = monitor.snapshot;
  return {
    id: monitor.id,
    owner: monitor.owner,
    repo: monitor.repo,
    number: monitor.number,
    title: snap?.title ?? "",
    url: snap?.url ?? `https://github.com/${monitor.owner}/${monitor.repo}/pull/${monitor.number}`,
    status: monitor.status,
    scope: normalizeMonitorScope(monitor.scope),
    checks: snap?.checks ?? { total: 0, passed: 0, failed: 0, pending: 0, failing: [] },
    approvals: snap?.approvals ?? 0,
    comments: snap?.commentCount ?? 0,
    additions: snap?.additions ?? null,
    deletions: snap?.deletions ?? null,
    filesChanged: snap?.filesChanged ?? null,
    changes: monitor.changes.slice(-MAX_CHANGE_LOG),
    startedAt: monitor.startedAt,
    updatedAt: monitor.updatedAt,
  };
}

export function createPrMonitorRegistry({
  storePath,
  brokerRequest,
  broadcast,
  notify,
  sessionExists = () => true,
  log = () => {},
  pollIntervalMs = PR_MONITOR_POLL_MS,
  noChecksGraceMs = PR_MONITOR_NO_CHECKS_GRACE_MS,
  now = () => new Date().toISOString(),
  mintId = () => randomUUID(),
}) {
  let monitors = [];
  let timer = null;

  const persist = () => {
    if (!storePath) return;
    try {
      const tmp = `${storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(monitors, null, 2));
      renameSync(tmp, storePath);
    } catch (error) {
      log("pr monitor persist failed:", String(error).slice(0, 160));
    }
  };

  const load = () => {
    if (!storePath || !existsSync(storePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      if (Array.isArray(parsed)) {
        // Monitors for sessions that no longer exist are dropped: their
        // transcript (and row) is gone, so there is nothing to update.
        monitors = parsed.filter((m) => m && typeof m.id === "string" && sessionExists(m.logId))
          .map((m) => ({ ...m, scope: normalizeMonitorScope(m.scope) }));
      }
    } catch { monitors = []; }
  };

  const emit = (monitor) => broadcast(monitor.logId, { type: "pr_monitor", monitor: monitorRow(monitor) });

  const fetchSnapshot = async (monitor) => {
    const base = `/repos/${monitor.owner}/${monitor.repo}`;
    const pr = await brokerRequest("GET", `${base}/pulls/${monitor.number}`);
    if (pr.status !== 200) {
      const error = new Error(`GitHub said: ${pr.json?.message ?? `HTTP ${pr.status}`}`);
      error.status = pr.status;
      throw error;
    }
    const sha = pr.json?.head?.sha;
    // CI-scoped monitors only need the PR and its checks; reviews/comments
    // are neither reported nor worth the API calls.
    const engagement = normalizeMonitorScope(monitor.scope) === "full"
      ? [
          brokerRequest("GET", `${base}/pulls/${monitor.number}/reviews?per_page=100`),
          brokerRequest("GET", `${base}/issues/${monitor.number}/comments?per_page=100`),
          brokerRequest("GET", `${base}/pulls/${monitor.number}/comments?per_page=100`),
        ]
      : [Promise.resolve({ json: [] }), Promise.resolve({ json: [] }), Promise.resolve({ json: [] })];
    const [checks, reviews, issueComments, reviewComments] = await Promise.all([
      sha ? brokerRequest("GET", `${base}/commits/${sha}/check-runs?per_page=100`) : Promise.resolve({ status: 200, json: { check_runs: [] } }),
      ...engagement,
    ]);
    return prSnapshot(
      pr.json,
      checks.json?.check_runs ?? [],
      reviews.json ?? [],
      issueComments.json ?? [],
      reviewComments.json ?? [],
    );
  };

  const poll = async (monitor) => {
    if (!monitor.active) return;
    let next;
    try {
      next = await fetchSnapshot(monitor);
    } catch (error) {
      monitor.failures = (monitor.failures ?? 0) + 1;
      monitor.updatedAt = now();
      if (error?.status === 404 || monitor.failures >= MAX_CONSECUTIVE_FAILURES) {
        monitor.active = false;
        monitor.status = "error";
        monitor.changes.push({ at: now(), text: `Monitoring stopped: ${error?.message ?? error}` });
        persist();
        emit(monitor);
        void notify(monitor, [`monitoring stopped (${error?.message ?? error})`]);
      } else {
        persist();
      }
      return;
    }
    monitor.failures = 0;
    const scope = normalizeMonitorScope(monitor.scope);
    monitor.scope = scope;
    const changes = scope === "ci" ? ciChanges(monitor.snapshot, next) : prChanges(monitor.snapshot, next);
    // A CI monitor retargets when the head moves and its no-checks grace
    // restarts from the new head.
    if (scope === "ci" && next.headSha && next.headSha !== monitor.ciHeadSha) {
      monitor.ciHeadSha = next.headSha;
      monitor.ciHeadSince = now();
    }
    monitor.snapshot = next;
    monitor.updatedAt = now();
    if (next.state === "merged" || next.state === "closed") {
      monitor.active = false;
      monitor.status = next.state;
    } else if (scope === "ci" && ciChecksTerminal(next.checks)) {
      monitor.active = false;
      monitor.status = ciTerminalStatus(next.checks);
      if (!changes.some((text) => text.includes("monitoring ended"))) changes.push(ciTerminalChange(next.checks));
    } else if (scope === "ci" && next.checks.total === 0 && monitor.ciHeadSince
      && Date.parse(now()) - Date.parse(monitor.ciHeadSince) >= noChecksGraceMs) {
      monitor.active = false;
      monitor.status = "ci-none";
      changes.push("No CI checks reported for the latest commit — monitoring ended");
    }
    if (changes.length) {
      for (const text of changes) monitor.changes.push({ at: now(), text });
      monitor.changes = monitor.changes.slice(-MAX_CHANGE_LOG);
    }
    persist();
    if (changes.length || !monitor.active) {
      emit(monitor);
      if (changes.length) void notify(monitor, changes);
    }
  };

  return {
    /** Start, reuse, upgrade, or re-arm a monitor; resolves after the first snapshot so the row opens with real data. */
    async start({ logId, owner, repo, number, scope }) {
      const wanted = normalizeMonitorScope(scope);
      const samePr = (m) => m.logId === logId && m.owner === owner && m.repo === repo && m.number === number;
      const existing = monitors.find((m) => m.active && samePr(m));
      if (existing) {
        // Asking for full monitoring upgrades a live CI monitor in place.
        if (wanted === "full" && normalizeMonitorScope(existing.scope) !== "full") {
          existing.scope = "full";
          existing.updatedAt = now();
          persist();
          emit(existing);
        }
        return { monitor: existing, created: false };
      }
      // A finished monitor for the same PR re-arms (e.g. new commits pushed
      // after CI completed) instead of accumulating a second row.
      const finished = [...monitors].reverse().find((m) => !m.active && samePr(m));
      const monitor = finished ?? {
        id: mintId(), logId, owner, repo, number,
        status: "monitoring", active: true, failures: 0,
        snapshot: null, changes: [], startedAt: now(), updatedAt: now(),
      };
      const rearmed = Boolean(finished);
      Object.assign(monitor, {
        scope: wanted, status: "monitoring", active: true, failures: 0,
        snapshot: null, ciHeadSha: "", ciHeadSince: "", startedAt: now(), updatedAt: now(),
      });
      if (!finished) monitors.push(monitor);
      try {
        monitor.snapshot = await fetchSnapshot(monitor);
        monitor.ciHeadSha = monitor.snapshot.headSha ?? "";
        monitor.ciHeadSince = now();
        if (monitor.snapshot.state === "merged" || monitor.snapshot.state === "closed") {
          monitor.active = false;
          monitor.status = monitor.snapshot.state;
        } else if (wanted === "ci" && ciChecksTerminal(monitor.snapshot.checks)) {
          // CI already finished before monitoring started: open terminal.
          monitor.active = false;
          monitor.status = ciTerminalStatus(monitor.snapshot.checks);
        }
      } catch (error) {
        if (!rearmed) monitors = monitors.filter((m) => m !== monitor);
        else { monitor.active = false; monitor.status = "error"; }
        throw error;
      }
      monitor.updatedAt = now();
      persist();
      emit(monitor);
      return { monitor, created: !rearmed, rearmed };
    },
    stop({ logId, owner, repo, number }) {
      const monitor = monitors.find((m) => m.active && m.logId === logId && m.owner === owner && m.repo === repo && m.number === number);
      if (!monitor) return null;
      monitor.active = false;
      monitor.status = "stopped";
      monitor.updatedAt = now();
      monitor.changes.push({ at: now(), text: "Monitoring stopped" });
      persist();
      emit(monitor);
      return monitor;
    },
    forgetSession(logId) {
      const before = monitors.length;
      monitors = monitors.filter((m) => m.logId !== logId);
      if (monitors.length !== before) persist();
    },
    async pollNow() {
      for (const monitor of [...monitors]) await poll(monitor);
    },
    /** Load persisted monitors and start the poll loop. Returns active count. */
    boot() {
      load();
      if (timer === null && pollIntervalMs > 0) {
        timer = setInterval(() => { void this.pollNow(); }, pollIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      return monitors.filter((m) => m.active).length;
    },
    shutdown() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    list() {
      return [...monitors];
    },
  };
}

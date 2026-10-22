// GitHub tools for Code Space sessions, served by the pilot's per-session
// MCP server (mcp.mjs) when GitHub integration is set up. Tool calls go to
// the local GitHub broker with the session sentinel; the broker swaps in
// the real credential, so agents never hold one. Tools: create a PR, read
// a PR's status, list PRs, and start/stop background PR monitoring (the
// monitor engine itself lives in prMonitor.mjs, owned by the pilot).
//
// Pure logic lives here; the pilot injects the side effects:
//   enabled()                          -> boolean (broker credential provisioned)
//   brokerRequest(method, path, body?) -> Promise<{ status, json }>
//   gitContext(workspaceRoot)          -> Promise<{ remote?: string, branch?: string }>

export const GITHUB_TOOLS = [
  {
    name: "github_create_pr",
    title: "Create a GitHub pull request",
    description:
      "Create a pull request through Code Space's GitHub broker. Defaults: repo from your workspace's origin remote, " +
      "head from its current branch, base is the repo's default branch. The head branch must already be pushed. " +
      "By default this also monitors the PR's CI until it finishes and then stops; pass monitor: \"full\" to watch " +
      "reviews/comments until merge, or \"none\" not to monitor. Returns the PR number and URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Pull request title." },
        body: { type: "string", description: "Pull request description (Markdown). Optional." },
        head: { type: "string", description: "Head branch (or owner:branch for a fork). Defaults to the workspace's current branch." },
        base: { type: "string", description: "Base branch. Defaults to the repository's default branch." },
        draft: { type: "boolean", description: "Create as a draft pull request." },
        monitor: { type: "string", enum: ["ci", "full", "none"], description: "Monitoring after creation: \"ci\" (default) watches CI until it finishes then stops, \"full\" watches until merge/close, \"none\" starts no monitor." },
        repo: { type: "string", description: "Repository as owner/repo. Defaults to the workspace's origin remote." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "github_update_pr",
    title: "Update a GitHub pull request",
    description:
      "Update a pull request's title, body, or base branch through Code Space's GitHub broker. Code changes still " +
      "go through git push; call this after pushing (with or without field changes) to re-arm CI monitoring for the " +
      "new head. By default it monitors CI until it finishes and then stops; pass monitor: \"full\" to watch until " +
      "merge, or \"none\" not to monitor. Returns the PR number and URL.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "Pull request number." },
        title: { type: "string", description: "New pull request title. Optional." },
        body: { type: "string", description: "New pull request description (Markdown). Optional." },
        base: { type: "string", description: "New base branch. Optional." },
        monitor: { type: "string", enum: ["ci", "full", "none"], description: "Monitoring after the update: \"ci\" (default), \"full\", or \"none\"." },
        repo: { type: "string", description: "Repository as owner/repo. Defaults to the workspace's origin remote." },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: "github_pr_status",
    title: "Check a pull request's status",
    description:
      "Read one pull request's state (open/closed/merged, draft, mergeable) and a rollup of its head commit's checks. " +
      "This is a one-shot read; it does not watch or wait.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "Pull request number." },
        repo: { type: "string", description: "Repository as owner/repo. Defaults to the workspace's origin remote." },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: "github_monitor_pr",
    title: "Monitor pull requests in the background",
    description:
      "Start or stop background monitoring of one or more pull requests. By default a monitor watches CI only and " +
      "stops automatically when the checks finish (pass or fail); pass until: \"merge\" to also watch reviews and " +
      "comments until the PR merges or closes. Code Space polls about once a minute and posts an update to this " +
      "session when CI finishes or the PR state changes, and a live Monitoring row in the transcript tracks each PR. " +
      "After pushing new commits to a PR whose CI monitor already finished, call this again to re-arm it for the new " +
      "head. Monitoring survives restarts. Pass action: \"unsubscribe\" or stop: true to end it early.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["subscribe", "unsubscribe"], description: "Whether to start (subscribe) or stop (unsubscribe) monitoring. Default subscribe." },
        until: { type: "string", enum: ["ci", "merge"], description: "Monitor lifetime: \"ci\" (default) stops when CI finishes; \"merge\" watches reviews/comments until merge/close." },
        pr_ids: {
          type: "array",
          items: { type: ["string", "number"] },
          description: "Pull request numbers or #N identifiers to monitor, e.g. [\"#6\", \"#7\"].",
        },
        numbers: {
          type: "array",
          items: { type: "integer" },
          description: "Pull request numbers to monitor.",
        },
        number: { type: "integer", description: "Single pull request number." },
        repo: { type: "string", description: "Repository as owner/repo. Defaults to the workspace's origin remote." },
        stop: { type: "boolean", description: "Stop monitoring instead of starting it." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "github_list_prs",
    title: "List pull requests",
    description: "List pull requests for a repository (open by default), newest first.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository as owner/repo. Defaults to the workspace's origin remote." },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Filter by state. Default open." },
        limit: { type: "integer", description: "How many to return (1-30, default 10)." },
      },
      additionalProperties: false,
    },
  },
];

const GITHUB_TOOL_NAMES = new Set(GITHUB_TOOLS.map((tool) => tool.name));
export const isGitHubTool = (name) => GITHUB_TOOL_NAMES.has(name);

/** Parse an origin remote URL into { owner, repo }, incl. broker-rewritten URLs. */
export function parseGitHubRemote(remote) {
  if (typeof remote !== "string") return null;
  const trimmed = remote.trim();
  // scp-style: git@github.com:owner/repo[.git]
  const scp = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  const path = scp ? scp[1] : (trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)$/i)?.[1] ?? "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.at(-1).replace(/\.git$/, "");
  const owner = parts.at(-2);
  if (!owner || !repo || /[\s:]/.test(owner) || /[\s:]/.test(repo)) return null;
  return { owner, repo };
}

function parseRepoArg(repo) {
  if (typeof repo !== "string") return null;
  const match = repo.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

const NOT_SET_UP = "GitHub integration isn't set up for Code Space, so GitHub tools are unavailable.";

// Error text carries a uniform prefix the transcript UI keys on (MCP
// isError does not reliably surface as a failed tool status), matching
// the send_message "Not delivered:" precedent.
const fail = (text) => ({ text: `Failed: ${text}`, isError: true });

function githubError(status, json) {
  const message = typeof json?.message === "string" ? json.message : `HTTP ${status}`;
  const details = Array.isArray(json?.errors)
    ? json.errors.map((e) => [e?.resource, e?.field, e?.code].filter(Boolean).join(" ")).filter(Boolean)
    : [];
  return details.length ? `${message} (${details.join("; ")})` : message;
}

function formatPrLine(pr) {
  return `#${pr.number} ${pr.title}`;
}

function formatCreatedPr(pr) {
  const lines = [`Created PR ${formatPrLine(pr)}${pr.draft ? " (draft)" : ""}`, pr.html_url];
  if (pr.head?.ref && pr.base?.ref) lines.push(`${pr.head.ref} → ${pr.base.ref}`);
  return lines.filter(Boolean).join("\n");
}

function monitorMode(value) {
  return value === "full" || value === "none" ? value : "ci";
}

function monitorScopeForMode(mode) {
  return mode === "full" ? "full" : "ci";
}

function formatMonitorOutcome(monitor, requestedScope) {
  const scope = monitor.scope === "full" ? "full" : requestedScope;
  const checks = monitor.snapshot?.checks;
  const rollup = checks ? `${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending` : "checks unknown";
  if (!monitor.active) {
    if (monitor.status === "ci-passed") return `CI already passed (${rollup}); no monitoring needed.`;
    if (monitor.status === "ci-failed") return `CI already finished with failures (${rollup}); no monitoring started.`;
    return `PR is ${monitor.status}; no monitoring started.`;
  }
  return scope === "full"
    ? `Monitoring this PR until it merges or closes (checks: ${rollup}). You will be notified automatically when something changes.`
    : `Monitoring CI until it finishes, then monitoring stops (checks: ${rollup}). You will be notified automatically when CI finishes.`;
}

function formatPrStatus(pr, checkRuns) {
  const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "open (draft)" : "open";
  const mergeable = pr.state === "open"
    ? pr.mergeable === true ? "mergeable" : pr.mergeable === false ? "not mergeable (conflicts)" : "mergeable state not computed yet"
    : null;
  const lines = [
    `PR ${formatPrLine(pr)} — ${state}${mergeable ? `, ${mergeable}` : ""}`,
    `${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"}`,
  ];
  if (Array.isArray(checkRuns)) {
    if (checkRuns.length === 0) {
      lines.push("Checks: none reported for the head commit.");
    } else {
      const done = checkRuns.filter((run) => run.status === "completed");
      const failed = done.filter((run) => !["success", "skipped", "neutral"].includes(run.conclusion));
      const passed = done.filter((run) => run.conclusion === "success").length;
      const pending = checkRuns.length - done.length;
      const parts = [`${passed} passed`];
      if (failed.length) parts.push(`${failed.length} failed`);
      if (done.length - passed - failed.length > 0) parts.push(`${done.length - passed - failed.length} skipped/neutral`);
      if (pending) parts.push(`${pending} pending`);
      lines.push(`Checks: ${parts.join(", ")}.`);
      for (const run of failed.slice(0, 5)) lines.push(`  failed: ${run.name} (${run.conclusion})`);
    }
  }
  lines.push(pr.html_url);
  return lines.filter(Boolean).join("\n");
}

function formatPrList(prs, repoSlug, state) {
  if (!prs.length) return `No ${state} pull requests in ${repoSlug}.`;
  const lines = [`${state} pull requests in ${repoSlug}:`];
  for (const pr of prs) {
    lines.push(`${formatPrLine(pr)}${pr.draft ? " (draft)" : ""} — ${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"} — ${pr.html_url}`);
  }
  return lines.join("\n");
}

/**
 * Build the toolset the pilot hands to mcp.mjs as deps.github.
 * `call(entry, name, args)` returns { text, isError? }.
 */
export function createGitHubToolset({ enabled, brokerRequest, gitContext, monitors = null }) {
  const resolveRepo = async (entry, args) => {
    if (args.repo !== undefined) {
      const parsed = parseRepoArg(args.repo);
      if (!parsed) throw new Error("`repo` must look like owner/repo.");
      return parsed;
    }
    const context = await gitContext(entry?.meta?.workspaceRoot);
    const parsed = parseGitHubRemote(context?.remote);
    if (!parsed) throw new Error("Could not infer the repository from this workspace's origin remote; pass `repo` as owner/repo.");
    return parsed;
  };

  const request = async (method, path, body) => {
    let result;
    try {
      result = await brokerRequest(method, path, body);
    } catch (error) {
      throw new Error(`GitHub broker request failed: ${error?.message ?? error}`);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`GitHub said: ${githubError(result.status, result.json)}`);
    }
    return result.json;
  };

  // Start (or re-arm) monitoring for one PR and describe the outcome.
  // Monitoring problems never fail the GitHub operation that triggered it.
  const startMonitor = async (entry, owner, repo, number, mode) => {
    if (mode === "none") return null;
    if (!monitors) return "Monitoring isn't available in this Code Space, so no monitor was started.";
    try {
      const { monitor } = await monitors.start({ logId: entry.logId, owner, repo, number, scope: monitorScopeForMode(mode) });
      return formatMonitorOutcome(monitor, monitorScopeForMode(mode));
    } catch (error) {
      return `Monitoring could not be started (${error?.message ?? error}); the PR itself was updated.`;
    }
  };

  return {
    enabled,
    async call(entry, name, args = {}) {
      try {
        if (!enabled()) return fail(NOT_SET_UP);
        if (name === "github_create_pr") {
          const title = typeof args.title === "string" ? args.title.trim() : "";
          if (!title) return fail("github_create_pr needs a `title`.");
          const { owner, repo } = await resolveRepo(entry, args);
          let head = typeof args.head === "string" && args.head.trim() ? args.head.trim() : undefined;
          if (!head) {
            const context = await gitContext(entry?.meta?.workspaceRoot);
            head = context?.branch ?? undefined;
          }
          if (!head) {
            return fail("Could not infer the head branch (workspace is not on a branch); pass `head` explicitly.");
          }
          const body = { title, head, draft: args.draft === true };
          if (typeof args.body === "string") body.body = args.body;
          if (typeof args.base === "string" && args.base.trim()) body.base = args.base.trim();
          const pr = await request("POST", `/repos/${owner}/${repo}/pulls`, body);
          const monitorLine = await startMonitor(entry, owner, repo, pr.number, monitorMode(args.monitor));
          return { text: [formatCreatedPr(pr), monitorLine].filter(Boolean).join("\n") };
        }
        if (name === "github_update_pr") {
          const number = Number.isInteger(args.number) && args.number > 0 ? args.number : null;
          if (!number) return fail("github_update_pr needs a positive integer `number`.");
          const { owner, repo } = await resolveRepo(entry, args);
          const patch = {};
          if (typeof args.title === "string") {
            if (!args.title.trim()) return fail("github_update_pr `title` must not be empty.");
            patch.title = args.title.trim();
          }
          if (typeof args.body === "string") patch.body = args.body;
          if (typeof args.base === "string" && args.base.trim()) patch.base = args.base.trim();
          const pr = Object.keys(patch).length
            ? await request("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, patch)
            : await request("GET", `/repos/${owner}/${repo}/pulls/${number}`);
          const monitorLine = await startMonitor(entry, owner, repo, number, monitorMode(args.monitor));
          const headline = Object.keys(patch).length ? `Updated PR ${formatPrLine(pr)}` : `PR ${formatPrLine(pr)}`;
          return { text: [headline, pr.html_url, monitorLine].filter(Boolean).join("\n") };
        }
        if (name === "github_pr_status") {
          const number = Number.isInteger(args.number) && args.number > 0 ? args.number : null;
          if (!number) return fail("github_pr_status needs a positive integer `number`.");
          const { owner, repo } = await resolveRepo(entry, args);
          const pr = await request("GET", `/repos/${owner}/${repo}/pulls/${number}`);
          let runs = null;
          if (pr.head?.sha) {
            const checks = await request("GET", `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`);
            runs = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
          }
          return { text: formatPrStatus(pr, runs) };
        }
        if (name === "github_monitor_pr") {
          const rawList = [
            ...(Array.isArray(args.pr_ids) ? args.pr_ids : []),
            ...(Array.isArray(args.numbers) ? args.numbers : []),
            ...(args.number !== undefined ? [args.number] : []),
          ];
          const prNumbers = [];
          for (const item of rawList) {
            const parsed = typeof item === "number"
              ? item
              : typeof item === "string"
                ? Number(item.trim().replace(/^.*#/, ""))
                : NaN;
            if (!Number.isInteger(parsed) || parsed <= 0) {
              return fail("github_monitor_pr needs positive integer PR numbers (`number` or `pr_ids`).");
            }
            if (!prNumbers.includes(parsed)) prNumbers.push(parsed);
          }
          if (prNumbers.length === 0) {
            return fail("github_monitor_pr needs a positive integer `number` or non-empty `pr_ids`.");
          }
          if (!monitors) return fail("PR monitoring isn't available in this Code Space.");
          const { owner, repo } = await resolveRepo(entry, args);
          const stopping = args.stop === true || args.action === "unsubscribe";
          if (stopping) {
            const stopped = [];
            for (const num of prNumbers) {
              if (monitors.stop({ logId: entry.logId, owner, repo, number: num })) {
                stopped.push(num);
              }
            }
            if (stopped.length === 0) {
              return fail(`No active monitor for ${owner}/${repo}#${prNumbers[0]} in this session.`);
            }
            return {
              text: stopped.length === 1
                ? `Stopped monitoring ${owner}/${repo}#${stopped[0]}.`
                : `Stopped monitoring ${stopped.map((n) => `${owner}/${repo}#${n}`).join(", ")}.`,
            };
          }
          const scope = args.until === "merge" ? "full" : "ci";
          const results = [];
          for (const num of prNumbers) {
            const res = await monitors.start({ logId: entry.logId, owner, repo, number: num, scope });
            results.push({ number: num, ...res });
          }
          const lines = [];
          for (const { number: num, monitor, created, rearmed } of results) {
            const snap = monitor.snapshot;
            const checks = snap ? `${snap.checks.passed} passed, ${snap.checks.failed} failed, ${snap.checks.pending} pending` : "checks unknown";
            const stateTag = monitor.active ? (snap?.draft ? "DRAFT" : "OPEN") : String(monitor.status).toUpperCase().replaceAll("-", " ");
            const comments = snap?.commentCount ?? 0;
            const label = rearmed ? "Re-armed monitoring" : created ? "Monitoring" : monitor.active ? "Already monitoring" : "Monitoring ended";
            const until = (monitor.scope === "full" || scope === "full") ? "until merge/close" : "until CI finishes";
            const headLine = `${label} ${owner}/${repo}#${num}${snap?.title ? ` — ${snap.title}` : ""} (${until}; checks: ${checks})`;
            lines.push(`  #${num} — ${stateTag} · CI: ${checks} · ${comments} comment${comments === 1 ? "" : "s"} · ${headLine}`);
          }
          const activeList = typeof monitors.list === "function"
            ? monitors.list().filter((m) => m.active && m.logId === entry.logId).map((m) => `#${m.number}`)
            : results.filter((r) => r.monitor.active).map((r) => `#${r.number}`);
          const activeIds = activeList.length > 0 ? activeList : results.filter((r) => r.monitor.active).map((r) => `#${r.number}`);
          const stillActive = results.some((r) => r.monitor.active);
          return {
            text:
              (stillActive
                ? `Now monitoring ${results.filter((r) => r.monitor.active).length} PR(s) ${scope === "full" ? "until merge/close" : "until CI finishes"}. You will be notified automatically via an incoming message — continue with other work.\n\n`
                : `No PR is still being monitored (CI already finished or the PR is closed).\n\n`) +
              `Current state:\n${lines.join("\n")}` +
              (activeIds.length ? `\n\nActive subscriptions: ${activeIds.join(", ")}.` : ""),
          };
        }
        if (name === "github_list_prs") {
          const { owner, repo } = await resolveRepo(entry, args);
          const state = ["open", "closed", "all"].includes(args.state) ? args.state : "open";
          const limit = Number.isInteger(args.limit) ? Math.min(30, Math.max(1, args.limit)) : 10;
          const prs = await request("GET", `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${limit}&sort=created&direction=desc`);
          return { text: formatPrList(Array.isArray(prs) ? prs : [], `${owner}/${repo}`, state) };
        }
        return fail(`unknown GitHub tool: ${name}`);
      } catch (error) {
        return fail(error?.message ?? String(error));
      }
    },
  };
}

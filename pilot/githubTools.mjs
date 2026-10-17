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
      "Returns the PR number and URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Pull request title." },
        body: { type: "string", description: "Pull request description (Markdown). Optional." },
        head: { type: "string", description: "Head branch (or owner:branch for a fork). Defaults to the workspace's current branch." },
        base: { type: "string", description: "Base branch. Defaults to the repository's default branch." },
        draft: { type: "boolean", description: "Create as a draft pull request." },
        repo: { type: "string", description: "Repository as owner/repo. Defaults to the workspace's origin remote." },
      },
      required: ["title"],
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
      "Start or stop background monitoring of one or more pull requests. Code Space polls them about once a minute and posts an update " +
      "to this session when something material changes — a review or approval, new comments, CI checks failing or " +
      "passing, or a PR merging/closing — and a live Monitoring row in the transcript tracks each PR. Monitoring " +
      "survives restarts and runs until the PR merges or closes. Pass action: \"unsubscribe\" or stop: true to end it early.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["subscribe", "unsubscribe"], description: "Whether to start (subscribe) or stop (unsubscribe) monitoring. Default subscribe." },
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
          return { text: formatCreatedPr(pr) };
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
          const results = [];
          for (const num of prNumbers) {
            const res = await monitors.start({ logId: entry.logId, owner, repo, number: num });
            results.push({ number: num, ...res });
          }
          const lines = [];
          for (const { number: num, monitor, created } of results) {
            const snap = monitor.snapshot;
            const checks = snap ? `${snap.checks.passed} passed, ${snap.checks.failed} failed, ${snap.checks.pending} pending` : "checks unknown";
            const stateTag = monitor.active ? (snap?.draft ? "DRAFT" : "OPEN") : String(monitor.status).toUpperCase();
            const comments = snap?.commentCount ?? 0;
            const headLine = `${created ? "Monitoring" : "Already monitoring"} ${owner}/${repo}#${num}${snap?.title ? ` — ${snap.title}` : ""} (checks: ${checks})`;
            lines.push(`  #${num} — ${stateTag} · CI: ${checks} · ${comments} comment${comments === 1 ? "" : "s"} · ${headLine}`);
          }
          const activeList = typeof monitors.list === "function"
            ? monitors.list().filter((m) => m.active && m.logId === entry.logId).map((m) => `#${m.number}`)
            : results.filter((r) => r.monitor.active).map((r) => `#${r.number}`);
          const activeIds = activeList.length > 0 ? activeList : results.map((r) => `#${r.number}`);
          return {
            text:
              `Now monitoring ${results.length} PR(s). You will be notified automatically via an incoming message when something changes — continue with other work.\n\n` +
              `Current state:\n${lines.join("\n")}\n\n` +
              `Active subscriptions: ${activeIds.join(", ")}.`,
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

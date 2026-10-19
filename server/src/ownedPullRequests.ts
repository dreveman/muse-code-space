export type OwnedPullRequest = {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  url: string;
  branchLine: string | null;
  draft: boolean;
  state: "open" | "merged" | "closed";
  checks: "pending" | "success" | "failure" | "none" | null;
  checksSummary: string | null;
  latestChange: string | null;
  monitoring: boolean;
};

type EventLike = {
  kind: string;
  content: string;
  tool_details?: {
    tool: string | null;
    args: string | null;
    status: string | null;
    failureReason: string | null;
    output?: string | null;
    visibleOutput?: string | null;
  } | null;
};

const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\b/;
const CREATED_PR_HEADER_RE = /^Created PR #(\d+)\s+([^\r\n]+)/m;

function stripMcpPrefix(name: string): string {
  const match = name.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  return match && match[1] ? match[1] : name;
}

function isGhPrCreateCommand(rawArgs: string | null): boolean {
  if (!rawArgs) return false;
  try {
    const parsed = JSON.parse(rawArgs) as { command?: unknown };
    return typeof parsed?.command === "string" && /\bgh\s+pr\s+create\b/.test(parsed.command);
  } catch {
    return false;
  }
}

type ParsedMonitorRow = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  status: string;
  checks: { passed: number; failed: number; pending: number; failing: string[] };
  approvals: number;
  comments: number;
  changes: Array<{ at: string; text: string }>;
};

function parseMonitorContent(content: string): ParsedMonitorRow | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.owner !== "string" ||
      typeof row.repo !== "string" ||
      typeof row.number !== "number" ||
      typeof row.status !== "string"
    ) {
      return null;
    }
    const checks = (row.checks && typeof row.checks === "object" ? row.checks : {}) as Record<string, unknown>;
    return {
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      title: typeof row.title === "string" ? row.title : "",
      url: typeof row.url === "string" ? row.url : `https://github.com/${row.owner}/${row.repo}/pull/${row.number}`,
      status: row.status,
      checks: {
        passed: typeof checks.passed === "number" ? checks.passed : 0,
        failed: typeof checks.failed === "number" ? checks.failed : 0,
        pending: typeof checks.pending === "number" ? checks.pending : 0,
        failing: Array.isArray(checks.failing)
          ? checks.failing.filter((name): name is string => typeof name === "string")
          : [],
      },
      approvals: typeof row.approvals === "number" ? row.approvals : 0,
      comments: typeof row.comments === "number" ? row.comments : 0,
      changes: Array.isArray(row.changes)
        ? row.changes
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            .map((item) => ({
              at: typeof item.at === "string" ? item.at : "",
              text: typeof item.text === "string" ? item.text : "",
            }))
            .filter((item) => item.text.length > 0)
        : [],
    };
  } catch {
    return null;
  }
}

function summarizeMonitor(row: ParsedMonitorRow): string {
  const parts: string[] = [];
  const { passed, failed, pending, failing } = row.checks;
  if (passed + failed + pending > 0) {
    const c: string[] = [];
    if (passed) c.push(`${passed} passed`);
    if (failed) c.push(`${failed} failed${failing.length ? ` (${failing.slice(0, 3).join(", ")})` : ""}`);
    if (pending) c.push(`${pending} running`);
    parts.push(`CI: ${c.join(", ")}`);
  }
  if (row.approvals > 0) parts.push(`${row.approvals} approval${row.approvals === 1 ? "" : "s"}`);
  if (row.comments > 0) parts.push(`${row.comments} comment${row.comments === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * Extract all pull requests created within a conversation from its transcript
 * events (completed `github_create_pr` tool calls or `gh pr create` bash calls),
 * enriched with the latest state from any `pr_monitor` rows in the conversation.
 */
export function ownedPullRequestsFromEvents(events: readonly EventLike[]): OwnedPullRequest[] {
  const byKey = new Map<string, OwnedPullRequest>();

  for (const event of events) {
    if (event.kind === "tool" && event.tool_details) {
      const details = event.tool_details;
      if (!details.tool || details.status !== "completed" || details.failureReason) continue;
      const tool = stripMcpPrefix(details.tool);
      const output = details.output ?? details.visibleOutput ?? "";
      if (!output || output.startsWith("Failed:")) continue;

      if (tool === "github_create_pr" || (tool === "bash" && isGhPrCreateCommand(details.args))) {
        const urlMatch = output.match(PR_URL_RE);
        if (!urlMatch) continue;
        const repo = urlMatch[1]!;
        const number = Number(urlMatch[2]!);
        if (!Number.isInteger(number) || number <= 0) continue;

        let title: string | null = null;
        let branchLine: string | null = null;
        let draft = false;
        const headerMatch = output.match(CREATED_PR_HEADER_RE);
        if (headerMatch) {
          let rawTitle = headerMatch[2]!.trim();
          if (rawTitle.endsWith(" (draft)")) {
            draft = true;
            rawTitle = rawTitle.slice(0, -8).trim();
          }
          title = rawTitle || null;
        }
        const branchMatch = output.match(/^([^\r\n]+?\s*→\s*[^\r\n]+)$/m);
        if (branchMatch) {
          branchLine = branchMatch[1]!.trim();
        }
        if (details.args) {
          try {
            const parsedArgs = JSON.parse(details.args) as { title?: unknown; draft?: unknown; head?: unknown; base?: unknown };
            if (!title && typeof parsedArgs.title === "string" && parsedArgs.title.trim()) {
              title = parsedArgs.title.trim();
            }
            if (!branchLine && typeof parsedArgs.head === "string" && typeof parsedArgs.base === "string") {
              branchLine = `${parsedArgs.head} → ${parsedArgs.base}`;
            }
            if (parsedArgs.draft === true) draft = true;
          } catch {
            // ignore unparseable args
          }
        }

        const key = `${repo.toLowerCase()}#${number}`;
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            repo,
            number,
            title,
            url: `https://github.com/${repo}/pull/${number}`,
            branchLine,
            draft,
            state: "open",
            checks: null,
            checksSummary: null,
            latestChange: null,
            monitoring: false,
          });
        }
      }
    }
  }

  if (byKey.size === 0) return [];

  for (const event of events) {
    if (event.kind !== "pr_monitor") continue;
    const monitor = parseMonitorContent(event.content);
    if (!monitor) continue;
    const fullRepo = `${monitor.owner}/${monitor.repo}`;
    const key = `${fullRepo.toLowerCase()}#${monitor.number}`;
    const existing = byKey.get(key);
    if (!existing) continue;
    const checksOverall: OwnedPullRequest["checks"] =
      monitor.checks.failed > 0
        ? "failure"
        : monitor.checks.pending > 0
          ? "pending"
          : monitor.checks.passed > 0
            ? "success"
            : existing.checks;
    const summary = summarizeMonitor(monitor) || existing.checksSummary;
    const latestChange = monitor.changes.at(-1)?.text ?? existing.latestChange;
    byKey.set(key, {
      ...existing,
      title: monitor.title || existing.title,
      url: monitor.url || existing.url,
      state:
        monitor.status === "merged"
          ? "merged"
          : monitor.status === "closed"
            ? "closed"
            : "open",
      checks: checksOverall,
      checksSummary: summary,
      latestChange,
      monitoring: monitor.status === "monitoring",
    });
  }

  return [...byKey.values()];
}

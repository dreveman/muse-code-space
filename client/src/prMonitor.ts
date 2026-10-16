// Parsing and summarizing for the transcript's PR monitor row
// (kind "pr_monitor"; content is the JSON the pilot upserts per poll
// change). Defensive: old or partial rows render as a plain label.

export type PrMonitorRow = {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  status: string; // monitoring | merged | closed | stopped | error
  checks: { passed: number; failed: number; pending: number; failing: string[] };
  approvals: number;
  comments: number;
  changes: Array<{ at: string; text: string }>;
  startedAt: string;
  updatedAt: string;
};

export function parsePrMonitor(content: string): PrMonitorRow | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.owner !== "string" || typeof row.repo !== "string" ||
        typeof row.number !== "number" || typeof row.status !== "string") return null;
    const checks = (row.checks && typeof row.checks === "object" ? row.checks : {}) as Record<string, unknown>;
    return {
      id: row.id,
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
        failing: Array.isArray(checks.failing) ? checks.failing.filter((name): name is string => typeof name === "string") : [],
      },
      approvals: typeof row.approvals === "number" ? row.approvals : 0,
      comments: typeof row.comments === "number" ? row.comments : 0,
      changes: Array.isArray(row.changes)
        ? row.changes.filter((c): c is { at: string; text: string } =>
            !!c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string")
            .map((c) => ({ at: typeof c.at === "string" ? c.at : "", text: c.text }))
        : [],
      startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function prMonitorStatusLine(row: PrMonitorRow): string {
  if (row.status === "merged") return "Merged";
  if (row.status === "closed") return "Closed without merging";
  if (row.status === "stopped") return "Monitoring stopped";
  if (row.status === "error") return "Monitoring stopped (error)";
  return "Monitoring";
}

/** One-line CI/engagement summary, e.g. "3 checks passed · 1 failed (typecheck) · 2 approvals · 4 comments". */
export function prMonitorSummary(row: PrMonitorRow): string {
  const parts: string[] = [];
  const { passed, failed, pending, failing } = row.checks;
  if (passed + failed + pending > 0) {
    const bits: string[] = [];
    if (passed) bits.push(`${passed} passed`);
    if (failed) bits.push(`${failed} failed${failing.length ? ` (${failing.slice(0, 3).join(", ")})` : ""}`);
    if (pending) bits.push(`${pending} running`);
    parts.push(`CI: ${bits.join(", ")}`);
  }
  if (row.approvals) parts.push(`${row.approvals} approval${row.approvals === 1 ? "" : "s"}`);
  if (row.comments) parts.push(`${row.comments} comment${row.comments === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

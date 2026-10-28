// Global, lifetime statistics per companion, tracked incrementally as work
// happens (never computed from old session transcripts, never backfilled).
// The counters and tracked-PR rows live in their own tables (see schema.ts);
// this module holds the pure decisions: what counts, and when.

export type TrackedPrState = "open" | "merged" | "closed";

export type TrackedPr = {
  companionId: string;
  repo: string;
  number: number;
  state: TrackedPrState;
  linesCounted: boolean;
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
};

export type CompanionStatisticsCounters = {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  toolCalls: number;
  userTurns: number;
  runtimeMs: number;
  lastActiveAt: string | null;
};

export type CompanionStatisticsSummary = {
  companion_id: string;
  prs_created: number;
  prs_merged: number;
  prs_closed: number;
  prs_open: number;
  merge_rate: number | null;
  lines_added: number;
  lines_removed: number;
  net_lines: number;
  files_changed: number;
  tool_calls: number;
  user_turns: number;
  runtime_ms: number;
  last_active_at: string | null;
};

type ToolEventLike = {
  kind: string;
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

/**
 * The PR created by one completed tool event, or null when the event is not
 * a successful PR creation. Mirrors the creation detection in
 * ownedPullRequests.ts, but for a single live event at ingestion time.
 */
export function createdPullRequestFromToolEvent(event: ToolEventLike): {
  repo: string; number: number; title: string | null; url: string; draft: boolean;
} | null {
  if (event.kind !== "tool" || !event.tool_details) return null;
  const details = event.tool_details;
  if (!details.tool || details.status !== "completed" || details.failureReason) return null;
  const tool = stripMcpPrefix(details.tool);
  if (tool !== "github_create_pr" && !(tool === "bash" && isGhPrCreateCommand(details.args))) return null;
  const output = details.output ?? details.visibleOutput ?? "";
  if (!output || output.startsWith("Failed:")) return null;
  const urlMatch = output.match(PR_URL_RE);
  if (!urlMatch) return null;
  const repo = urlMatch[1]!;
  const number = Number(urlMatch[2]!);
  if (!Number.isInteger(number) || number <= 0) return null;

  let title: string | null = null;
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
  if (details.args) {
    try {
      const parsedArgs = JSON.parse(details.args) as { title?: unknown; draft?: unknown };
      if (!title && typeof parsedArgs.title === "string" && parsedArgs.title.trim()) title = parsedArgs.title.trim();
      if (parsedArgs.draft === true) draft = true;
    } catch { /* unparseable args: header/URL are enough */ }
  }
  return { repo, number, title, url: `https://github.com/${repo}/pull/${number}`, draft };
}

function nonNegativeInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type PrMonitorSnapshotLike = {
  status: string;
  additions?: number | null;
  deletions?: number | null;
  filesChanged?: number | null;
};

/**
 * Fold one PR monitor snapshot into a tracked PR. Lines are counted exactly
 * once: on the first merged snapshot that carries GitHub's final line
 * counts. A merge observed before those counts arrive stays uncounted so a
 * later enriched snapshot can still add them.
 */
export function applyPrMonitorSnapshot(tracked: TrackedPr, snapshot: PrMonitorSnapshotLike): {
  tracked: TrackedPr;
  linesDelta: { additions: number; deletions: number; filesChanged: number } | null;
} {
  const observed: TrackedPrState = snapshot.status === "merged" ? "merged" : snapshot.status === "closed" ? "closed" : "open";
  // A merged PR cannot reopen on GitHub; keep the terminal state sticky.
  const state: TrackedPrState = tracked.state === "merged" ? "merged" : observed;
  const additions = nonNegativeInt(snapshot.additions);
  const deletions = nonNegativeInt(snapshot.deletions);
  const filesChanged = nonNegativeInt(snapshot.filesChanged);

  let linesDelta: { additions: number; deletions: number; filesChanged: number } | null = null;
  let linesCounted = tracked.linesCounted;
  if (state === "merged" && !linesCounted && additions !== null && deletions !== null && filesChanged !== null) {
    linesDelta = { additions, deletions, filesChanged };
    linesCounted = true;
  }

  return {
    tracked: {
      ...tracked,
      state,
      linesCounted,
      additions: additions ?? tracked.additions,
      deletions: deletions ?? tracked.deletions,
      filesChanged: filesChanged ?? tracked.filesChanged,
    },
    linesDelta,
  };
}

export type AccomplishmentIcon = "badge" | "medal" | "trophy";

export type CompanionAccomplishment = {
  id: "prs-landed" | "lines-shipped" | "files-touched";
  label: string;
  icon: AccomplishmentIcon;
  // Highest milestone threshold reached (0 = none yet) and the next one up.
  earnedThreshold: number;
  nextThreshold: number | null;
  current: number;
};

const ACCOMPLISHMENT_SERIES: ReadonlyArray<{
  id: CompanionAccomplishment["id"];
  label: string;
  value: (stats: { prs_merged: number; lines_added: number; files_changed: number }) => number;
  tiers: ReadonlyArray<{ threshold: number; icon: AccomplishmentIcon }>;
}> = [
  {
    id: "prs-landed", label: "PRs landed", value: (stats) => stats.prs_merged,
    tiers: [
      { threshold: 1, icon: "badge" }, { threshold: 5, icon: "badge" },
      { threshold: 10, icon: "medal" }, { threshold: 25, icon: "medal" },
      { threshold: 50, icon: "trophy" }, { threshold: 100, icon: "trophy" },
    ],
  },
  {
    id: "lines-shipped", label: "Lines shipped", value: (stats) => stats.lines_added,
    tiers: [
      { threshold: 100, icon: "badge" }, { threshold: 1_000, icon: "badge" },
      { threshold: 10_000, icon: "medal" }, { threshold: 50_000, icon: "trophy" },
    ],
  },
  {
    id: "files-touched", label: "Files touched", value: (stats) => stats.files_changed,
    tiers: [
      { threshold: 10, icon: "badge" }, { threshold: 25, icon: "badge" },
      { threshold: 100, icon: "medal" }, { threshold: 250, icon: "medal" },
      { threshold: 500, icon: "trophy" },
    ],
  },
];

/** Milestone view of the global statistics: what each companion has earned. */
export function companionAccomplishments(stats: {
  prs_merged: number; lines_added: number; files_changed: number;
}): CompanionAccomplishment[] {
  return ACCOMPLISHMENT_SERIES.map((series) => {
    const current = series.value(stats);
    let earnedThreshold = 0;
    let icon: AccomplishmentIcon = "badge";
    let nextThreshold: number | null = series.tiers[0]?.threshold ?? null;
    for (const tier of series.tiers) {
      if (current >= tier.threshold) {
        earnedThreshold = tier.threshold;
        icon = tier.icon;
        nextThreshold = null;
      } else {
        nextThreshold = tier.threshold;
        break;
      }
    }
    return { id: series.id, label: series.label, icon, earnedThreshold, nextThreshold, current };
  });
}

export function summarizeCompanionStatistics(
  companionId: string,
  counters: CompanionStatisticsCounters | null,
  trackedPrs: readonly TrackedPr[],
): CompanionStatisticsSummary {
  const prsMerged = trackedPrs.filter((pr) => pr.state === "merged").length;
  const prsClosed = trackedPrs.filter((pr) => pr.state === "closed").length;
  const prsOpen = trackedPrs.filter((pr) => pr.state === "open").length;
  const decided = prsMerged + prsClosed;
  const linesAdded = counters?.linesAdded ?? 0;
  const linesRemoved = counters?.linesRemoved ?? 0;
  return {
    companion_id: companionId,
    prs_created: trackedPrs.length,
    prs_merged: prsMerged,
    prs_closed: prsClosed,
    prs_open: prsOpen,
    merge_rate: decided > 0 ? prsMerged / decided : null,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    net_lines: linesAdded - linesRemoved,
    files_changed: counters?.filesChanged ?? 0,
    tool_calls: counters?.toolCalls ?? 0,
    user_turns: counters?.userTurns ?? 0,
    runtime_ms: counters?.runtimeMs ?? 0,
    last_active_at: counters?.lastActiveAt ?? null,
  };
}

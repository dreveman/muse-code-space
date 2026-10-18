// Pure helpers for the composer's repo picker row.

export type RepoOption = {
  slug: string;
  name: string;
  owner: string;
  owner_avatar_url?: string | null;
  private: boolean;
  description: string | null;
  default_branch: string | null;
  updated_at: string | null;
  html_url: string;
};

/** Avatar URL for a repository's owner (user or organization). */
export function repoOwnerAvatarUrl(repo: Pick<RepoOption, "owner" | "owner_avatar_url">): string {
  if (repo.owner_avatar_url) return repo.owner_avatar_url;
  return `https://github.com/${encodeURIComponent(repo.owner)}.png?size=64`;
}

export const TOP_REPO_LIMIT = 5;

/** Case-insensitive substring filter over owner/repo, newest first (input order kept). */
export function filterRepos(repos: readonly RepoOption[], query: string): RepoOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...repos];
  return repos.filter((repo) => repo.slug.toLowerCase().includes(needle));
}

/** Slice to the top N repositories unless expanded or actively filtering. */
export function visibleTopRepos(repos: readonly RepoOption[], query: string, expanded: boolean): {
  shown: RepoOption[];
  hasMore: boolean;
} {
  const filtered = filterRepos(repos, query);
  if (query.trim()) {
    return { shown: filtered, hasMore: false };
  }
  return {
    shown: expanded ? filtered : filtered.slice(0, TOP_REPO_LIMIT),
    hasMore: filtered.length > TOP_REPO_LIMIT,
  };
}

export type RepoCloneProgress = {
  active: boolean;
  repo: string | null;
  phase: string | null;
  percent: number | null;
  transferred: string | null;
};

/** Format a compact one-line progress label for an in-flight git clone. */
export function formatCloneProgressLabel(selected: string | null, progress?: RepoCloneProgress | null): string {
  if (!progress || !progress.active) {
    return selected ? `Cloning ${selected}…` : "Cloning…";
  }
  const phase = progress.phase || "Cloning";
  const pct = progress.percent != null ? ` ${progress.percent}%` : "";
  const size = progress.transferred ? ` · ${progress.transferred}` : "";
  return `${phase}${pct}${size}`;
}

/** The status half of the picker row: shown only while starting or queued. */
export function repoStatusText(
  selected: string | null,
  phase: "idle" | "starting" | "queued",
  progress?: RepoCloneProgress | null,
): string {
  if (phase === "queued") return selected ? `Queued — ${selected} clones when the connection is back` : "";
  if (phase === "starting") return selected ? formatCloneProgressLabel(selected, progress) : "";
  return "";
}

/** Trigger label: the pick itself, "Connect GitHub" when disconnected, or "Select repository" when connected with no pick. */
export function repoTriggerLabel(selected: string | null, githubEnabled = true): string {
  if (selected) return selected;
  return githubEnabled ? "Select repository" : "Connect GitHub";
}

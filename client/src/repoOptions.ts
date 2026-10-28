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

/** Inline SVG data URI fallback avatar with the owner's initial (offline-safe). */
export function repoOwnerFallbackAvatar(owner: string): string {
  const initial = (owner.trim()[0] ?? "G").toUpperCase().replace(/[^A-Z0-9]/g, "G");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#57606a"/><text x="16" y="21" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-size="15" font-weight="600">${initial}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

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

/** Base list first, then extras not already in it (slug compared case-insensitively). */
export function mergeRepoOptions(base: readonly RepoOption[], extra: readonly RepoOption[]): RepoOption[] {
  const seen = new Set(base.map((repo) => repo.slug.toLowerCase()));
  const merged = [...base];
  for (const repo of extra) {
    const key = repo.slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(repo);
  }
  return merged;
}

export const PINNED_REPOS_STORAGE_KEY = "muse-code-space:pinned-repos";
export const PINNED_REPO_LIMIT = 20;

/**
 * Validate a stored pinned-repo list (JSON from localStorage). A pin is a
 * full RepoOption snapshot, so a pinned repo can render — and be picked —
 * even when the broker-visible list cannot see it at all. Anything malformed
 * is dropped rather than breaking the picker.
 */
export function parsePinnedRepos(raw: string | null): RepoOption[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const pinned: RepoOption[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const slug = typeof (item as RepoOption).slug === "string" ? (item as RepoOption).slug.trim() : "";
    const parts = slug.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1] || seen.has(slug.toLowerCase())) continue;
    seen.add(slug.toLowerCase());
    const [owner, name] = parts;
    pinned.push({
      slug,
      name: typeof (item as RepoOption).name === "string" && (item as RepoOption).name ? (item as RepoOption).name : name,
      owner: typeof (item as RepoOption).owner === "string" && (item as RepoOption).owner ? (item as RepoOption).owner : owner,
      owner_avatar_url: typeof (item as RepoOption).owner_avatar_url === "string" ? (item as RepoOption).owner_avatar_url : null,
      private: (item as RepoOption).private === true,
      description: typeof (item as RepoOption).description === "string" ? (item as RepoOption).description : null,
      default_branch: typeof (item as RepoOption).default_branch === "string" ? (item as RepoOption).default_branch : null,
      updated_at: typeof (item as RepoOption).updated_at === "string" ? (item as RepoOption).updated_at : null,
      html_url: typeof (item as RepoOption).html_url === "string" && (item as RepoOption).html_url
        ? (item as RepoOption).html_url
        : `https://github.com/${slug}`,
    });
    if (pinned.length >= PINNED_REPO_LIMIT) break;
  }
  return pinned;
}

/** Pin (newest first) or unpin a repo. Pinning past the limit drops the oldest pin. */
export function togglePinnedRepo(pinned: readonly RepoOption[], repo: RepoOption): RepoOption[] {
  const key = repo.slug.toLowerCase();
  if (pinned.some((item) => item.slug.toLowerCase() === key)) {
    return pinned.filter((item) => item.slug.toLowerCase() !== key);
  }
  return [repo, ...pinned].slice(0, PINNED_REPO_LIMIT);
}

/**
 * Pinned repos first, in pin order. A pinned repo present in `repos` uses
 * that fresher entry; one absent from it (e.g. not App-installed) falls
 * back to its stored snapshot so it still shows at the top.
 */
export function applyPinnedRepos(repos: readonly RepoOption[], pinned: readonly RepoOption[]): RepoOption[] {
  if (pinned.length === 0) return [...repos];
  const bySlug = new Map(repos.map((repo) => [repo.slug.toLowerCase(), repo]));
  const pinnedKeys = new Set(pinned.map((repo) => repo.slug.toLowerCase()));
  return [
    ...pinned.map((repo) => bySlug.get(repo.slug.toLowerCase()) ?? repo),
    ...repos.filter((repo) => !pinnedKeys.has(repo.slug.toLowerCase())),
  ];
}

/** Like applyPinnedRepos, but never injects a pinned snapshot that is not already in `repos`. */
export function orderPinnedFirst(repos: readonly RepoOption[], pinned: readonly RepoOption[]): RepoOption[] {
  if (pinned.length === 0) return [...repos];
  const bySlug = new Map(repos.map((repo) => [repo.slug.toLowerCase(), repo]));
  const pinnedKeys = new Set(pinned.map((repo) => repo.slug.toLowerCase()));
  return [
    ...pinned.flatMap((repo) => {
      const hit = bySlug.get(repo.slug.toLowerCase());
      return hit ? [hit] : [];
    }),
    ...repos.filter((repo) => !pinnedKeys.has(repo.slug.toLowerCase())),
  ];
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

// Pure helpers for the composer's repo picker row.

export type RepoOption = {
  slug: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  default_branch: string | null;
  updated_at: string | null;
  html_url: string;
};

/** Case-insensitive substring filter over owner/repo, newest first (input order kept). */
export function filterRepos(repos: readonly RepoOption[], query: string): RepoOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...repos];
  return repos.filter((repo) => repo.slug.toLowerCase().includes(needle));
}

/** The status half of the picker row: what will happen on send. */
export function repoStatusText(selected: string | null, phase: "idle" | "starting" | "queued"): string {
  if (phase === "queued") return selected ? `Queued — ${selected} clones when the connection is back` : "Queued — blank workspace";
  if (phase === "starting") return selected ? `Cloning ${selected}…` : "Starting…";
  return selected ? `${selected} clones into the new workspace on start` : "Blank workspace — pick a repo to clone it on start";
}

/** Trigger label: the pick itself, or the blank-workspace default. */
export function repoTriggerLabel(selected: string | null): string {
  return selected ?? "No repo";
}

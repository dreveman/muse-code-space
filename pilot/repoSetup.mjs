// Repo picker support for new companions: parse what the user picked,
// list the repos the GitHub broker can see, and clone a pick into the
// companion's fresh workspace before its first turn starts.
//
// Pure logic lives here; the pilot injects the side effects:
//   brokerRequest(method, path) -> Promise<{ status, json }>
//   gitClone(cloneUrl, dir)     -> Promise<void> (throws on failure)
//   gitOrigin(dir)              -> Promise<string|null>
//   listDir(dir)                -> string[] | null (null when missing)

const OWNER_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

function fromParts(owner, repo) {
  const cleanRepo = repo.replace(/\.git$/, "");
  if (!owner || !cleanRepo || cleanRepo === "." || cleanRepo === "..") return null;
  const match = OWNER_REPO.exec(`${owner}/${cleanRepo}`);
  if (!match) return null;
  const slug = `${match[1]}/${match[2]}`;
  return { owner: match[1], repo: match[2], slug, cloneUrl: `https://github.com/${slug}.git` };
}

/** Accept `owner/repo`, a github.com HTTPS URL, or a github.com SSH remote. */
export function parseRepoInput(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || /[\s\0]/.test(trimmed)) return null;
  const scp = trimmed.match(/^[^@\s]+@github\.com:(.+)$/);
  if (scp) {
    const parts = scp[1].split("/").filter(Boolean);
    return parts.length === 2 ? fromParts(parts[0], parts[1]) : null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url;
    try { url = new URL(trimmed); } catch { return null; }
    if (url.hostname !== "github.com" || url.password) return null;
    if (url.username && !(url.protocol === "ssh:" && url.username === "git")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 ? fromParts(parts[0], parts[1]) : null;
  }
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length === 2 && trimmed.split("/").length === 2 ? fromParts(parts[0], parts[1]) : null;
}

/** Slug of a git origin URL, for the already-cloned check. Any host counts. */
export function originSlug(remote) {
  if (typeof remote !== "string") return null;
  const parsed = parseRepoInput(remote.trim());
  if (parsed) return parsed.slug.toLowerCase();
  // Non-GitHub remotes still identify the checkout so a retry never
  // silently swaps the repo under a live workspace.
  const match = remote.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function mapRepo(raw) {
  const fullName = typeof raw?.full_name === "string" ? raw.full_name : typeof raw?.nameWithOwner === "string" ? raw.nameWithOwner : null;
  if (!fullName) return null;
  const parsed = parseRepoInput(fullName);
  if (!parsed) return null;
  const defaultBranch = typeof raw.default_branch === "string"
    ? raw.default_branch
    : typeof raw?.defaultBranchRef?.name === "string"
      ? raw.defaultBranchRef.name
      : null;
  const updatedAt = typeof raw.updated_at === "string"
    ? raw.updated_at
    : typeof raw.updatedAt === "string"
      ? raw.updatedAt
      : null;
  const htmlUrl = typeof raw.html_url === "string"
    ? raw.html_url
    : typeof raw.url === "string"
      ? raw.url
      : `https://github.com/${parsed.slug}`;
  const ownerAvatarUrl = typeof raw?.owner?.avatarUrl === "string"
    ? raw.owner.avatarUrl
    : typeof raw?.owner?.avatar_url === "string"
      ? raw.owner.avatar_url
      : `https://github.com/${encodeURIComponent(parsed.owner)}.png?size=64`;
  return {
    slug: parsed.slug,
    name: parsed.repo,
    owner: parsed.owner,
    owner_avatar_url: ownerAvatarUrl,
    private: raw.private === true || raw.isPrivate === true,
    description: typeof raw.description === "string" ? raw.description : null,
    default_branch: defaultBranch,
    updated_at: updatedAt,
    html_url: htmlUrl,
  };
}

const TOP_REPOS_QUERY =
  "query { viewer { topRepositories(first: 50, orderBy: {field: PUSHED_AT, direction: DESC}) { nodes { full_name: nameWithOwner private: isPrivate description defaultBranchRef { name } updated_at: updatedAt html_url: url owner { avatarUrl(size: 64) } } } } }";

/**
 * Repos the broker credential can see. Queries GitHub's GraphQL
 * `viewer.topRepositories` first (matching github.com's "Top repositories"
 * list), then falls back to `/user/repos` and `/installation/repositories`.
 */
export async function listGitHubRepos({ enabled, brokerRequest }) {
  if (!enabled()) return { enabled: false, repos: [] };
  const attempts = [
    {
      method: "POST",
      path: "/graphql",
      body: { query: TOP_REPOS_QUERY },
      pick: (json) => (Array.isArray(json?.data?.viewer?.topRepositories?.nodes) ? json.data.viewer.topRepositories.nodes : null),
      keepOrder: true,
    },
    {
      method: "GET",
      path: "/user/repos?per_page=100&sort=updated&direction=desc",
      pick: (json) => (Array.isArray(json) ? json : null),
      keepOrder: false,
    },
    {
      method: "GET",
      path: "/installation/repositories?per_page=100",
      pick: (json) => (Array.isArray(json?.repositories) ? json.repositories : null),
      keepOrder: false,
    },
  ];
  let lastStatus = 0;
  for (const attempt of attempts) {
    const result = await brokerRequest(attempt.method, attempt.path, attempt.body);
    lastStatus = result.status;
    const raw = result.status >= 200 && result.status < 300 ? attempt.pick(result.json) : null;
    if (!raw || raw.length === 0) continue;
    const seen = new Set();
    const repos = [];
    for (const item of raw) {
      const repo = mapRepo(item);
      if (!repo || seen.has(repo.slug.toLowerCase())) continue;
      seen.add(repo.slug.toLowerCase());
      repos.push(repo);
    }
    if (!attempt.keepOrder) {
      repos.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    }
    return { enabled: true, repos: repos.slice(0, 100) };
  }
  if (lastStatus >= 200 && lastStatus < 300) {
    return { enabled: true, repos: [] };
  }
  throw new Error(`GitHub repo list failed (HTTP ${lastStatus || "no response"}).`);
}

/**
 * Parse a chunk of `git clone --progress` stderr output into the latest
 * `{ phase, percent, transferred }` snapshot.
 */
export function parseGitCloneProgress(chunk, previous = null) {
  if (typeof chunk !== "string" || !chunk) return previous;
  let state = previous ? { ...previous } : { phase: "Cloning", percent: null, transferred: null };
  const lines = chunk.split(/[\r\n]+/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^remote:\s*/i, "").trim();
    if (!line) continue;
    const match = line.match(
      /^(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s*(?:(\d{1,3})%\s*(?:\([^)]*\))?)?(?:,?\s*([^|]+?))?(?:\s*\|.*)?$/i,
    );
    if (match) {
      const phase = match[1];
      const percent = match[2] !== undefined ? Math.min(100, Math.max(0, Number(match[2]))) : state.percent;
      const cleaned = match[3] ? match[3].replace(/,?\s*done\.?$/i, "").trim() : "";
      const transferred = cleaned && !/^\d+$/.test(cleaned) ? cleaned : state.transferred;
      state = { phase, percent, transferred };
    }
  }
  return state;
}

/**
 * Clone `repo` into `dir`, or reuse `dir` when a retry finds the same repo
 * already cloned there. Any other content is a hard error: a generated
 * workspace must never absorb an unrelated checkout.
 */
export async function ensureRepoCloned({ dir, repo, gitClone, gitOrigin, listDir, onProgress }) {
  const entries = listDir(dir);
  if (entries && entries.includes(".git")) {
    const existing = originSlug(await gitOrigin(dir));
    if (existing && existing === repo.slug.toLowerCase()) return { cloned: false, reused: true };
    throw new Error("This companion's working directory already contains a different repository. Start a new companion.");
  }
  if (entries && entries.length > 0) {
    throw new Error("This companion's working directory is not empty and is not the picked repository. Start a new companion.");
  }
  await gitClone(repo.cloneUrl, dir, onProgress);
  return { cloned: true, reused: false };
}

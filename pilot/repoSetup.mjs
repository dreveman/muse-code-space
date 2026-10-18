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
  if (!raw || typeof raw.full_name !== "string") return null;
  const parsed = parseRepoInput(raw.full_name);
  if (!parsed) return null;
  return {
    slug: parsed.slug,
    name: parsed.repo,
    owner: parsed.owner,
    private: raw.private === true,
    description: typeof raw.description === "string" ? raw.description : null,
    default_branch: typeof raw.default_branch === "string" ? raw.default_branch : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
    html_url: typeof raw.html_url === "string" ? raw.html_url : `https://github.com/${parsed.slug}`,
  };
}

/**
 * Repos the broker credential can see. User/PAT credentials answer
 * /user/repos; GitHub App installation tokens answer
 * /installation/repositories instead, so fall back when the first route
 * does not return a list.
 */
export async function listGitHubRepos({ enabled, brokerRequest }) {
  if (!enabled()) return { enabled: false, repos: [] };
  const attempts = [
    { path: "/user/repos?per_page=100&sort=updated&direction=desc", pick: (json) => (Array.isArray(json) ? json : null) },
    { path: "/installation/repositories?per_page=100", pick: (json) => (Array.isArray(json?.repositories) ? json.repositories : null) },
  ];
  let lastStatus = 0;
  for (const attempt of attempts) {
    const result = await brokerRequest("GET", attempt.path);
    lastStatus = result.status;
    const raw = result.status >= 200 && result.status < 300 ? attempt.pick(result.json) : null;
    if (!raw) continue;
    const seen = new Set();
    const repos = [];
    for (const item of raw) {
      const repo = mapRepo(item);
      if (!repo || seen.has(repo.slug.toLowerCase())) continue;
      seen.add(repo.slug.toLowerCase());
      repos.push(repo);
    }
    repos.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return { enabled: true, repos: repos.slice(0, 100) };
  }
  throw new Error(`GitHub repo list failed (HTTP ${lastStatus || "no response"}).`);
}

/**
 * Clone `repo` into `dir`, or reuse `dir` when a retry finds the same repo
 * already cloned there. Any other content is a hard error: a generated
 * workspace must never absorb an unrelated checkout.
 */
export async function ensureRepoCloned({ dir, repo, gitClone, gitOrigin, listDir }) {
  const entries = listDir(dir);
  if (entries && entries.includes(".git")) {
    const existing = originSlug(await gitOrigin(dir));
    if (existing && existing === repo.slug.toLowerCase()) return { cloned: false, reused: true };
    throw new Error("This companion's working directory already contains a different repository. Start a new companion.");
  }
  if (entries && entries.length > 0) {
    throw new Error("This companion's working directory is not empty and is not the picked repository. Start a new companion.");
  }
  await gitClone(repo.cloneUrl, dir);
  return { cloned: true, reused: false };
}

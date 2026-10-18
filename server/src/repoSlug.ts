// Shared validation for the repo picker. The client uses it to validate a
// pasted pick before sending, the server re-validates before storing it,
// and the pilot parses the stored slug again before cloning. Only
// github.com repos are pickable: the broker that carries git/API traffic
// forwards to github.com alone.

const OWNER_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

function fromParts(owner: string, repo: string): string | null {
  const cleanRepo = repo.replace(/\.git$/, "");
  if (!owner || !cleanRepo || cleanRepo === "." || cleanRepo === "..") return null;
  const match = OWNER_REPO.exec(`${owner}/${cleanRepo}`);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Canonical `owner/repo` from `owner/repo`, a github.com URL, or an SSH remote; null otherwise. */
export function parseRepoSlug(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || /[\s\0]/.test(trimmed)) return null;
  const scp = trimmed.match(/^[^@\s]+@github\.com:(.+)$/);
  if (scp) {
    const parts = scp[1]!.split("/").filter(Boolean);
    return parts.length === 2 ? fromParts(parts[0]!, parts[1]!) : null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try { url = new URL(trimmed); } catch { return null; }
    if (url.hostname !== "github.com" || url.password) return null;
    if (url.username && !(url.protocol === "ssh:" && url.username === "git")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 ? fromParts(parts[0]!, parts[1]!) : null;
  }
  const rawParts = trimmed.split("/");
  const parts = rawParts.filter(Boolean);
  return parts.length === 2 && rawParts.length === 2 ? fromParts(parts[0]!, parts[1]!) : null;
}

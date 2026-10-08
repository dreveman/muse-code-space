import type { ToolDetails } from "./toolDetails";

// Ownership is evidence of a completed, byte-confirmed write_file call. A
// read, an edit to an existing file, a shell command or an unverified tool
// result cannot make a file appear in the agent's artifact menu.
function relativePath(value: unknown, workspaceRoot: string): string | null {
  if (typeof value !== "string" || !value || value.length > 2000 || /[\x00-\x1f\x7f\\]/.test(value)) return null;
  const relative = value.startsWith(`${workspaceRoot}/`) ? value.slice(workspaceRoot.length + 1) : value;
  if (relative.startsWith("/") || relative.split("/").includes("..")) return null;
  const normalized = relative.split("/").filter((segment) => segment && segment !== ".").join("/");
  return normalized || null;
}

export function confirmedWritePath(details: ToolDetails | null, workspaceRoot: string): string | null {
  if (details?.tool !== "write_file" || details.status !== "completed" || details.failureReason || details.truncated ||
      !details.args || !details.output || details.args.length > 1024 * 1024) return null;
  let args: unknown;
  try { args = JSON.parse(details.args); } catch { return null; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const { path, content } = args as { path?: unknown; content?: unknown };
  if (typeof content !== "string") return null;
  const submitted = relativePath(path, workspaceRoot);
  const match = details.output.trim().match(/^wrote (\d+) bytes to ([^\r\n]+)$/);
  if (!submitted || !match || Number(match[1]) !== new TextEncoder().encode(content).length) return null;
  return relativePath(match[2], workspaceRoot) === submitted ? submitted : null;
}

export function ownedArtifactPaths(rows: readonly { toolDetails: string | null }[], workspaceRoot: string, parseDetails: (raw: string | null) => ToolDetails | null): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    const path = confirmedWritePath(parseDetails(row.toolDetails), workspaceRoot);
    if (path) paths.add(path);
  }
  return [...paths]; // rows are newest first; repeat writes keep first position
}

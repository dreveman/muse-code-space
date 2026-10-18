// Git-backed VCS status and Smartlog builder for session workspaces.
// Produces the same structured smartlog payload shape that Agent Home 2.0's
// Smart Log pane consumes (`isGitCheckout`, `branch`, `headSha`, `files`,
// `uncommittedFileCount`, `totalAdditions`, `totalDeletions`,
// `smartlogCommits`).

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/**
 * Parse `git status --porcelain=v1 -uall` and `git diff HEAD --numstat`
 * into uncommitted file entries and total +/- line churn.
 */
export function parseGitWorkingTreeStatus(porcelainText, numstatText) {
  const churnByPath = new Map();
  let totalAdditions = 0;
  let totalDeletions = 0;

  if (typeof numstatText === "string" && numstatText.trim()) {
    for (const rawLine of numstatText.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const parts = rawLine.split("\t");
      if (parts.length < 3) continue;
      const add = parts[0] === "-" ? null : Number(parts[0]);
      const del = parts[1] === "-" ? null : Number(parts[1]);
      const filePath = parts.slice(2).join("\t").trim();
      if (!filePath) continue;
      const additions = Number.isFinite(add) ? add : null;
      const deletions = Number.isFinite(del) ? del : null;
      churnByPath.set(filePath, { additions, deletions });
      if (additions != null) totalAdditions += additions;
      if (deletions != null) totalDeletions += deletions;
    }
  }

  const files = [];
  if (typeof porcelainText === "string" && porcelainText) {
    for (const rawLine of porcelainText.split(/\r?\n/)) {
      if (rawLine.length < 4) continue;
      const xy = rawLine.slice(0, 2);
      let filePath = rawLine.slice(3).trim();
      const arrowIdx = filePath.indexOf(" -> ");
      if (arrowIdx !== -1) filePath = filePath.slice(arrowIdx + 4).trim();
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      if (!filePath) continue;
      let status = "M";
      if (xy === "??" || xy.includes("A")) status = "A";
      else if (xy.includes("D")) status = "D";
      else if (xy.includes("R")) status = "R";
      const churn = churnByPath.get(filePath);
      files.push({
        path: filePath,
        status,
        additions: churn?.additions ?? null,
        deletions: churn?.deletions ?? null,
      });
    }
  }

  return {
    uncommittedFileCount: files.length,
    totalAdditions: files.length > 0 ? totalAdditions : 0,
    totalDeletions: files.length > 0 ? totalDeletions : 0,
    files,
  };
}

/**
 * Parse `git log` output formatted with `SMARTLOG_GIT_FORMAT` into
 * Smartlog commit nodes, classifying commits reachable from remote tracking
 * refs (`publicHashes`) as `phase: "public"` and local unpushed commits as
 * `phase: "draft"`.
 */
export function parseGitSmartlogCommits(logText, { headFullHash, publicHashes = new Set() } = {}) {
  if (typeof logText !== "string" || !logText.trim()) return [];
  const rawRecords = logText.split(RECORD_SEP).map((s) => s.trim()).filter(Boolean);

  // First pass: map full hash -> short 12-char hash so parent references use
  // the same 12-char hash keys as `commit.hash`.
  const entries = [];
  const shortByFull = new Map();
  for (const record of rawRecords) {
    const [fullHash, parentsRaw, author, date, decorationsRaw, title] = record.split(FIELD_SEP);
    if (!fullHash || fullHash.length < 7) continue;
    const hash = fullHash.slice(0, 12);
    shortByFull.set(fullHash, hash);
    entries.push({
      fullHash,
      hash,
      parentsFull: (parentsRaw ?? "").trim().split(/\s+/).filter(Boolean),
      author: (author ?? "").trim(),
      date: (date ?? "").trim(),
      decorationsRaw: (decorationsRaw ?? "").trim(),
      title: (title ?? "").trim() || "(no subject)",
    });
  }

  const hasRemoteRefs = publicHashes.size > 0;

  return entries.map((entry, index) => {
    const bookmarks = [];
    const remoteBookmarks = [];
    let isDot = headFullHash ? entry.fullHash === headFullHash : index === 0;

    if (entry.decorationsRaw) {
      for (const rawRef of entry.decorationsRaw.split(",")) {
        const ref = rawRef.trim();
        if (!ref) continue;
        if (ref === "HEAD") {
          isDot = true;
          continue;
        }
        const headArrow = ref.match(/^HEAD\s*->\s*(.+)$/);
        if (headArrow) {
          isDot = true;
          bookmarks.push(headArrow[1].trim());
          continue;
        }
        if (ref.startsWith("tag: ")) continue;
        if (ref.endsWith("/HEAD")) continue;
        if (ref.startsWith("origin/") || ref.includes("/")) {
          remoteBookmarks.push(ref);
        } else {
          bookmarks.push(ref);
        }
      }
    }

    const isPublic = hasRemoteRefs
      ? publicHashes.has(entry.fullHash) || remoteBookmarks.length > 0
      : remoteBookmarks.length > 0 || (entries.length > 1 && index === entries.length - 1);

    const parents = entry.parentsFull.map((p) => shortByFull.get(p) ?? p.slice(0, 12));

    return {
      hash: entry.hash,
      parents,
      phase: isPublic ? "public" : "draft",
      isDot,
      title: entry.title,
      author: entry.author,
      date: entry.date,
      bookmarks,
      remoteBookmarks,
    };
  });
}

export const SMARTLOG_GIT_FORMAT = `%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%D${FIELD_SEP}%s${RECORD_SEP}`;

/**
 * Inspect a session workspace directory with `git` (`gitExec(args) -> Promise<string|null>`)
 * and return its VCS status + Smartlog graph.
 */
export async function readGitVcsStatus({ dir, gitExec }) {
  const empty = {
    isGitCheckout: false,
    branch: null,
    headSha: null,
    uncommittedFileCount: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    files: [],
    smartlogCommits: [],
  };
  if (!dir || typeof gitExec !== "function") return empty;

  const inside = await gitExec(["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return empty;

  const [branchRaw, headFullRaw, porcelainRaw, numstatRaw, remoteHashesRaw, logRaw] = await Promise.all([
    gitExec(["symbolic-ref", "--short", "-q", "HEAD"]),
    gitExec(["rev-parse", "HEAD"]),
    gitExec(["status", "--porcelain=v1", "-uall"]),
    gitExec(["diff", "HEAD", "--numstat"]),
    gitExec(["rev-list", "--max-count=80", "--remotes=origin"]),
    gitExec([
      "log",
      "--topo-order",
      "--max-count=35",
      `--format=${SMARTLOG_GIT_FORMAT}`,
      "HEAD",
      "--branches",
      "--remotes=origin",
    ]),
  ]);

  const headFullHash = headFullRaw?.trim() || null;
  const headSha = headFullHash ? headFullHash.slice(0, 12) : null;
  const branch = branchRaw?.trim() || null;

  const publicHashes = new Set(
    (remoteHashesRaw ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const workingTree = parseGitWorkingTreeStatus(porcelainRaw ?? "", numstatRaw ?? "");
  const smartlogCommits = parseGitSmartlogCommits(logRaw ?? "", {
    headFullHash,
    publicHashes,
  });

  return {
    isGitCheckout: true,
    branch,
    headSha,
    ...workingTree,
    smartlogCommits,
  };
}

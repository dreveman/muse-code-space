// Smartlog DAG layout and bookmark filtering, modeled after Agent Home 2.0's
// `state/DmHqSmartLogLayout.js` and `components/DmHqSmartLogGraphRail.react.js`.

export type SmartlogFile = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

export type SmartlogCommit = {
  hash: string;
  parents: string[];
  phase: "public" | "draft";
  isDot: boolean;
  title: string;
  author: string;
  date: string;
  bookmarks: string[];
  remoteBookmarks: string[];
};

export type SessionVcsStatus = {
  isGitCheckout: boolean;
  branch: string | null;
  headSha: string | null;
  uncommittedFileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  files: SmartlogFile[];
  smartlogCommits: SmartlogCommit[];
};

export type SmartlogLaneCell =
  | { type: "node"; isHead: boolean }
  | { type: "vertical" }
  | { type: "ancestor" }
  | { type: "empty" };

export type SmartlogGraphRow<T extends SmartlogCommit = SmartlogCommit> = {
  ancestorAbove: boolean;
  ancestorBelow: boolean;
  commit: T;
  converges: number[];
  joins: number[];
  lane: number;
  laneState: SmartlogLaneCell[];
  line: string;
  ownLaneBelow: boolean;
  splits: number[];
  totalLanes: number;
};

const SPINE = "\u0000spine";

const SMARTLOG_REMOTE_BOOKMARK_ALLOWLIST = new Set([
  "main",
  "master",
  "stable",
  "develop",
  "trunk",
  "origin/main",
  "origin/master",
  "origin/stable",
  "origin/develop",
  "origin/trunk",
]);

/**
 * Display-worthy bookmarks for a smartlog commit: all local bookmarks plus
 * allowlisted remote bookmarks (deduped).
 */
export function displaySmartlogBookmarks(
  commit: Pick<SmartlogCommit, "bookmarks" | "remoteBookmarks">,
): string[] {
  const remote = commit.remoteBookmarks
    .map((name) => name.replace(/^remote\//, ""))
    .filter((name) => SMARTLOG_REMOTE_BOOKMARK_ALLOWLIST.has(name) || SMARTLOG_REMOTE_BOOKMARK_ALLOWLIST.has(name.replace(/^origin\//, "")));
  return Array.from(new Set([...commit.bookmarks, ...remote]));
}

/**
 * Filter a smartlog to the viewer's render scope: public trunk commits with
 * display-worthy bookmarks, the current draft stack containing `isDot`, and
 * the public trunk ancestors the stack forks from.
 */
export function filterSmartlogForDisplay<T extends SmartlogCommit>(
  commits: readonly T[],
): T[] {
  const byHash = new Map<string, T>(commits.map((commit) => [commit.hash, commit]));
  const dot = commits.find((commit) => commit.isDot);

  const stack = new Set<string>();
  if (dot != null && dot.phase !== "public") {
    const childrenOf = new Map<string, string[]>();
    for (const commit of commits) {
      if (commit.phase === "public") continue;
      for (const parentHash of commit.parents) {
        const parent = byHash.get(parentHash);
        if (!parent || parent.phase === "public") continue;
        let children = childrenOf.get(parentHash);
        if (!children) {
          children = [];
          childrenOf.set(parentHash, children);
        }
        children.push(commit.hash);
      }
    }
    const queue: string[] = [dot.hash];
    while (queue.length > 0) {
      const hash = queue.pop();
      if (!hash || stack.has(hash)) continue;
      stack.add(hash);
      const commit = byHash.get(hash);
      if (!commit) continue;
      for (const parentHash of commit.parents) {
        const parent = byHash.get(parentHash);
        if (parent && parent.phase !== "public") {
          queue.push(parentHash);
        }
      }
      for (const child of childrenOf.get(hash) ?? []) {
        queue.push(child);
      }
    }
  }

  const trunkAncestors = new Set<string>();
  for (const hash of stack) {
    const commit = byHash.get(hash);
    if (!commit) continue;
    for (const parentHash of commit.parents) {
      const parent = byHash.get(parentHash);
      if (parent && parent.phase === "public") {
        trunkAncestors.add(parentHash);
      }
    }
  }

  const filtered = commits.filter((commit) => {
    if (commit.phase !== "public") {
      return stack.size > 0 ? stack.has(commit.hash) : true;
    }
    return (
      displaySmartlogBookmarks(commit).length > 0 ||
      trunkAncestors.has(commit.hash) ||
      commit.isDot
    );
  });

  return filtered.length > 0 ? filtered : commits.slice(0, 12);
}

function orderDraftsAboveBase<T extends SmartlogCommit>(
  commits: readonly T[],
  commitHashes: ReadonlySet<string>,
): T[] {
  const byHash = new Map<string, T>(commits.map((commit) => [commit.hash, commit]));

  function baseOf(commit: T): string | null {
    const seen = new Set<string>();
    let current = commit;
    while (!seen.has(current.hash)) {
      seen.add(current.hash);
      const parentHash = current.parents.find((parent) => commitHashes.has(parent));
      if (!parentHash) return null;
      const parent = byHash.get(parentHash);
      if (!parent) return null;
      if (parent.phase === "public") return parent.hash;
      current = parent;
    }
    return null;
  }

  const draftsByBase = new Map<string, T[]>();
  const rootedDrafts = new Set<string>();
  for (const commit of commits) {
    if (commit.phase === "public") continue;
    const base = baseOf(commit);
    if (!base) continue;
    let group = draftsByBase.get(base);
    if (!group) {
      group = [];
      draftsByBase.set(base, group);
    }
    group.push(commit);
    rootedDrafts.add(commit.hash);
  }

  const ordered: T[] = [];
  for (const commit of commits) {
    if (rootedDrafts.has(commit.hash)) continue;
    const drafts = draftsByBase.get(commit.hash);
    if (drafts) {
      for (const draft of drafts) ordered.push(draft);
    }
    ordered.push(commit);
  }
  return ordered;
}

/**
 * Compute an ISL-style 2D DAG layout for smartlog commits.
 * Lane 0 is the public spine; draft stacks allocate from lane 1 upward.
 */
export function computeSmartlogLayout<T extends SmartlogCommit>(
  commits: readonly T[],
): SmartlogGraphRow<T>[] {
  const commitHashes = new Set<string>(commits.map((commit) => commit.hash));
  const publicHashes = new Set<string>(
    commits.filter((commit) => commit.phase === "public").map((commit) => commit.hash),
  );
  const publicCount = publicHashes.size;
  const orderedCommits = orderDraftsAboveBase(commits, commitHashes);

  const activeLanes: Array<string | null> = [null];
  function findEmptyLane(): number {
    for (let i = 1; i < activeLanes.length; i++) {
      if (activeLanes[i] == null) return i;
    }
    activeLanes.push(null);
    return activeLanes.length - 1;
  }

  let publicSeen = 0;
  const rows: SmartlogGraphRow<T>[] = [];
  for (const commit of orderedCommits) {
    const isPublic = commit.phase === "public";
    const spineAbove = activeLanes[0] === SPINE;

    const incoming: number[] = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === commit.hash) incoming.push(i);
    }

    let nodeLane: number;
    if (isPublic) {
      nodeLane = 0;
      activeLanes[0] = null;
    } else {
      nodeLane = incoming.length > 0 ? incoming[0]! : findEmptyLane();
    }
    const joins = incoming.filter((lane) => lane !== nodeLane);
    for (const lane of incoming) {
      activeLanes[lane] = null;
    }

    const splits: number[] = [];
    const converges: number[] = [];
    const parentsInSet = commit.parents.filter((parent) => commitHashes.has(parent));
    for (const parent of parentsInSet) {
      const existing = activeLanes.indexOf(parent);
      if (existing >= 0 && existing !== nodeLane) {
        converges.push(existing);
        continue;
      }
      if (publicHashes.has(parent) && activeLanes[0] == null) {
        activeLanes[0] = parent;
        if (nodeLane !== 0) splits.push(0);
        continue;
      }
      if (activeLanes[nodeLane] == null) {
        activeLanes[nodeLane] = parent;
        continue;
      }
      const lane = findEmptyLane();
      activeLanes[lane] = parent;
      splits.push(lane);
    }
    const ownLaneBelow = activeLanes[nodeLane] != null;

    const ancestorAbove = isPublic && spineAbove;
    let ancestorBelow = false;
    if (isPublic) {
      publicSeen++;
      if (publicSeen < publicCount && activeLanes[0] == null) {
        activeLanes[0] = SPINE;
        ancestorBelow = true;
      }
    }

    const connectedAbove = incoming.length > 0 || ancestorAbove;
    const connectedBelow =
      ownLaneBelow || ancestorBelow || splits.length > 0 || converges.length > 0;
    let nodeChar = "x";
    if (connectedAbove && connectedBelow) nodeChar = "o";
    else if (connectedAbove) nodeChar = "^";
    else if (connectedBelow) nodeChar = "v";

    const laneState: SmartlogLaneCell[] = [];
    const lineChars: string[] = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (i === nodeLane) {
        laneState.push({ type: "node", isHead: commit.isDot });
        lineChars.push(nodeChar);
      } else if (activeLanes[i] === SPINE) {
        laneState.push({ type: "ancestor" });
        lineChars.push("|");
      } else if (activeLanes[i] != null) {
        laneState.push({ type: "vertical" });
        lineChars.push(splits.includes(i) ? " " : "|");
      } else {
        laneState.push({ type: "empty" });
        lineChars.push(" ");
      }
    }
    const line = lineChars.join("").replace(/\s+$/, "");

    rows.push({
      ancestorAbove,
      ancestorBelow,
      commit,
      converges,
      joins,
      lane: nodeLane,
      laneState,
      line,
      ownLaneBelow,
      splits,
      totalLanes: laneState.length,
    });
  }

  return rows;
}

export const SMARTLOG_CELL_WIDTH = 20;

export function smartlogLaneCenterX(lane: number): number {
  return lane * SMARTLOG_CELL_WIDTH + SMARTLOG_CELL_WIDTH / 2;
}

/** Label for the right-aligned Smart Log button in `.repo-row`: `<branch or commit-sha>`. */
export function smartlogCheckoutLabel(status: Pick<SessionVcsStatus, "isGitCheckout" | "branch" | "headSha"> | null | undefined): string | null {
  if (!status || !status.isGitCheckout) return null;
  if (status.branch && status.branch.trim()) return status.branch.trim();
  if (status.headSha && status.headSha.trim()) return status.headSha.trim().slice(0, 12);
  return "HEAD";
}

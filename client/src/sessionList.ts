// Pure helpers for the sidebar session list.
// No runtime imports: safe to load anywhere (client bundle, probes).

export type SessionListEntry = {
  id: string;
  title: string;
  prompt: string;
  session_summary?: string | null;
  latest_output: string | null;
  project_id: string | null;
};

export type SessionListProject = {
  id: string;
  name: string;
};

export type SessionGroup<T extends SessionListEntry = SessionListEntry> = {
  key: string;
  projectId: string | null;
  name: string;
  sessions: T[];
};

// Groups sessions under their projects (by name, A-Z) with unfiled sessions
// in a trailing "No Project" group. Empty groups are omitted; incoming session
// order is preserved within each group.
export function groupSessionsByProject<T extends SessionListEntry>(
  sessions: T[],
  projects: SessionListProject[],
): SessionGroup<T>[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const groups = new Map<string, SessionGroup<T>>();
  for (const session of sessions) {
    // Unknown ids (e.g. a deleted project) file under No Project.
    const projectId =
      session.project_id !== null && names.has(session.project_id) ? session.project_id : null;
    const key = projectId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        projectId,
        name: (projectId !== null && names.get(projectId)) || "No Project",
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  const filed = [...groups.values()].filter((group) => group.projectId !== null);
  filed.sort((a, b) => a.name.localeCompare(b.name));
  const unfiled = groups.get("");
  if (unfiled) filed.push(unfiled);
  return filed;
}

// Past sessions group by age of their last activity (local calendar days):
// Today (only for e.g. a session archived today), Yesterday, Earlier this
// week (2–6 days ago), then Earlier.
// Empty groups are omitted; incoming order (newest first) is preserved.
export const AGE_GROUP_PREFIX = "age:";
const AGE_BUCKETS = [
  { key: `${AGE_GROUP_PREFIX}today`, name: "Today" },
  { key: `${AGE_GROUP_PREFIX}yesterday`, name: "Yesterday" },
  { key: `${AGE_GROUP_PREFIX}week`, name: "Earlier this week" },
  { key: `${AGE_GROUP_PREFIX}earlier`, name: "Earlier" },
] as const;

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function ageBucket(updatedAt: string, nowMs: number): (typeof AGE_BUCKETS)[number]["key"] {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return AGE_BUCKETS[3].key;
  const today = startOfLocalDay(nowMs);
  // Day boundaries via Date so DST changes don't shift a bucket by an hour.
  const dayStart = (daysAgo: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() - daysAgo);
    return date.getTime();
  };
  if (at >= today) return AGE_BUCKETS[0].key;
  if (at >= dayStart(1)) return AGE_BUCKETS[1].key;
  if (at >= dayStart(6)) return AGE_BUCKETS[2].key;
  return AGE_BUCKETS[3].key;
}

export function groupSessionsByAge<T extends SessionListEntry & { updated_at: string }>(
  sessions: T[],
  nowMs: number,
): SessionGroup<T>[] {
  const buckets = new Map<string, T[]>(AGE_BUCKETS.map((bucket) => [bucket.key, []]));
  for (const session of sessions) buckets.get(ageBucket(session.updated_at, nowMs))!.push(session);
  return AGE_BUCKETS
    .map((bucket) => ({ key: bucket.key, projectId: null, name: bucket.name, sessions: buckets.get(bucket.key)! }))
    .filter((group) => group.sessions.length > 0);
}

export type SortMode = "priority" | "updated" | "created";

type SortableSession = {
  status: string;
  needs_you: boolean;
  updated_at: string;
  started_at: string;
};

function priorityRank(session: SortableSession): number {
  if (session.needs_you || session.status === "failed") return 0;
  if (session.status === "succeeded" || session.status === "stopped") return 1;
  if (session.status === "running") return 2;
  return 3; // queued/idle
}

function timestamp(value: string): number {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : -Infinity;
}

// Sort within the existing project / Past-age groups. Priority uses the
// agent's pending-question flag (or failure), then finished -> working ->
// idle; ties use the last prompt/reply time. No mutation of query data.
export function sortSessions<T extends SortableSession>(sessions: readonly T[], mode: SortMode): T[] {
  return sessions.map((session, index) => ({ session, index })).sort((a, b) => {
    if (mode === "priority") {
      const rank = priorityRank(a.session) - priorityRank(b.session);
      if (rank) return rank;
    }
    const field = mode === "created" ? "started_at" : "updated_at";
    const diff = timestamp(b.session[field]) - timestamp(a.session[field]);
    return diff || a.index - b.index;
  }).map(({ session }) => session);
}

export function sessionTaskTitle(session: Pick<SessionListEntry, "session_summary" | "prompt">): string {
  return session.session_summary?.replace(/\s+/g, " ").trim()
    || session.prompt.replace(/\s+/g, " ").trim() || "Untitled task";
}

// Case-insensitive substring match over companion name (title), task title/summary,
// first prompt, and latest output.
// A blank query matches everything.
export function matchesSessionQuery(session: SessionListEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [session.title, session.session_summary ?? "", session.prompt, session.latest_output ?? ""];
  return haystacks.some((field) => field.toLowerCase().includes(q));
}

// Resolve which session id should be selected after the session list
// changes. Filter switches and refetches never move the selection; explicit
// actions like archiving the selected agent may clear it. So:
// - a selected draft (client-local, never in the list) is kept;
// - defer (narrow mobile list view) keeps the current selection untouched;
// - a selection that still exists (in any filter) is kept, even when it
//   isn't in the visible list;
// - a selection whose session is gone (deleted) is cleared, not replaced;
// - with nothing selected, the first visible session is picked only when
//   autoPickFirst is set (the first load, so the app doesn't open empty).
export function resolveSelectedId(
  currentId: string | null,
  knownIds: string[],
  visibleIds: string[],
  opts: { draftId: string | null; defer: boolean; autoPickFirst?: boolean },
): string | null {
  if (currentId !== null && currentId === opts.draftId) return currentId;
  if (opts.defer) return currentId;
  if (currentId !== null) return knownIds.includes(currentId) ? currentId : null;
  return opts.autoPickFirst ? visibleIds[0] ?? null : null;
}

// A session is active while it is still live: never archived, with recent
// activity. Anything touched in the last 24h is definitely active; sessions
// filed under a project stay active for 72h. Inactive is the same as
// archived for now — archiving just deactivates. nowMs is a parameter so
// the result is deterministic under test.
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WINDOW_PROJECT_MS = 72 * 60 * 60 * 1000;

export type SessionActivity = {
  archived: boolean;
  updated_at: string;
  restored_at?: string | null;
  project_id: string | null;
};

export function isSessionActive(session: SessionActivity, nowMs: number): boolean {
  if (session.archived) return false;
  const lastMessage = Date.parse(session.updated_at);
  const restored = session.restored_at ? Date.parse(session.restored_at) : NaN;
  const at = Math.max(Number.isFinite(lastMessage) ? lastMessage : -Infinity,
    Number.isFinite(restored) ? restored : -Infinity);
  if (!Number.isFinite(at)) return false;
  const windowMs = session.project_id !== null ? ACTIVE_WINDOW_PROJECT_MS : ACTIVE_WINDOW_MS;
  return nowMs - at < windowMs;
}

// Compact relative age ("now", "5m", "2h", "3d"). nowMs is a parameter so
// the output is deterministic under test.
export function formatRelativeTime(value: string, nowMs: number): string {
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

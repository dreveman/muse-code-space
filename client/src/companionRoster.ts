import catalog from "../../companions/catalog.json" with { type: "json" };

export const companionDefinitions = catalog.companions;
export type CompanionDefinition = (typeof companionDefinitions)[number];

// Provisional bench: keep the first five roster entries until the default
// companions are chosen. Availability never fills their spots with others.
const defaultCompanionIds = new Set(companionDefinitions.slice(0, 5).map((companion) => companion.id));
export function isDefaultCompanion(companion: Pick<CompanionDefinition, "id">): boolean {
  return defaultCompanionIds.has(companion.id);
}

export function companionRoleTitle(role: string): string {
  const title = role.replace(/^The /, "");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

type RosterSession = { title: string; archived: boolean; updated_at: string };
const nameKey = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export function companionAssignedElsewhere(sessions: readonly (Pick<RosterSession, "title" | "archived"> & { id: string })[], name: string, taskId: string): boolean {
  return sessions.some((session) => session.id !== taskId && !session.archived && nameKey(session.title) === nameKey(name));
}

// The current runtime uses the session's canonical name as its agent identity.
// This is a presentation bridge until companion IDs have durable assignments.
// Never guess from a numbered name, a task prompt, or another session's order.
export function companionForName(name: string): CompanionDefinition | undefined {
  return companionDefinitions.find((companion) => nameKey(companion.name) === nameKey(name));
}

export function availableCompanionDefinitions(sessions: readonly RosterSession[]): CompanionDefinition[] {
  const assigned = new Set(sessions.filter((session) => !session.archived).map((session) => nameKey(session.title)));
  const lastUsed = new Map<string, number>();
  for (const session of sessions) {
    const at = Date.parse(session.updated_at);
    if (!Number.isFinite(at)) continue;
    const key = nameKey(session.title);
    lastUsed.set(key, Math.max(lastUsed.get(key) ?? -Infinity, at));
  }
  return companionDefinitions.filter((companion) => !assigned.has(nameKey(companion.name)))
    .sort((a, b) => (lastUsed.get(nameKey(b.name)) ?? 0) - (lastUsed.get(nameKey(a.name)) ?? 0));
}

export function matchesCompanionQuery(companion: CompanionDefinition, query: string): boolean {
  return [companion.name, companion.role, ...companion.skills].join(" ").toLowerCase().includes(query.trim().toLowerCase());
}

// Pure helpers for linking pairs of active conversations in Split View.

export const SPLIT_LINKS_STORAGE_KEY = "muse-code-space:linked-sessions-v1";

export type LinkedSessionPair = readonly [string, string];

export type LinkedPairMatch = {
  leftId: string;
  rightId: string;
  partnerId: string;
  slot: "left" | "right";
  partnerSlot: "left" | "right";
};

export function loadLinkedSessionPairs(): LinkedSessionPair[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SPLIT_LINKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: LinkedSessionPair[] = [];
    for (const item of parsed) {
      if (
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        typeof item[1] === "string" &&
        item[0] !== item[1] &&
        !seen.has(item[0]) &&
        !seen.has(item[1])
      ) {
        seen.add(item[0]);
        seen.add(item[1]);
        result.push([item[0], item[1]]);
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function saveLinkedSessionPairs(pairs: readonly LinkedSessionPair[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SPLIT_LINKS_STORAGE_KEY, JSON.stringify(pairs));
  } catch {
    // Storage may be unavailable in restricted webviews.
  }
}

export function linkSessionPair(
  pairs: readonly LinkedSessionPair[],
  sourceId: string,
  targetId: string | null,
): LinkedSessionPair[] {
  const filtered = pairs.filter(
    ([left, right]) =>
      left !== sourceId &&
      right !== sourceId &&
      (targetId === null || (left !== targetId && right !== targetId)),
  );
  if (targetId === null || targetId === sourceId) {
    return filtered;
  }
  return [...filtered, [sourceId, targetId]];
}

export function pruneLinkedSessionPairs(
  pairs: readonly LinkedSessionPair[],
  activeSessionIds: ReadonlySet<string>,
): readonly LinkedSessionPair[] {
  if (pairs.length === 0) return pairs;
  const next = pairs.filter(
    ([left, right]) => left !== right && activeSessionIds.has(left) && activeSessionIds.has(right),
  );
  return next.length === pairs.length ? pairs : next;
}

export function findLinkedPair(
  pairs: readonly LinkedSessionPair[],
  sessionId: string | null | undefined,
): LinkedPairMatch | null {
  if (!sessionId) return null;
  for (const [leftId, rightId] of pairs) {
    if (leftId === sessionId) {
      return { leftId, rightId, partnerId: rightId, slot: "left", partnerSlot: "right" };
    }
    if (rightId === sessionId) {
      return { leftId, rightId, partnerId: leftId, slot: "right", partnerSlot: "left" };
    }
  }
  return null;
}

// A name is an agent's visible identity. Normalize case, Unicode and spacing
// before hashing so Pip keeps the same color across workspaces and devices.
// FNV-1a plus a murmur3 finalizer spreads similar names (Pip, Pip 2) apart.
export function agentNameHue(name: string): number {
  const identity = name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i += 1) {
    hash = Math.imul((hash ^ identity.charCodeAt(i)) >>> 0, 0x01000193) >>> 0;
  }
  hash = Math.imul((hash ^ (hash >>> 16)) >>> 0, 0x85ebca6b) >>> 0;
  hash = Math.imul((hash ^ (hash >>> 13)) >>> 0, 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash % 360;
}

// Names in Muse are canonical routing identities (often lowercase); the UI
// capitalizes them without changing what agents use for message delivery.
export function displayAgentName(name: string): string {
  return name.replace(/(^|[\s_-])(\p{L})/gu, (_match, prefix: string, first: string) => prefix + first.toUpperCase());
}

type Agent = { id: string; title: string; pilot_session_id?: string | null };
type Peer = { name: string; sessionId?: string | null };

// Color the name printed on the message chip, even if that session has been
// renamed or deleted since the message was sent. Only nameless legacy rows
// need a session-ID lookup to find a usable name.
export function messagePeerHue(peer: Peer, agents: readonly Agent[]): number {
  if (peer.name.trim()) return agentNameHue(peer.name);
  const agent = agents.find((item) => peer.sessionId && item.pilot_session_id === peer.sessionId)
    ?? agents.find((item) => item.id === peer.sessionId);
  return agentNameHue(agent?.title ?? "");
}

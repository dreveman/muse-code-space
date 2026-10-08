// Pure @mention token handling for the two Code Space message composers.
// The prompt stays the user's text; Muse is instructed to route @names via
// its built-in code-space MCP tool, preserving the selected agent as sender.
export type MentionToken = { start: number; end: number; query: string };
const NAME_CHARACTERS = "[\\p{L}\\p{N}_-]";
const beforeMention = new RegExp(`(^|[\\s([{])@(${NAME_CHARACTERS}*)$`, "u");
const afterMention = new RegExp(`^${NAME_CHARACTERS}*`, "u");

export function mentionAtCursor(text: string, cursor: number): MentionToken | null {
  if (cursor < 0 || cursor > text.length) return null;
  const match = beforeMention.exec(text.slice(0, cursor));
  if (!match) return null;
  const start = cursor - match[2]!.length - 1;
  const tail = afterMention.exec(text.slice(cursor))?.[0] ?? "";
  return { start, end: cursor + tail.length, query: match[2]! };
}

export function completeMention(text: string, cursor: number, name: string): { text: string; cursor: number } | null {
  const mention = mentionAtCursor(text, cursor);
  if (!mention) return null;
  // Quoting names with spaces keeps the recipient unambiguous to Muse.
  const reference = new RegExp(`^${NAME_CHARACTERS}+$`, "u").test(name)
    ? `@${name}` : `@${JSON.stringify(name)}`;
  const after = text.slice(mention.end);
  const spacer = after.length === 0 || !/^[\s,.;:!?)}\]]/.test(after) ? " " : "";
  const inserted = reference + spacer;
  const skipExistingSpace = spacer === "" && /^[ \t]/.test(after) ? 1 : 0;
  return { text: text.slice(0, mention.start) + inserted + after, cursor: mention.start + inserted.length + skipExistingSpace };
}

export type MentionAgent = { name: string; session_id: string; busy: boolean; assistant?: boolean };
export type MentionSender = { id: string | null; pilotId: string | null; name: string | null };

export function matchingAgents(agents: readonly MentionAgent[], query: string, sender: MentionSender): MentionAgent[] {
  const q = query.toLocaleLowerCase();
  const senderName = sender.name?.trim().toLocaleLowerCase()
    ?? agents.find((agent) => agent.session_id === sender.id || agent.session_id === sender.pilotId)?.name.toLocaleLowerCase();
  const seen = new Set<string>();
  return agents.filter((agent) => {
    const key = agent.name.toLocaleLowerCase();
    if (!agent.assistant && (agent.session_id === sender.id || agent.session_id === sender.pilotId || key === senderName)) return false;
    if (seen.has(key) || !key.startsWith(q)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);
}

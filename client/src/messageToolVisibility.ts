// An outgoing Code Space message is recorded both as an MCP toolCall and as
// a durable agent_message row on the sender. Keep the To row as the canonical
// presentation; hide only a matching successful/in-progress tool row. When a
// send fails or the message event is missing, the tool row remains visible.
type Event = {
  id: number;
  kind: string;
  content: string;
  created_at: string;
  tool_details?: { tool: string | null; status: string | null; args: string | null; output: string | null; failureReason: string | null } | null;
};
type Outgoing = { id: number; at: number; text: string; to: { kind: string; name: string; sessionId?: string | null } };

function outgoing(event: Event): Outgoing | null {
  if (event.kind !== "message" || event.content.length > 150_000) return null;
  try {
    const value: unknown = JSON.parse(event.content);
    if (!value || typeof value !== "object") return null;
    const row = value as { direction?: unknown; text?: unknown; to?: { kind?: unknown; name?: unknown; sessionId?: unknown } };
    if (row.direction !== "out" || typeof row.text !== "string" || typeof row.to?.kind !== "string" || typeof row.to.name !== "string") return null;
    return { id: event.id, at: Date.parse(event.created_at), text: row.text, to: {
      kind: row.to.kind, name: row.to.name, sessionId: typeof row.to.sessionId === "string" ? row.to.sessionId : null,
    } };
  } catch { return null; }
}
function recipientMatches(requested: string, message: Outgoing): boolean {
  const to = requested.trim().replace(/^@/, "").toLocaleLowerCase();
  if (message.to.kind === "muse" && (to === "muse" || to === "jolly")) return true;
  return to === message.to.name.toLocaleLowerCase() || to === message.to.sessionId?.toLocaleLowerCase();
}

export function redundantSendToolIds(events: readonly Event[]): ReadonlySet<number> {
  const sent = events.map(outgoing).filter((row): row is Outgoing => row !== null).sort((a, b) => a.id - b.id);
  const used = new Set<number>();
  const hidden = new Set<number>();
  for (const event of events) {
    const tool = event.tool_details;
    if (event.kind !== "tool" || tool?.tool !== "mcp__code_space__send_message" ||
        (tool.status !== "inProgress" && tool.status !== "completed") || tool.failureReason ||
        /^Not delivered:/i.test(tool.output?.trim() ?? "") || !tool.args || tool.args.length > 150_000) continue;
    let args: { to?: unknown; text?: unknown };
    try { args = JSON.parse(tool.args); } catch { continue; }
    if (!args || typeof args !== "object" || typeof args.to !== "string" || typeof args.text !== "string" || !args.text.trim()) continue;
    const text = args.text.trim(), recipient = args.to;
    const started = Date.parse(event.created_at);
    const match = sent.find((row) => row.id > event.id && !used.has(row.id) && row.text === text &&
      recipientMatches(recipient, row) && Number.isFinite(started) && Number.isFinite(row.at) &&
      row.at >= started - 5000 && row.at - started <= 120_000);
    if (match) { used.add(match.id); hidden.add(event.id); }
  }
  return hidden;
}

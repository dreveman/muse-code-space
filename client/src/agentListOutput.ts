// Parse only the Code Space list_agents text format. Older transcripts used
// "muse — Jolly, the user's Muse assistant"; display the avatar name there
// too. Anything unfamiliar falls back to the existing raw tool transcript.
export type ListedAgent = { name: string; busy: boolean; assistant: boolean };
export type AgentListOutput = { self: string; agents: ListedAgent[] };

export function parseAgentListOutput(output: string | null): AgentListOutput | null {
  if (!output || output.length > 20_000) return null;
  const rows = output.replace(/\r\n/g, "\n").trim().split("\n");
  const self = /^You are "([^"\n]+)"\. You can message:$/.exec(rows.shift() ?? "")?.[1];
  if (!self || self.length > 100 || /[\x00-\x1f\x7f]/.test(self)) return null;
  const agents: ListedAgent[] = [];
  for (const row of rows) {
    if (!row.startsWith("- ")) return null;
    const entry = row.slice(2).trim();
    const legacyAssistant = /^muse — (.+), the user's Muse assistant$/.exec(entry);
    const assistant = /^(.+) — your Muse assistant$/.exec(entry);
    const name = legacyAssistant?.[1] ?? assistant?.[1] ?? entry.replace(/ \(busy\)$/, "");
    if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) return null;
    agents.push({ name, assistant: !!legacyAssistant || !!assistant, busy: !assistant && !legacyAssistant && entry.endsWith(" (busy)") });
  }
  return agents.length ? { self, agents } : null;
}

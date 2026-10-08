// Names for new agents: Pip first, then short friendly names in the same
// spirit. "Jolly" (the default Muse avatar) and "Muse" are reserved for the
// user's Muse assistant — agents can never take them. The name is
// the agent's identity in Muse Code too (session/rename), and what other
// agents use to address it in agent-to-agent messages, so it must be unique.
// Edit freely; order is the order they're handed out.
export const AGENT_NAMES = [
  "Pip", "Juno", "Milo", "Nova", "Ziggy", "Bea", "Kit",
  "Remy", "Luna", "Otto", "Iris", "Finn", "Echo", "Poppy", "Sage",
  "Bo", "Lumi", "Rio", "Tilly", "Wren", "Dot", "Kai", "Mochi", "Ember",
] as const;

/** Reserved for the user's Muse assistant (compared case-insensitively). */
export const RESERVED_AGENT_NAMES = ["muse", "jolly"] as const;

export function isReservedAgentName(name: string): boolean {
  return (RESERVED_AGENT_NAMES as readonly string[]).includes(name.trim().replace(/^@/, "").toLowerCase());
}

/**
 * The first name not taken by an existing agent (any filter, archived too;
 * compared case-insensitively since Muse may normalize case). Once all are
 * taken, numbered: "Pip 2", "Juno 2", … then "Pip 3", …
 */
export function pickAgentName(taken: Iterable<string>): string {
  const used = new Set([...[...taken].map((name) => name.trim().toLowerCase()), ...RESERVED_AGENT_NAMES]);
  for (let round = 1; ; round += 1) {
    for (const base of AGENT_NAMES) {
      const name = round === 1 ? base : `${base} ${round}`;
      if (!used.has(name.toLowerCase())) return name;
    }
  }
}

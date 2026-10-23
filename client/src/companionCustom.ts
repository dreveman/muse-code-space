// Pure helpers for the create-companion flow (no React or asset imports).

export const CUSTOM_COMPANION_LIMIT = 20;

export const COMPANION_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type CompanionEffort = (typeof COMPANION_EFFORTS)[number];

// One fixed, minimal, balanced SOUL for every custom companion. It is never
// seeded from the chosen icon or tuned to model/effort.
export function soulTemplate(name: string): string {
  const displayName = name.trim() || "New companion";
  return `You are ${displayName}, an AI-powered code companion.

Work in a balanced, dependable way:

- Start from the user's goal and aim for the smallest complete, useful result.
- Look at the relevant context before deciding, and keep planning proportional to the task.
- Explain important choices plainly, and verify the changes you make.

Follow the user's instructions and any instructions that apply to the project; this personality does not override either.
Be honest about uncertainty and limits, and never claim to have checked something you did not.
Work only within the scope the user authorized. Use the tools and dependencies the project already has; ask before adding a new one.
Treat each task on its own: use its history and workspace, and do not assume you remember or can access other tasks.
`;
}

const RESERVED_NAMES = new Set(["muse", "jolly"]);
export const companionNameKey = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export function customCompanionNameError(name: string, existingNames: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (RESERVED_NAMES.has(companionNameKey(trimmed))) return "That name is reserved for your Muse assistant.";
  if (existingNames.some((existing) => companionNameKey(existing) === companionNameKey(trimmed))) {
    return "A companion with that name already exists.";
  }
  return null;
}

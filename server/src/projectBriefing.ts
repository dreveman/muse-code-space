// Pure helper: project catch-up briefing prepended to a new session's prompt.
// No runtime imports: safe to load anywhere (server actions, probes, tests).

export type BriefingReference = {
  label: string;
  target: string;
};

export type BriefingProject = {
  name: string;
  description: string;
  references: BriefingReference[];
};

// Builds the context block for a session filed under a project, or null when
// the project carries nothing worth briefing (no description, no references).
export function buildProjectBriefing(project: BriefingProject): string | null {
  const description = project.description.trim();
  const references = project.references
    .map((ref) => ({ label: ref.label.trim(), target: ref.target.trim() }))
    .filter((ref) => ref.label !== "" && ref.target !== "");
  if (description === "" && references.length === 0) return null;
  const lines = [`[Project: ${project.name.trim()}]`];
  if (description !== "") lines.push(description);
  if (references.length > 0) {
    lines.push("References:");
    for (const ref of references) lines.push(`- ${ref.label}: ${ref.target}`);
  }
  return lines.join("\n");
}

// Prepends the briefing to a session prompt. Pure string join, exported for tests.
export function withProjectBriefing(prompt: string, briefing: string | null): string {
  if (briefing === null) return prompt;
  return `${briefing}\n\n---\n\n${prompt}`;
}

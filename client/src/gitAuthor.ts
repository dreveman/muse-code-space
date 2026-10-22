// Per-checkout commit author draft state (composer, alongside the repo
// pick). Both fields blank means "use the global identity"; a half-filled
// pair is invalid and must block session creation rather than guess.
export type GitAuthor = { name: string; email: string };

export function gitAuthorOverride(name: string, email: string): GitAuthor | null | "invalid" {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedName && !trimmedEmail) return null;
  if (!trimmedName || trimmedName.length > 100 || /[\x00-\x1f\x7f<>]/.test(trimmedName)) return "invalid";
  if (!trimmedEmail || trimmedEmail.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) return "invalid";
  return { name: trimmedName, email: trimmedEmail };
}

export function formatGitAuthor(author: GitAuthor): string {
  return `${author.name} <${author.email}>`;
}

/** Parse a directly-edited "Name <email>" author line. Blank means use the global identity. */
export function parseGitAuthorText(text: string): GitAuthor | null | "invalid" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^(.+?)\s*<([^<>]+)>$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return "invalid";
  return gitAuthorOverride(match[1], match[2].trim());
}

/** True when the draft pair differs from the global identity (Save as global is meaningful). */
export function gitAuthorDiffersFromGlobal(name: string, email: string, global: GitAuthor | null): boolean {
  const override = gitAuthorOverride(name, email);
  if (override === null || override === "invalid") return false;
  return !global || global.name !== override.name || global.email !== override.email;
}

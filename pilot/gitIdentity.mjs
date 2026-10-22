// Global git commit identity (user.name / user.email) for Code Space
// sessions. The identity lives in its own small JSON file in the pilot
// runtime dir — the generated session gitconfig is rebuilt by install.sh,
// so it can never be the source of truth. The pilot merges the identity
// into that gitconfig's [user] section (see pilot.mjs startup + the
// /git-identity routes); a [user] section set by hand (e.g. `git config
// --global` in a session terminal, which writes the generated gitconfig)
// is preserved whenever no identity file overrides it.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const EMAIL = /^[^\s@<>()[\]\\.,;:"']+@[^\s@<>()[\]\\.,;:"']+\.[^\s@<>()[\]\\.,;:"']+$/;

/** Validate + normalize a { name, email } pair; null when unusable. */
export function parseGitIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  if (!name || name.length > 100 || /[\x00-\x1f\x7f<>]/.test(name)) return null;
  if (!email || email.length > 200 || !EMAIL.test(email)) return null;
  return { name, email };
}

export function readGitIdentityFile(path) {
  try {
    if (!existsSync(path)) return null;
    return parseGitIdentity(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeGitIdentityFile(path, identity) {
  if (identity === null) {
    try { rmSync(path, { force: true }); } catch { /* already gone */ }
    return;
  }
  const parsed = parseGitIdentity(identity);
  if (!parsed) throw new Error("Invalid git identity.");
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o644 });
}

// The generated gitconfig's sections we must never disturb (broker URL
// rewrite, credential helper) are preserved verbatim: merging only ever
// rewrites the [user] section, located by its header line.
function splitUserSection(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*\[user\]\s*$/.test(line));
  if (start === -1) return { before: text, user: null, after: "" };
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return {
    before: lines.slice(0, start).join("\n"),
    user: lines.slice(start, end).join("\n"),
    after: lines.slice(end).join("\n"),
  };
}

/** Read the [user] identity from gitconfig text; null when absent/invalid. */
export function readGitconfigIdentity(text) {
  if (typeof text !== "string") return null;
  const { user } = splitUserSection(text);
  if (!user) return null;
  const fields = {};
  for (const line of user.split("\n").slice(1)) {
    const match = /^\s*(name|email)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return parseGitIdentity(fields);
}

/**
 * Return gitconfig text with the [user] section set to `identity`.
 * With identity null the existing section is preserved (terminal edits
 * survive regeneration); pass { clear: true } to remove it explicitly.
 */
export function mergeGitIdentityIntoGitconfig(text, identity, { clear = false } = {}) {
  const source = typeof text === "string" ? text : "";
  if (!identity && !clear) return source;
  const { before, after } = splitUserSection(source);
  const head = before ? `${before.replace(/\n*$/, "")}\n` : "";
  const tail = after ? `${after.replace(/^\n*/, "")}` : "";
  if (!identity) return `${head}${tail}`;
  const parsed = parseGitIdentity(identity);
  if (!parsed) return source;
  return `${head}[user]\n\tname = ${parsed.name}\n\temail = ${parsed.email}\n${tail}`;
}

// Exact, conservative filename mapping shared by tool previews and file tabs.
// An unknown extension is plain text; never infer a grammar from file contents.
export type CodeLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "json" | "css" | "html" | "python" | "rust" | "sql" | "shellscript";
const EXTENSIONS: Record<string, CodeLanguage> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  mts: "typescript", cts: "typescript", json: "json", css: "css", html: "html", htm: "html",
  py: "python", rs: "rust", sql: "sql", sh: "shellscript", bash: "shellscript",
};
// Markdown fence info strings (```bash, ```ts, ...). Same conservative
// rule as extensions: only names on this list highlight; anything else
// (text, markdown, c++, made-up tags) renders as a plain code block.
const FENCE_TAGS: Record<string, CodeLanguage> = {
  typescript: "typescript", ts: "typescript", tsx: "tsx",
  javascript: "javascript", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", json: "json", css: "css", html: "html", htm: "html",
  python: "python", py: "python", rust: "rust", rs: "rust", sql: "sql",
  shellscript: "shellscript", shell: "shellscript", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
};
// Opening-fence detection for the Markdown renderer. The info string is
// any run of non-space, non-backtick characters (`made-up-lang`, `c++`,
// `python3`): whether it names a supported language is codeLanguageForTag's
// call, but a fence with an unknown tag is still a code block and must be
// consumed up to its closing fence, not rendered as paragraphs. Returns
// the tag ("" for an untagged fence), or undefined when the line is not an
// opening fence at all.
export function fenceTagForLine(line: string): string | undefined {
  const match = /^```([^\s`]*)\s*$/.exec(line.trim());
  return match ? match[1] ?? "" : undefined;
}

export function codeLanguageForTag(tag: string | null | undefined): CodeLanguage | null {
  if (!tag || /[\x00-\x1f\x7f\s]/.test(tag)) return null;
  return FENCE_TAGS[tag.toLowerCase()] ?? null;
}

export function codeLanguageForPath(path: string | null | undefined): CodeLanguage | null {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) return null;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

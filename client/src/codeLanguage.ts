// Exact, conservative filename mapping shared by tool previews and file tabs.
// An unknown extension is plain text; never infer a grammar from file contents.
export type CodeLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "json" | "css" | "html" | "python" | "rust" | "sql" | "shellscript";
const EXTENSIONS: Record<string, CodeLanguage> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  mts: "typescript", cts: "typescript", json: "json", css: "css", html: "html", htm: "html",
  py: "python", rs: "rust", sql: "sql", sh: "shellscript", bash: "shellscript",
};
export function codeLanguageForPath(path: string | null | undefined): CodeLanguage | null {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) return null;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

import { codeLanguageForPath, type CodeLanguage } from "./codeLanguage.ts";
export type HighlightToken = { text: string; color: string | null };
export type HighlightLines = HighlightToken[][];
export type CodeTheme = "light" | "dark";
const MAX_HIGHLIGHT_BYTES = 128 * 1024;
const MAX_HIGHLIGHT_LINES = 2500;
const languages: Record<CodeLanguage, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"), tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"), jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"), css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"), python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"), sql: () => import("shiki/langs/sql.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
};

let highlighterPromise: Promise<Awaited<ReturnType<typeof import("shiki/core")["createHighlighterCore"]>>> | null = null;
function highlighter() {
  highlighterPromise ??= Promise.all([import("shiki/core"), import("shiki/engine/oniguruma")]).then(async ([core, engine]) =>
    core.createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
      engine: engine.createOnigurumaEngine(import("shiki/wasm")),
    }),
  ).catch((error: unknown) => { highlighterPromise = null; throw error; });
  return highlighterPromise;
}
const loadingLanguages = new Map<CodeLanguage, Promise<void>>();
async function loadLanguage(lang: CodeLanguage) {
  const h = await highlighter();
  if (h.getLoadedLanguages().includes(lang)) return h;
  let pending = loadingLanguages.get(lang);
  if (!pending) {
    pending = languages[lang]().then(async (grammar) => { await h.loadLanguage(grammar as Parameters<typeof h.loadLanguage>[0]); });
    loadingLanguages.set(lang, pending);
  }
  try { await pending; } catch { loadingLanguages.delete(lang); throw new Error("Grammar unavailable"); }
  return h;
}

// Null means plain text: no known filename, oversized/partial view, grammar
// unavailable, or any token mismatch. The source text is never rewritten.
export async function highlightCode(text: string, path: string | null, theme: CodeTheme): Promise<HighlightLines | null> {
  const lang = codeLanguageForPath(path);
  if (!lang || new TextEncoder().encode(text).length > MAX_HIGHLIGHT_BYTES || text.split("\n").length > MAX_HIGHLIGHT_LINES) return null;
  try {
    const h = await loadLanguage(lang);
    const result = h.codeToTokens(text, { lang, theme: theme === "dark" ? "github-dark" : "github-light" });
    const tokens = result.tokens.map((line) => line.map((token) => ({ text: token.content, color: token.color ?? null })));
    // Shiki may normalize final newlines or unsupported input; never render a
    // token stream if it doesn't reconstruct exactly what the user can copy.
    if (tokens.map((line) => line.map((token) => token.text).join("")).join("\n") !== text) return null;
    return tokens;
  } catch { return null; }
}

import { codeLanguageForPath, type CodeLanguage } from "./codeLanguage.ts";
export type HighlightToken = { text: string; color: string | null };
export type HighlightLines = HighlightToken[][];
export type CodeTheme = "light" | "dark";
const MAX_HIGHLIGHT_BYTES = 128 * 1024;
const MAX_HIGHLIGHT_LINES = 2500;
const MAX_CACHE_ENTRIES = 128;
const highlightCache = new Map<string, HighlightLines | null>();
const inflightHighlights = new Map<string, Promise<HighlightLines | null>>();

function cacheKey(text: string, lang: CodeLanguage, theme: CodeTheme): string {
  return `${theme}:${lang}:${text}`;
}

function setCached(key: string, value: HighlightLines | null) {
  if (highlightCache.has(key)) highlightCache.delete(key);
  else if (highlightCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  highlightCache.set(key, value);
}

export function getCachedHighlight(text: string, path: string | null, theme: CodeTheme): HighlightLines | null | undefined {
  const lang = codeLanguageForPath(path);
  if (!lang) return null;
  return highlightCache.get(cacheKey(text, lang, theme));
}

export function getCachedHighlightForLanguage(text: string, lang: CodeLanguage | null, theme: CodeTheme): HighlightLines | null | undefined {
  if (!lang) return null;
  return highlightCache.get(cacheKey(text, lang, theme));
}

const languages: Record<CodeLanguage, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"), tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"), jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"), css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"), python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"), sql: () => import("shiki/langs/sql.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
};

type Highlighter = Awaited<ReturnType<typeof import("shiki/core")["createHighlighterCore"]>>;
let highlighterPromise: Promise<Highlighter> | null = null;
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
// The Oniguruma engine compiles a Wasm module, which a host CSP without
// 'wasm-unsafe-eval' refuses — silently leaving every file plain. The
// JavaScript regex engine needs no Wasm, so it is the fallback whenever
// the primary highlighter or grammar load fails.
let fallbackPromise: Promise<Highlighter> | null = null;
function fallbackHighlighter() {
  fallbackPromise ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(async ([core, engine]) =>
    core.createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
      engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
    }),
  ).catch((error: unknown) => { fallbackPromise = null; throw error; });
  return fallbackPromise;
}
const loadingLanguages = new Map<CodeLanguage, Promise<void>>();
async function loadInto(h: Highlighter, lang: CodeLanguage, registry: Map<CodeLanguage, Promise<void>>) {
  if (h.getLoadedLanguages().includes(lang)) return;
  let pending = registry.get(lang);
  if (!pending) {
    pending = languages[lang]().then(async (grammar) => { await h.loadLanguage(grammar as Parameters<typeof h.loadLanguage>[0]); });
    registry.set(lang, pending);
  }
  try { await pending; } catch { registry.delete(lang); throw new Error("Grammar unavailable"); }
}
const loadingFallbackLanguages = new Map<CodeLanguage, Promise<void>>();
async function loadLanguage(lang: CodeLanguage) {
  try {
    const h = await highlighter();
    await loadInto(h, lang, loadingLanguages);
    return h;
  } catch {
    const h = await fallbackHighlighter();
    await loadInto(h, lang, loadingFallbackLanguages);
    return h;
  }
}

// Serialize uncached tokenization across macrotasks so multiple cold-start
// Oniguruma grammar compilations never merge into one long microtask.
let tokenizeChain: Promise<void> = Promise.resolve();
function enqueueTokenize<T>(work: () => Promise<T>): Promise<T> {
  const next = tokenizeChain.then(
    () => new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        work().then(resolve, reject);
      }, 0);
    }),
  );
  tokenizeChain = next.then(() => undefined, () => undefined);
  return next;
}

// Null means plain text: no known filename, oversized/partial view, grammar
// unavailable, or any token mismatch. The source text is never rewritten.
// Path-based entry point; Markdown fences use highlightCodeForLanguage.
export async function highlightCode(text: string, path: string | null, theme: CodeTheme): Promise<HighlightLines | null> {
  return highlightCodeForLanguage(text, codeLanguageForPath(path), theme);
}

export async function highlightCodeForLanguage(text: string, lang: CodeLanguage | null, theme: CodeTheme): Promise<HighlightLines | null> {
  if (!lang || (text.length * 3 > MAX_HIGHLIGHT_BYTES && new TextEncoder().encode(text).length > MAX_HIGHLIGHT_BYTES) || text.split("\n").length > MAX_HIGHLIGHT_LINES) return null;
  const key = cacheKey(text, lang, theme);
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  const existing = inflightHighlights.get(key);
  if (existing) return existing;
  const pending = enqueueTokenize(async () => {
    try {
      // Second attempt is the no-Wasm fallback highlighter; loadLanguage
      // already falls back on load failure, but a Wasm refusal can also
      // surface only when the engine first tokenizes.
      const attempts = [
        () => loadLanguage(lang),
        async () => {
          const h = await fallbackHighlighter();
          await loadInto(h, lang, loadingFallbackLanguages);
          return h;
        },
      ];
      for (const attempt of attempts) {
        try {
          const h = await attempt();
          const result = h.codeToTokens(text, { lang, theme: theme === "dark" ? "github-dark" : "github-light" });
          const tokens = result.tokens.map((line) => line.map((token) => ({ text: token.content, color: token.color ?? null })));
          // Shiki may normalize final newlines or unsupported input; never render a
          // token stream if it doesn't reconstruct exactly what the user can copy.
          const valid = tokens.map((line) => line.map((token) => token.text).join("")).join("\n") === text ? tokens : null;
          setCached(key, valid);
          return valid;
        } catch {
          // Try the next engine.
        }
      }
      return null;
    } finally {
      inflightHighlights.delete(key);
    }
  });
  inflightHighlights.set(key, pending);
  return pending;
}

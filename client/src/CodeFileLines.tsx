import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getCachedHighlight, highlightCode, type HighlightLines, type CodeTheme } from "./codeHighlight";
import { codeLanguageForPath } from "./codeLanguage";
import { copyCodeSelection } from "./codeSelection";
export type CodeLine = { number: number; text: string };

type IntersectionCallback = (isIntersecting: boolean) => void;
const DOCUMENT_ROOT = {} as object;
const sharedObservers = new WeakMap<object, Map<string, { observer: IntersectionObserver; targets: Map<Element, Set<IntersectionCallback>> }>>();

export function observeElementIntersection(
  element: Element,
  root: Element | null,
  rootMargin: string,
  callback: IntersectionCallback,
): () => void {
  const rootKey: object = root ?? DOCUMENT_ROOT;
  let byMargin = sharedObservers.get(rootKey);
  if (!byMargin) {
    byMargin = new Map();
    sharedObservers.set(rootKey, byMargin);
  }
  let pool = byMargin.get(rootMargin);
  if (!pool) {
    const targets = new Map<Element, Set<IntersectionCallback>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const listeners = targets.get(entry.target);
          if (!listeners) continue;
          for (const fn of [...listeners]) fn(entry.isIntersecting);
        }
      },
      { root, rootMargin },
    );
    pool = { observer, targets };
    byMargin.set(rootMargin, pool);
  }
  const activePool = pool;
  const activeMarginMap = byMargin;
  let listeners = activePool.targets.get(element);
  if (!listeners) {
    listeners = new Set();
    activePool.targets.set(element, listeners);
    activePool.observer.observe(element);
  }
  listeners.add(callback);
  return () => {
    const set = activePool.targets.get(element);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) {
      activePool.targets.delete(element);
      activePool.observer.unobserve(element);
      if (activePool.targets.size === 0) {
        activePool.observer.disconnect();
        activeMarginMap.delete(rootMargin);
      }
    }
  };
}

const themeListeners = new Set<(theme: CodeTheme) => void>();
let sharedThemeObserver: MutationObserver | null = null;
function readDocumentTheme(): CodeTheme {
  return typeof document !== "undefined" && document.documentElement.dataset.colorMode === "dark" ? "dark" : "light";
}
function subscribeTheme(listener: (theme: CodeTheme) => void): () => void {
  themeListeners.add(listener);
  if (!sharedThemeObserver && typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    sharedThemeObserver = new MutationObserver(() => {
      const next = readDocumentTheme();
      for (const fn of themeListeners) fn(next);
    });
    sharedThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size === 0 && sharedThemeObserver) {
      sharedThemeObserver.disconnect();
      sharedThemeObserver = null;
    }
  };
}

export function useResolvedTheme(): CodeTheme {
  const [theme, setTheme] = useState(readDocumentTheme);
  useEffect(() => subscribeTheme(setTheme), []);
  return theme;
}

// Both historical read/write rows and current file tabs use this exact view.
// Incomplete/ranged content is plain: tokenizers cannot know a multiline
// comment/string's state when the beginning of the file is missing.
export const CodeFileLines = memo(function CodeFileLines({ lines, path, complete, tab = false }: { lines: CodeLine[]; path: string | null; complete: boolean; tab?: boolean }) {
  const theme = useResolvedTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(() => tab || typeof IntersectionObserver === "undefined");
  const source = useMemo(() => lines.map((line) => line.text).join("\n"), [lines]);
  const eligible = complete && lines[0]?.number === 1 && lines.every((line, index) => line.number === index + 1) && codeLanguageForPath(path) !== null;
  const cachedTokens = eligible ? getCachedHighlight(source, path, theme) : null;
  const [highlighted, setHighlighted] = useState<{ source: string; path: string | null; theme: CodeTheme; lines: HighlightLines } | null>(null);
  const tokens = eligible
    ? cachedTokens ?? (highlighted?.source === source && highlighted.path === path && highlighted.theme === theme ? highlighted.lines : null)
    : null;
  useEffect(() => {
    if (!eligible || inView || cachedTokens !== undefined) return;
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setInView(true); return; }
    let timer: number | null = null;
    let stop: (() => void) | undefined;
    stop = observeElementIntersection(el, el.closest(".terminal-body"), "160px", (intersecting) => {
      if (intersecting) {
        if (timer === null) {
          timer = window.setTimeout(() => {
            timer = null;
            setInView(true);
            stop?.();
          }, 120);
        }
      } else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      stop?.();
    };
  }, [eligible, inView, cachedTokens]);
  useEffect(() => {
    if (!eligible || !inView || cachedTokens !== undefined) return;
    let cancelled = false;
    void highlightCode(source, path, theme).then((result) => {
      if (!cancelled) setHighlighted(result ? { source, path, theme, lines: result } : null);
    });
    return () => { cancelled = true; };
  }, [eligible, inView, cachedTokens, source, path, theme]);
  const digits = useMemo(() => lines.reduce((widest, line) => Math.max(widest, String(line.number).length), 1), [lines]);
  return (
    <div ref={containerRef} className={`tool-diff tool-file-view${tab ? " file-tab-content" : ""}`} role="region" aria-label={tab ? "File contents" : "Tool file contents"} tabIndex={0} onCopy={copyCodeSelection} style={{ "--file-gutter-width": `${digits}ch` } as CSSProperties}>
      {lines.map((line, index) => (
        <div key={line.number} className="tool-file-line">
          <span className="tool-file-number">{line.number}</span>
          <span className="tool-file-code">{tokens?.[index]?.map((token, part) => <span key={part} style={token.color ? { color: token.color } : undefined}>{token.text}</span>) ?? line.text}</span>
        </div>
      ))}
    </div>
  );
});

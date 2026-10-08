import { useEffect, useState, type CSSProperties } from "react";
import { highlightCode, type HighlightLines, type CodeTheme } from "./codeHighlight";
import { codeLanguageForPath } from "./codeLanguage";
import { copyCodeSelection } from "./codeSelection";
export type CodeLine = { number: number; text: string };

function useResolvedTheme(): CodeTheme {
  const read = (): CodeTheme => document.documentElement.dataset.colorMode === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// Both historical read/write rows and current file tabs use this exact view.
// Incomplete/ranged content is plain: tokenizers cannot know a multiline
// comment/string's state when the beginning of the file is missing.
export function CodeFileLines({ lines, path, complete, tab = false }: { lines: CodeLine[]; path: string | null; complete: boolean; tab?: boolean }) {
  const theme = useResolvedTheme();
  const [highlighted, setHighlighted] = useState<{ source: string; path: string | null; theme: CodeTheme; lines: HighlightLines } | null>(null);
  const source = lines.map((line) => line.text).join("\n");
  const eligible = complete && lines[0]?.number === 1 && lines.every((line, index) => line.number === index + 1) && codeLanguageForPath(path) !== null;
  const tokens = eligible && highlighted?.source === source && highlighted.path === path && highlighted.theme === theme ? highlighted.lines : null;
  useEffect(() => {
    let cancelled = false;
    setHighlighted(null);
    if (eligible) void highlightCode(source, path, theme).then((result) => {
      if (!cancelled) setHighlighted(result ? { source, path, theme, lines: result } : null);
    });
    return () => { cancelled = true; };
  }, [eligible, source, path, theme]);
  const digits = lines.reduce((widest, line) => Math.max(widest, String(line.number).length), 1);
  return (
    <div className={`tool-diff tool-file-view${tab ? " file-tab-content" : ""}`} role="region" aria-label={tab ? "File contents" : "Tool file contents"} tabIndex={0} onCopy={copyCodeSelection} style={{ "--file-gutter-width": `${digits}ch` } as CSSProperties}>
      {lines.map((line, index) => (
        <div key={line.number} className="tool-file-line">
          <span className="tool-file-number">{line.number}</span>
          <span className="tool-file-code">{tokens?.[index]?.map((token, part) => <span key={part} style={token.color ? { color: token.color } : undefined}>{token.text}</span>) ?? line.text}</span>
        </div>
      ))}
    </div>
  );
}

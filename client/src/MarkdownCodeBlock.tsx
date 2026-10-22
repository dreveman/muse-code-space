import { memo, useEffect, useState } from "react";
import { getCachedHighlightForLanguage, highlightCodeForLanguage, type HighlightLines } from "./codeHighlight";
import { codeLanguageForTag } from "./codeLanguage";
import { useResolvedTheme } from "./CodeFileLines";

// One fenced code block from an agent/user Markdown message. A recognised
// language tag (```bash, ```ts, ...) highlights with the same Shiki
// pipeline as file views; an unknown or missing tag — and any highlight
// failure — keeps the exact plain block. Highlighting swaps in only when
// the token stream reconstructs the source exactly (enforced in
// codeHighlight), so the copyable text never changes.
export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({ code, languageTag }: { code: string; languageTag: string | null }) {
  const theme = useResolvedTheme();
  const lang = codeLanguageForTag(languageTag);
  const cachedTokens = lang ? getCachedHighlightForLanguage(code, lang, theme) : null;
  const [highlighted, setHighlighted] = useState<{ code: string; lang: string; theme: string; lines: HighlightLines } | null>(null);
  const tokens = lang
    ? cachedTokens ?? (highlighted?.code === code && highlighted.lang === lang && highlighted.theme === theme ? highlighted.lines : null)
    : null;

  useEffect(() => {
    if (!lang || cachedTokens !== undefined) return;
    let cancelled = false;
    void highlightCodeForLanguage(code, lang, theme).then((result) => {
      if (!cancelled && result) setHighlighted({ code, lang, theme, lines: result });
    });
    return () => { cancelled = true; };
  }, [code, lang, theme, cachedTokens]);

  if (!tokens) {
    return <pre data-language={languageTag ?? undefined}><code>{code}</code></pre>;
  }
  return (
    <pre data-language={languageTag ?? undefined}>
      <code>
        {tokens.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 ? "\n" : null}
            {line.map((token, part) => (
              <span key={part} style={token.color ? { color: token.color } : undefined}>{token.text}</span>
            ))}
          </span>
        ))}
      </code>
    </pre>
  );
});

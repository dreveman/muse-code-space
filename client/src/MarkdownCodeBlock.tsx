import { memo, useEffect, useRef, useState } from "react";
import { getCachedHighlightForLanguage, highlightCodeForLanguage, type HighlightLines } from "./codeHighlight";
import { codeLanguageForTag } from "./codeLanguage";
import { useResolvedTheme } from "./CodeFileLines";
import { copyTextToClipboard } from "./clipboard";

// Same artwork as the repo dialog's CopyButtonIcon/CopiedCheckIcon
// (RepoPicker.tsx) so every copy button in the app looks identical.
function CopyCodeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16" color="currentColor" aria-hidden="true">
      <path d="M14.238 4.333a.764.764 0 0 0-.762.762v6.095a3.047 3.047 0 0 1-3.048 3.048H6.62a.764.764 0 0 0-.762.762c0 .419.343.761.762.761h3.81a4.575 4.575 0 0 0 4.57-4.57V5.094a.764.764 0 0 0-.761-.762z" />
      <path d="M11.952 10.81V2.427A1.905 1.905 0 0 0 10.047.523H3.19a1.905 1.905 0 0 0-1.904 1.905v8.381c0 1.052.853 1.905 1.904 1.905h6.857a1.905 1.905 0 0 0 1.905-1.905zm-9.143 0V2.427c0-.213.168-.38.381-.38h6.857c.214 0 .381.167.381.38v8.381c0 .214-.167.381-.38.381H3.19a.377.377 0 0 1-.38-.38z" />
      <path d="M8.143 3.571H5.095a.764.764 0 0 0-.762.762c0 .419.343.762.762.762h3.048c.419 0 .762-.343.762-.762a.764.764 0 0 0-.762-.762zM6.619 6.619H5.095a.764.764 0 0 0-.762.762c0 .419.343.761.762.761H6.62c.419 0 .762-.342.762-.761a.764.764 0 0 0-.762-.762z" />
    </svg>
  );
}

function CopiedCodeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
      <path d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  );
}

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

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);
  const copyCode = async () => {
    // Only show the checkmark when the copy actually landed — in the
    // preview iframe the raw Clipboard API is unavailable (see clipboard.ts).
    if (!await copyTextToClipboard(code)) return;
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  const copyButton = (
    <button type="button" className="markdown-code-copy"
      title={copied ? "Copied" : "Copy code"}
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => { void copyCode(); }}>
      {copied ? <CopiedCodeIcon /> : <CopyCodeIcon />}
    </button>
  );

  if (!tokens) {
    return (
      <div className="markdown-code-block">
        <pre data-language={languageTag ?? undefined}><code>{code}</code></pre>
        {copyButton}
      </div>
    );
  }
  return (
    <div className="markdown-code-block">
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
      {copyButton}
    </div>
  );
});

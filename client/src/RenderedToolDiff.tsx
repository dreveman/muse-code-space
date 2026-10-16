import { memo, useEffect, useState, type CSSProperties } from "react";
import { getCachedHighlight, highlightCode, type HighlightLines } from "./codeHighlight";
import { codeLanguageForPath } from "./codeLanguage";
import { copyCodeSelection } from "./codeSelection";
import { diffDisplayLines, type DiffDocument, type DiffFile } from "./toolDiff";

// A hunk starting at line 1 has a known lexical starting state on each side
// of the edit. All later/disjoint hunks remain plain; guessing the grammar's
// state in the unseen gap could incorrectly color a string or comment.
const DiffFileLines = memo(function DiffFileLines({ file, source }: { file: DiffFile; source: DiffDocument["source"] }) {
  const first = file.hunks[0];
  const startsAtBeginning = source === "patch" && first && /^@@ -1(?:,\d+)? \+1(?:,\d+)? @@/.test(first.header) && codeLanguageForPath(file.path) !== null;
  const oldText = startsAtBeginning ? first.lines.filter((line) => line.kind === "remove" || line.kind === "context").map((line) => line.text.slice(1)).join("\n") : "";
  const newText = startsAtBeginning ? first.lines.filter((line) => line.kind === "add" || line.kind === "context").map((line) => line.text.slice(1)).join("\n") : "";
  const cachedOld = startsAtBeginning ? getCachedHighlight(oldText, file.path, "light") : null;
  const cachedNext = startsAtBeginning ? getCachedHighlight(newText, file.path, "light") : null;
  const [result, setResult] = useState<{ path: string; oldText: string; newText: string; old: HighlightLines; next: HighlightLines } | null>(null);
  const colored = startsAtBeginning
    ? cachedOld && cachedNext
      ? { old: cachedOld, next: cachedNext }
      : result?.path === file.path && result.oldText === oldText && result.newText === newText ? result : null
    : null;
  useEffect(() => {
    if (!startsAtBeginning || (cachedOld !== undefined && cachedNext !== undefined)) return;
    let cancelled = false;
    void Promise.all([
      highlightCode(oldText, file.path, "light"), highlightCode(newText, file.path, "light"),
    ]).then(([old, next]) => {
      if (!cancelled && old && next) setResult({ path: file.path, oldText, newText, old, next });
    });
    return () => { cancelled = true; };
  }, [startsAtBeginning, cachedOld, cachedNext, oldText, newText, file.path]);
  const rows = diffDisplayLines({ files: [file], source }).filter((row) => row.kind !== "file" && row.kind !== "hunk");
  let oldIndex = 0, nextIndex = 0;
  return <div>
    {rows.map((row, index) => {
      let tokens = null;
      if (index < (first?.lines.length ?? 0)) {
        if (row.kind === "remove") tokens = colored?.old[oldIndex++];
        else if (row.kind === "add") tokens = colored?.next[nextIndex++];
        else if (row.kind === "context") { oldIndex++; nextIndex++; } // unchanged context keeps the app's theme color
      }
      return <div key={index} className={`tool-diff-line ${row.kind}`}>
        <span className="tool-diff-gutter" aria-label={row.lineNumber === null ? undefined : `${row.kind === "add" ? "Added" : row.kind === "remove" ? "Removed" : "Line"} ${row.lineNumber}`}>
          {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}{row.lineNumber ?? ""}
        </span>
        <span className="tool-diff-code">{tokens?.map((token, part) => <span key={part} style={token.color ? { color: token.color } : undefined}>{token.text}</span>) ?? (row.kind === "meta" ? row.text : row.text.slice(1))}</span>
      </div>;
    })}
  </div>;
});

// The scroll pane shows code lines with visible old/new line numbers. Raw
// ---/+++/@@ headers are omitted; multi-file patches get a simple file label.
export const ToolDiff = memo(function ToolDiff({ doc }: { doc: DiffDocument }) {
  const numberDigits = diffDisplayLines(doc).reduce((widest, row) =>
    Math.max(widest, row.lineNumber === null ? 0 : String(row.lineNumber).length), 1);
  const style = { "--diff-gutter-width": `${numberDigits + 1}ch` } as CSSProperties;
  return (
    <div className="tool-diff" role="region" aria-label="Tool changes" tabIndex={0} onCopy={copyCodeSelection} style={style}>
      {doc.files.map((file, fileIndex) => (
        <div key={`${file.path}-${fileIndex}`}>
          {doc.files.length > 1 && <div className="tool-diff-file-label">{file.path}</div>}
          <DiffFileLines file={file} source={doc.source} />
        </div>
      ))}
    </div>
  );
});

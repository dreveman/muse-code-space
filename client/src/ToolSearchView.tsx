import { memo, type CSSProperties } from "react";
import type { SearchPreview } from "./searchOutput";
import { copyCodeSelection } from "./codeSelection";

export const ToolSearchView = memo(function ToolSearchView({ preview }: { preview: SearchPreview }) {
  const widest = Math.max(2, ...preview.groups.flatMap((group) => group.lines.map((line) => String(line.number).length)));
  return (
    <div className="tool-diff tool-search" role="region" aria-label="Search results" tabIndex={0} onCopy={copyCodeSelection} style={{ "--search-gutter-width": `${widest}ch` } as CSSProperties}>
      {preview.groups.length === 0 && <div className="tool-search-empty">{preview.partial || preview.notes.length ? "No matches shown" : "No matches"}</div>}
      {preview.groups.map((group) => (
        <div className="tool-search-group" key={group.path}>
          <div className="tool-search-file">{group.path}</div>
          {group.lines.map((line, index) => (
            <div className={`tool-search-line${line.context ? " context" : " match"}`} key={`${line.number}-${index}`}>
              <span className="tool-search-number">{line.number}</span>
              <span className="tool-search-code">{line.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
      {preview.notes.map((note, index) => <div className="tool-search-note" key={index}>{note}</div>)}
      {preview.partial && preview.notes.length === 0 && <div className="tool-search-note">Partial results. Use raw output to inspect the limit.</div>}
    </div>
  );
});

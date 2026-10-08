import type { FilePreview } from "./toolPresentation";
import { CodeFileLines } from "./CodeFileLines";

// Historical read/write preview: only verified tool content gets a numbered
// code view. Opening it in a tab reads the CURRENT on-disk file separately.
export function ToolFileView({ preview, workspaceRoot, onOpenFile }: { preview: FilePreview; workspaceRoot: string; onOpenFile?: (path: string) => void }) {
  const candidate = preview.path?.startsWith(`${workspaceRoot}/`) ? preview.path.slice(workspaceRoot.length + 1) : preview.path;
  const relative = candidate && !candidate.startsWith("/") && !candidate.includes("\\") &&
    !candidate.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(candidate) ? candidate : null;
  return (
    <>
      {preview.partial && <div className="tool-diff-caption">File preview truncated</div>}
      <CodeFileLines lines={preview.lines} path={preview.path} complete={!preview.partial} />
      {relative && onOpenFile && (
        <div className="tool-file-actions">
          <button type="button" className="tool-more tool-open-file" title={`Open current file: ${relative}`} onClick={() => onOpenFile(relative)}>Open {relative.split("/").at(-1)}</button>
        </div>
      )}
    </>
  );
}

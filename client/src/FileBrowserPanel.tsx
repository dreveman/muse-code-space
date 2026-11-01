import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function FileBrowserIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FolderEntryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" width="15" height="15" className="file-browser-entry-icon is-folder">
      <path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-6A1.75 1.75 0 0 0 14.25 4H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 2.26 5.55 2 5 2H1.75Z" />
    </svg>
  );
}

function FileEntryIcon({ isImage = false }: { isImage?: boolean }) {
  if (isImage) {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" className="file-browser-entry-icon is-image">
        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.75" />
        <circle cx="5.5" cy="6" r="1.25" />
        <path d="m2.5 12 3.5-3.5 2.5 2.5 2.5-2.5 3 3" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" width="15" height="15" className="file-browser-entry-icon is-file">
      <path d="M8.794 8.031a.762.762 0 1 1 0 1.524H5.746a.762.762 0 0 1 0-1.524h3.048zM10.318 4.984a.762.762 0 1 1 0 1.523H5.746a.762.762 0 0 1 0-1.523h4.572z" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.841.412a2.286 2.286 0 0 1 2.286 2.286v10.666a2.286 2.286 0 0 1-2.286 2.286H4.222a2.286 2.286 0 0 1-2.285-2.286V2.698A2.286 2.286 0 0 1 4.222.412h7.62zM4.222 1.936a.762.762 0 0 0-.762.762v10.666c0 .421.341.762.762.762h7.62c.42 0 .761-.34.761-.761V2.697a.762.762 0 0 0-.762-.762H4.222z"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function NewFileBrowserButton({
  active = false,
  onOpen,
}: {
  active?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`terminal-toggle${active ? " active" : ""}`}
      onClick={onOpen}
      aria-label="Browse workspace files"
      title="Files — browse the working directory"
    >
      <FileBrowserIcon />
    </button>
  );
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FileBrowserView = memo(function FileBrowserView({
  sessionId,
  workspacePath = null,
  onOpenFile,
  onOpenImage,
}: {
  sessionId: string;
  workspacePath?: string | null;
  onOpenFile?: (path: string) => void;
  onOpenImage?: (spec: { title: string; src: string; path: string }) => void;
}) {
  const [currentDir, setCurrentDir] = useState("");
  const [filterText, setFilterText] = useState("");

  const dirQuery = useQuery({
    queryKey: ["session-directory", sessionId, currentDir],
    queryFn: () => api.listSessionDirectory({ session_id: sessionId, path: currentDir }),
    staleTime: 4000,
    retry: false,
  });

  const segments = useMemo(() => (currentDir ? currentDir.split("/").filter(Boolean) : []), [currentDir]);
  const entries = dirQuery.data?.ok ? dirQuery.data.entries : [];
  const filteredEntries = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, filterText]);

  const navigateTo = (nextDir: string) => {
    setCurrentDir(nextDir);
    setFilterText("");
  };

  const navigateUp = () => {
    if (segments.length === 0) return;
    navigateTo(segments.slice(0, -1).join("/"));
  };

  return (
    <div className="file-browser-panel">
      <header className="file-browser-header">
        <nav className="file-browser-breadcrumbs" aria-label="Workspace directory path">
          <button
            type="button"
            className={`file-browser-crumb${segments.length === 0 ? " is-current" : ""}`}
            onClick={() => navigateTo("")}
            title={workspacePath ?? "Workspace root"}
          >
            {workspacePath ? workspacePath.split("/").at(-1) || "Workspace" : "Workspace"}
          </button>
          {segments.map((seg, idx) => {
            const pathUpToHere = segments.slice(0, idx + 1).join("/");
            const isLast = idx === segments.length - 1;
            return (
              <span key={pathUpToHere} className="file-browser-crumb-wrap">
                <span className="file-browser-crumb-sep" aria-hidden="true">/</span>
                <button
                  type="button"
                  className={`file-browser-crumb${isLast ? " is-current" : ""}`}
                  onClick={() => navigateTo(pathUpToHere)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="file-browser-header-actions">
          {segments.length > 0 && (
            <button
              type="button"
              className="file-browser-up-btn"
              onClick={navigateUp}
              title="Parent directory"
              aria-label="Up to parent directory"
            >
              ↑ Up
            </button>
          )}
          <button
            type="button"
            className="file-browser-refresh-btn"
            onClick={() => void dirQuery.refetch()}
            disabled={dirQuery.isFetching}
            aria-label="Refresh directory"
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </header>

      <div className="file-browser-Search-bar">
        <input
          type="search"
          className="file-browser-filter-input"
          placeholder="Filter files in folder…"
          aria-label="Filter files in folder"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>

      <div className="file-browser-body" role="region" aria-label="Directory contents">
        {dirQuery.isPending ? (
          <p className="file-browser-empty" role="status">Loading files…</p>
        ) : dirQuery.data && !dirQuery.data.ok ? (
          <p className="file-browser-empty is-error" role="alert">
            {dirQuery.data.error ?? "Directory could not be read."}
          </p>
        ) : filteredEntries.length === 0 ? (
          <p className="file-browser-empty">
            {filterText.trim() ? "No matching files in this folder." : "This folder is empty."}
          </p>
        ) : (
          <ul className="file-browser-list" role="list">
            {filteredEntries.map((entry) => (
              <li key={entry.path} className="file-browser-item">
                <button
                  type="button"
                  className={`file-browser-row is-${entry.kind}`}
                  onClick={() => {
                    if (entry.kind === "directory") {
                      navigateTo(entry.path);
                    } else if (entry.isImage && onOpenImage) {
                      onOpenImage({ title: entry.name, src: "", path: entry.path });
                    } else {
                      onOpenFile?.(entry.path);
                    }
                  }}
                >
                  {entry.kind === "directory" ? (
                    <FolderEntryIcon />
                  ) : (
                    <FileEntryIcon isImage={entry.isImage} />
                  )}
                  <span className="file-browser-entry-name">{entry.name}</span>
                  {entry.kind === "directory" ? (
                    <span className="file-browser-entry-meta" aria-hidden="true">›</span>
                  ) : (
                    <span className="file-browser-entry-meta">{formatFileSize(entry.size)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { CodeFileLines } from "./CodeFileLines";
import { copyTextToClipboard } from "./clipboard";
import { ImageTab, isWorkspaceImagePath } from "./ImageTab";

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
      <path d="M13.476.516c.42 0 .762.34.762.762v2.744c0 .421-.341.762-.762.762H10.81a.762.762 0 1 1 0-1.524h.995a6.1 6.1 0 1 0 2.44 4.88.762.762 0 0 1 1.524 0 7.624 7.624 0 1 1-3.054-6.102v-.76c0-.421.341-.762.762-.762z" />
    </svg>
  );
}
function DownloadIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></svg>;
}
function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" width="16" height="16" color="currentColor">
      <path d="M14.238 4.333a.764.764 0 0 0-.762.762v6.095a3.047 3.047 0 0 1-3.048 3.048H6.62a.764.764 0 0 0-.762.762c0 .419.343.761.762.761h3.81a4.575 4.575 0 0 0 4.57-4.57V5.094a.764.764 0 0 0-.761-.762z" />
      <path d="M11.952 10.81V2.427A1.905 1.905 0 0 0 10.047.523H3.19a1.905 1.905 0 0 0-1.904 1.905v8.381c0 1.052.853 1.905 1.904 1.905h6.857a1.905 1.905 0 0 0 1.905-1.905zm-9.143 0V2.427c0-.213.168-.38.381-.38h6.857c.214 0 .381.167.381.38v8.381c0 .214-.167.381-.38.381H3.19a.377.377 0 0 1-.38-.38z" />
      <path d="M8.143 3.571H5.095a.764.764 0 0 0-.762.762c0 .419.343.762.762.762h3.048c.419 0 .762-.343.762-.762a.764.764 0 0 0-.762-.762zM6.619 6.619H5.095a.764.764 0 0 0-.762.762c0 .419.343.761.762.761H6.62c.419 0 .762-.342.762-.761a.764.764 0 0 0-.762-.762z" />
    </svg>
  );
}
function CheckIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 12 5 5L20 6" /></svg>;
}

// Unlike tool previews, this is the current on-disk file. It never writes to
// the workspace; Refresh is explicit so a changing file does not shift under
// someone reading it. Closing the tab discards the snapshot.
export function FileTab({ sessionId, path }: { sessionId: string; path: string }) {
  if (isWorkspaceImagePath(path)) {
    return <ImageTab sessionId={sessionId} path={path} />;
  }
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setActionError(null); setCopied(false);
    void api.readSessionFile({ session_id: sessionId, path }).then((response) => {
      if (cancelled) return;
      setContent(response.ok ? response.content : null);
      setError(response.ok ? null : response.error ?? "File could not be opened.");
    }).catch(() => {
      if (!cancelled) { setContent(null); setError("File could not be opened. Try Refresh."); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, path, revision]);

  const copyContents = async () => {
    if (content === null) return;
    setActionError(null);
    // The original text, never its numbered view. The shared helper falls
    // back to execCommand where the Clipboard API is unavailable (preview
    // iframe), and only reports success when the copy actually landed.
    if (!await copyTextToClipboard(content)) { setActionError("Could not copy the file. Check clipboard permission."); return; }
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  const download = () => {
    if (content === null) return;
    setActionError(null);
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").at(-1) || "artifact.txt";
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
      window.setTimeout(() => URL.revokeObjectURL(url!), 1000);
    } catch {
      if (url !== null) URL.revokeObjectURL(url);
      setActionError("Could not download the file. Try again.");
    }
  };
  const rows = content === null ? [] : content.replace(/\r\n/g, "\n").split("\n").map((text, index) => ({ number: index + 1, text }));
  return (
    <div className="file-tab-view">
      <div className="file-tab-toolbar">
        <span title={path}>{path}</span>
        <div className="file-tab-actions">
          <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading} aria-label="Refresh file" title="Refresh"><RefreshIcon /></button>
          <button type="button" onClick={download} disabled={loading || content === null} aria-label="Download file" title="Download"><DownloadIcon /></button>
          <button type="button" onClick={() => void copyContents()} disabled={loading || content === null} aria-label={copied ? "Copied file contents" : "Copy file contents"} title={copied ? "Copied" : "Copy"}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
        </div>
      </div>
      {loading && <p role="status">Opening file…</p>}
      {error && !loading && <p role="alert">{error}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {!loading && content !== null && <CodeFileLines lines={rows} path={path} complete tab />}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { CodeFileLines } from "./CodeFileLines";

function RefreshIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12.5-2" /></svg>;
}
function DownloadIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></svg>;
}
function CopyIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></svg>;
}
function CheckIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 12 5 5L20 6" /></svg>;
}

// Unlike tool previews, this is the current on-disk file. It never writes to
// the workspace; Refresh is explicit so a changing file does not shift under
// someone reading it. Closing the tab discards the snapshot.
export function FileTab({ sessionId, path }: { sessionId: string; path: string }) {
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
    try {
      await navigator.clipboard.writeText(content); // the original text, never its numbered view
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch { setActionError("Could not copy the file. Check clipboard permission."); }
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

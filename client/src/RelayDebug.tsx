import { useLayoutEffect, useRef } from "react";
import { api, type ApiResponse } from "./api";

type RelayData = ApiResponse<typeof api, "getRelayDebug">;

// Bounded, credential-free request outcomes from the VM relay. This is not a
// raw HTTP dump: paths are categories, with no query strings or payloads.
export function RelayDebugPanel({ data, pending }: { data: RelayData | undefined; pending: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const entries = data?.entries ?? [];
  useLayoutEffect(() => {
    if (followRef.current && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [data?.entries]);
  const status = data?.status ?? "down";
  const recentFailure = status === "up" && !!data?.lastFailureAt &&
    (!data.lastSuccessAt || data.lastFailureAt > data.lastSuccessAt);
  return <section className="wire-debug-log relay-debug-log" aria-label="Relay diagnostics">
    <div className="wire-debug-log-header">
      <span>Model connection</span>
      <span className={status === "down" || recentFailure ? "wire-debug-error" : undefined}>
        {status === "disabled" ? "Not used on this host" : status === "down" ? "Relay unreachable" : recentFailure ? "Recent model request failed" : "Relay reachable"}
      </span>
    </div>
    {data?.enabled && <div className="relay-debug-summary">
      <span>Logging since: {data.startedAt ? data.startedAt.replace("T", " ").slice(0, 19) : "unknown"}</span>
      <span>Last success: {data.lastSuccessAt ? data.lastSuccessAt.replace("T", " ").slice(0, 19) : "none"}</span>
      <span>Last failure: {data.lastFailureAt ? data.lastFailureAt.replace("T", " ").slice(0, 19) : "none"}</span>
    </div>}
    <div ref={bodyRef} className="wire-debug-log-body" role="log" aria-live="polite" onScroll={(event) => {
      const body = event.currentTarget;
      followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 4;
    }}>
      {pending ? <p className="wire-debug-empty">Loading…</p>
        : data?.error ? <p className="wire-debug-empty wire-debug-error">{data.error}</p>
        : status === "disabled" ? <p className="wire-debug-empty">No relay is used on this host.</p>
        : entries.length === 0 ? <p className="wire-debug-empty">No model requests recorded yet.</p>
        : entries.map((entry) => <div key={entry.id} className="wire-debug-entry relay-debug-entry">
          <span className="wire-debug-time">{entry.at.slice(11, 19)}</span>
          <span className="wire-debug-method">{entry.method} {entry.path}</span>
          <span className={entry.status >= 400 || entry.stage !== "complete" ? "wire-debug-error" : "relay-debug-ok"}>HTTP {entry.status}</span>
          <span className="wire-debug-ms">{entry.durationMs}ms</span>
          <span className="relay-debug-details">{entry.requestBytes} → {entry.responseBytes} bytes · {entry.stage}{entry.errorType ? ` (${entry.errorType})` : ""}</span>
        </div>)}
    </div>
  </section>;
}

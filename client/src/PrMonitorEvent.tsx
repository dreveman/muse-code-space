import { parsePrMonitor, prMonitorStatusLine, prMonitorSummary } from "./prMonitor";

// The live PR-monitoring row: not a tool row, but a persistent transcript
// entry the pilot updates in place as the PR changes. A spinner shows
// while monitoring is active; terminal states (merged/closed/stopped)
// render still. (The composer-adjacent mini indicators come later.)
export function PrMonitorEvent({ content }: { content: string }) {
  const row = parsePrMonitor(content);
  if (!row) return <div className="message-text">{content}</div>;
  const active = row.status === "monitoring";
  const summary = prMonitorSummary(row);
  const latest = row.changes.at(-1);
  return (
    <div className="pr-monitor-row">
      <div className="pr-monitor-head">
        {active
          ? <span className="working-spinner pr-monitor-spinner" aria-hidden="true" />
          : <span className={`pr-monitor-mark ${row.status}`} aria-hidden="true">{row.status === "merged" || row.status === "closed" ? "✓" : "•"}</span>}
        <span className="pr-monitor-state">{prMonitorStatusLine(row)}</span>
        <a className="pr-monitor-link" href={row.url} target="_blank" rel="noopener noreferrer">
          PR #{row.number} · {row.owner}/{row.repo}
        </a>
        {row.title && <span className="pr-monitor-title">{row.title}</span>}
      </div>
      {(summary || latest) && (
        <div className="pr-monitor-detail">
          {summary && <span>{summary}</span>}
          {summary && latest && <span aria-hidden="true"> · </span>}
          {latest && <span>Latest: {latest.text}</span>}
        </div>
      )}
    </div>
  );
}

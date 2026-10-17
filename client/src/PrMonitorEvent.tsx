import { memo, useState } from "react";
import { formatMessageTime } from "./messageTime";
import { parsePrMonitor, prMonitorStatusLine, prMonitorSummary } from "./prMonitor";

function SparkleIcon() {
  return (
    <svg className="pr-monitor-sparkle" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="m5.466 5.13-.912 1.823-1.824.912a.6.6 0 0 0-.33.534c0 .222.126.438.33.534l1.824.912.912 1.824A.6.6 0 0 0 6 12a.593.593 0 0 0 .534-.33l.912-1.824 1.824-.912A.6.6 0 0 0 9.6 8.4a.593.593 0 0 0-.33-.534l-1.824-.912-.912-1.824c-.204-.408-.87-.408-1.074 0h.006zM11.67 3.665l-1.02-.51-.51-1.02c-.204-.408-.87-.408-1.074 0l-.51 1.02-1.02.51a.6.6 0 0 0-.33.534c0 .222.126.438.33.534l1.02.51.51 1.02a.6.6 0 0 0 .534.33.593.593 0 0 0 .534-.33l.51-1.02 1.02-.51a.6.6 0 0 0 0-1.068h.006zM.93 3.233l1.224.612.612 1.224a.6.6 0 0 0 .534.33.593.593 0 0 0 .534-.33l.612-1.224 1.224-.612A.6.6 0 0 0 6 2.7a.593.593 0 0 0-.33-.534l-1.224-.612L3.834.33c-.204-.408-.87-.408-1.074 0l-.612 1.224-1.224.612a.6.6 0 0 0-.33.534c0 .222.126.438.33.534H.93z" />
    </svg>
  );
}

function SyncArrowsIcon() {
  return (
    <svg className="pr-monitor-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.3 9.2A8.2 8.2 0 0 1 19.3 8.3" />
      <path d="M19.5 4.9v3.5H16" />
      <path d="M19.7 14.8A8.2 8.2 0 0 1 4.7 15.7" />
      <path d="M4.5 19.1v-3.5H8" />
    </svg>
  );
}

function MonitorDocIcon() {
  return (
    <svg className="pr-monitor-doc-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="4.5" y="3" width="11" height="14" rx="2.5" fill="currentColor" />
      <path d="M7.5 8h5M7.5 11.5h3.5" stroke="var(--terminal-bg, #fff)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// The live PR-monitoring row: not a tool row, but a persistent transcript
// entry the pilot updates in place as the PR changes. A rotating sync badge
// shows while monitoring is active; terminal states (merged/closed/stopped)
// render a still document badge. Clicking the header expands/collapses the
// full status and change history card.
export const PrMonitorEvent = memo(function PrMonitorEvent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const row = parsePrMonitor(content);
  if (!row) return <div className="message-text">{content}</div>;
  const active = row.status === "monitoring";
  const summary = prMonitorSummary(row);
  const latest = row.changes.at(-1);
  const earlierChanges = row.changes.length > 1 ? row.changes.slice(0, -1) : [];
  const headlineText = latest
    ? `PR #${row.number} · ${row.owner}/${row.repo} — ${latest.text}`
    : `PR #${row.number} · ${row.owner}/${row.repo}${summary ? ` · ${summary}` : row.title ? ` — ${row.title}` : ""}`;
  const time = formatMessageTime(row.updatedAt || row.startedAt, Date.now());

  return (
    <div className={`pr-monitor-row${expanded ? " expanded" : ""}`}>
      <div className="pr-monitor-grid">
        <button
          type="button"
          className="pr-monitor-head pr-monitor-trigger"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <span className={`pr-monitor-badge ${active ? "active" : `pr-monitor-mark ${row.status}`}`} aria-hidden="true">
            {active ? <SyncArrowsIcon /> : <MonitorDocIcon />}
          </span>
          <SparkleIcon />
          <span className="pr-monitor-state">{prMonitorStatusLine(row)}:</span>
          <span className="pr-monitor-title">{headlineText}</span>
        </button>
        {expanded && (
          <>
            <span className="pr-monitor-guide" aria-hidden="true" />
            <div className="pr-monitor-detail">
              <div className="pr-monitor-detail-lead">
                <a className="pr-monitor-link" href={row.url} target="_blank" rel="noopener noreferrer">
                  PR #{row.number} · {row.owner}/{row.repo}
                </a>
                {latest ? ` changed: ${latest.text}.` : row.title ? ` — ${row.title}.` : "."}
              </div>
              <div className="pr-monitor-detail-now">
                Now: {row.status.toUpperCase()}
                {summary ? ` · ${summary}` : ""}
                {row.title && latest ? ` · ${row.title}` : ""}.
              </div>
              {earlierChanges.length > 0 && (
                <div className="pr-monitor-detail-earlier">
                  <div>Earlier updates (routine, not delivered on their own):</div>
                  {earlierChanges.map((change, idx) => (
                    <div key={`${change.at}-${idx}`}>- {change.text}</div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {expanded && time && <div className="message-time pr-monitor-time">{time}</div>}
    </div>
  );
});

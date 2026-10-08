// Transcript block for agent-to-agent work: a workflow and its child agents
// (or a single subagent). One live block per item, updated in place as the
// children progress — also after the turn that launched it has ended. Each
// child shows its status and run time; the workflow's result shows when it
// finishes. Stop cancels a running workflow. (Per-child results aren't on
// the protocol: subagent/readResult is a steering command for the parent
// agent, not a data read.)
import { useState } from "react";
import { api } from "./api";
import { formatToolDuration, toolElapsedMs } from "./toolDuration";

type AgentsChild = { id: string; label: string; status: string; phase: string | null; attempt: number; durationMs: number | null };
type AgentsRow = {
  kind: "workflow" | "subagent";
  title: string;
  status: string;
  message: string | null;
  workflowRunId: string | null;
  subagentId: string | null;
  children: AgentsChild[];
};

export function parseAgentsRow(content: string): AgentsRow | null {
  try {
    const row = JSON.parse(content) as AgentsRow;
    return row && (row.kind === "workflow" || row.kind === "subagent") ? { ...row, children: row.children ?? [] } : null;
  } catch {
    return null;
  }
}

/** Running = not terminal yet. Unknown statuses count as terminal (MSP's rule). */
export function agentStatusRunning(status: string): boolean {
  return /^(inProgress|running|starting|accepted|pending|queued)$/i.test(status);
}

function statusTone(status: string): "running" | "done" | "failed" | "cancelled" {
  if (agentStatusRunning(status)) return "running";
  if (/cancel|stopp|skip/i.test(status)) return "cancelled";
  if (/fail|error|reject/i.test(status)) return "failed";
  return "done";
}

function StatusMark({ status }: { status: string }) {
  const tone = statusTone(status);
  if (tone === "running") return <span className="working-spinner agents-mark" aria-label="running" />;
  return (
    <span className={`agents-mark ${tone}`} aria-label={tone}>
      {tone === "done" ? "✓" : tone === "failed" ? "✕" : "⊘"}
    </span>
  );
}

function AgentsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M12 7.5v4M12 11.5l-5.5 4.5M12 11.5l5.5 4.5" />
    </svg>
  );
}

export function AgentsEvent({ sessionId, content, startedAt, finishedAt, nowMs }: {
  sessionId: string;
  content: string;
  startedAt: string | null;
  finishedAt: string | null;
  nowMs: number;
}) {
  const row = parseAgentsRow(content);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  if (!row) return <div className="message-text">{content}</div>;

  const running = agentStatusRunning(row.status);
  const elapsed = toolElapsedMs(startedAt, finishedAt, nowMs);

  const stop = async () => {
    if (!row.workflowRunId) return;
    setStopping(true);
    setStopError(null);
    const res = await api.cancelWorkflow({ session_id: sessionId, workflow_run_id: row.workflowRunId }).catch(() => null);
    if (!res?.ok) setStopError(res?.error ?? "The workflow couldn't be stopped.");
    setStopping(false);
  };

  return (
    <div className={`agents-block ${statusTone(row.status)}`}>
      <div className="agents-head">
        <span className="agents-icon"><AgentsIcon /></span>
        <strong className="agents-kind">{row.kind === "workflow" ? "Workflow" : "Helper"}</strong>
        <span className="agents-title" title={row.title}>{row.title}</span>
        <StatusMark status={row.status} />
        {elapsed !== null && <span className="tool-duration">{formatToolDuration(elapsed, running)}</span>}
        {running && row.workflowRunId && (
          <button type="button" className="agents-stop" onClick={() => void stop()} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {row.kind === "workflow" && (
        row.children.length === 0 ? (
          running && <div className="agents-note">Starting helpers…</div>
        ) : (
          <ul className="agents-children">
            {row.children.map((child) => (
              <li key={child.id} className="agents-child">
                <StatusMark status={child.status} />
                <span className="agents-child-label">{child.label}</span>
                {child.phase && agentStatusRunning(child.status) && <span className="agents-child-phase">{child.phase}</span>}
                {child.attempt > 1 && <span className="agents-child-phase">attempt {child.attempt}</span>}
                <span className="tool-duration">
                  {child.durationMs !== null ? formatToolDuration(child.durationMs, false) : agentStatusRunning(child.status) ? "running" : ""}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
      {row.message && <div className="agents-message">{row.message}</div>}
      {stopError && <div className="agents-error">{stopError}</div>}
    </div>
  );
}

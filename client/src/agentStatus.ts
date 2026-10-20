// Visual priority in the agent list: unseen output wins over the current
// turn state; once read, a live agent spins and a successful one is checked.
export type AgentStatusInput = {
  status: "queued" | "running" | "succeeded" | "failed" | "stopped";
  output_revision: number;
  seen_output_revision: number;
};

export type AgentVisualStatus = "unread" | "working" | "complete" | "failed" | "idle";

export function agentVisualStatus(agent: AgentStatusInput): AgentVisualStatus {
  if (agent.output_revision > agent.seen_output_revision) return "unread";
  if (agent.status === "queued" || agent.status === "running") return "working";
  if (agent.status === "succeeded") return "complete";
  if (agent.status === "failed") return "failed";
  return "idle";
}

// A few pixels of rounding/slop accommodate fractional scroll positions and
// mobile momentum. A zero-height transcript counts as bottom on first load.
// On `.terminal-body` (`flex-direction: column-reverse`), `scrollTop === 0`
// is the bottom and scrolling up produces negative `scrollTop` values.
export function transcriptAtBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight"> & { classList?: DOMTokenList },
  tolerance = 24,
): boolean {
  if (element.scrollTop < 0) return -element.scrollTop <= tolerance;
  if (element.classList?.contains("terminal-body")) return element.scrollTop <= tolerance;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= tolerance;
}

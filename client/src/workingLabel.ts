import type { ToolDetails } from "../../server/src/toolDetails";
import { toolPresentation } from "./toolPresentation.ts";

export type WorkingLabelEvent = {
  kind: string;
  content: string;
  created_at: string;
  tool_details?: ToolDetails | null;
  started_at?: string | null;
  finished_at?: string | null;
};

const TYPING_WINDOW_MS = 8_000;

export function getWorkingLabel(args: {
  status: string | null | undefined;
  promptStartedMs: number;
  events: WorkingLabelEvent[];
  nowMs: number;
  workspaceRoot?: string;
}): string {
  const { status, promptStartedMs, events, nowMs } = args;
  let lastActivityMs: number | null = null;
  let lastOutputMs: number | null = null;
  let hasPriorActivity = false;
  let lastEvent: WorkingLabelEvent | null = null;
  let runningTool: WorkingLabelEvent | null = null;
  for (const event of events) {
    const at = new Date(event.created_at).getTime();
    if (!Number.isFinite(at)) continue;
    if (event.kind === "user") continue;
    if (at < promptStartedMs) {
      hasPriorActivity = true;
      continue;
    }
    if (lastActivityMs === null || at > lastActivityMs) lastActivityMs = at;
    if (lastEvent === null || at >= new Date(lastEvent.created_at).getTime()) lastEvent = event;
    if (event.kind === "tool" && event.finished_at == null &&
        (event.tool_details?.status === "inProgress" || event.started_at != null) &&
        (runningTool === null || at >= new Date(runningTool.created_at).getTime())) runningTool = event;
    if (event.kind === "stdout" && (lastOutputMs === null || at > lastOutputMs)) {
      lastOutputMs = at;
    }
  }
  if (status === "queued") return "Starting";
  if (runningTool) return toolPresentation({
    label: runningTool.content,
    details: runningTool.tool_details ?? null,
    running: true,
    workspaceRoot: args.workspaceRoot ?? "",
  }).name;
  // A live session that has done work before is already thinking about the
  // new prompt while the first response is still on its way. Only a brand-new
  // session with no prior activity shows Starting.
  if (lastActivityMs === null) return hasPriorActivity ? "Thinking" : "Starting";
  // A completed tool is no longer running while the companion plans its next step.
  if (lastEvent?.kind === "tool") return "Thinking";
  // A workflow / subagent is the latest activity: its child agents are working.
  if (lastEvent?.kind === "agents") return "Running helpers";
  if (lastOutputMs !== null && nowMs - lastOutputMs <= TYPING_WINDOW_MS) return "Typing";
  return "Thinking";
}

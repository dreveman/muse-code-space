import type { ToolDetails } from "../../server/src/toolDetails";

export const TOOL_PREVIEW_LINES = 12;

function prettyArguments(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

export function toolTranscriptLines(details: ToolDetails | null, running: boolean, fullOutput: string | null = null, raw = false): string[] {
  if (!details) return ["Tool details were not recorded for this older call."];
  const sections: string[] = [];
  if (details.args !== null) sections.push(`Arguments:\n${raw ? details.args : prettyArguments(details.args)}`);
  const output = fullOutput ?? details.output;
  sections.push(`Output:\n${output ?? (running ? "(waiting for output…)" : "(no text output)")}`);
  if (details.failureReason) sections.push(`Failure:\n${details.failureReason}`);
  if (details.truncated && fullOutput === null && details.outputRef?.availability !== "available") {
    sections.push("(Output was truncated by Muse; the full bytes are unavailable.)");
  }
  return sections.join("\n\n").replace(/\r\n/g, "\n").split("\n");
}

export function hasStoredOutputBeyondView(details: ToolDetails | null, fullOutput: string | null): boolean {
  if (!details || fullOutput !== null || details.outputRef?.availability !== "available") return false;
  return details.truncated || details.outputRef.byteLen > new TextEncoder().encode(details.output ?? "").length;
}

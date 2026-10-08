import type { ToolDetails } from "../../server/src/toolDetails";

export type SearchLine = { number: number; text: string; context: boolean };
export type SearchGroup = { path: string; lines: SearchLine[] };
export type SearchPreview = {
  mode: "text" | "files";
  groups: SearchGroup[];
  matches: number;
  partial: boolean;
  notes: string[];
};
const MAX_OUTPUT = 256 * 1024;
const MAX_ROWS = 2000;
const BOUNDED_NOTE = /^\[search traversal bounded: reason=(?:max_entries|max_matches|max_elapsed|skipped_files),/;
const PATH_NOTE = /^note: requested path .+ does not exist; searched the other requested paths$/;

// Muse's native search emits `path:line:match` and `path-line-context` in
// text mode, one path per line in files mode, or typed JSONL. Any unexpected,
// incomplete or ambiguous row falls back to the unchanged raw output.
export function searchPreviewForTool(details: ToolDetails | null): SearchPreview | null {
  if (details?.tool?.toLowerCase() !== "search" || details.status !== "completed" || details.failureReason ||
      !details.args || details.args.length > MAX_OUTPUT || details.output == null || details.output.length > MAX_OUTPUT) return null;
  let mode: unknown;
  try {
    const args: unknown = JSON.parse(details.args);
    if (!args || typeof args !== "object" || typeof (args as { pattern?: unknown }).pattern !== "string") return null;
    mode = (args as { output_mode?: unknown }).output_mode ?? "text";
  } catch { return null; }
  if (!(["text", "content", "json", "files_with_matches"] as unknown[]).includes(mode)) return null;
  const storedBeyondPreview = details.outputRef?.availability === "available" &&
    details.outputRef.byteLen > new TextEncoder().encode(details.output).length;
  if (details.output === "" && (details.truncated || storedBeyondPreview)) return null; // not proof of zero matches

  const lines = details.output.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_ROWS) return null;
  const groups = new Map<string, SearchGroup>();
  const notes: string[] = [];
  let matches = 0;
  const add = (path: string, line?: SearchLine) => {
    if (!path || path.length > 1000 || /[\x00-\x1f\x7f]/.test(path) || path.startsWith("/") || path.split("/").includes("..")) return false;
    let group = groups.get(path);
    if (!group) { group = { path, lines: [] }; groups.set(path, group); }
    if (line) { group.lines.push(line); if (!line.context) matches++; }
    return true;
  };

  for (const row of lines) {
    if (BOUNDED_NOTE.test(row) || PATH_NOTE.test(row)) { notes.push(row); continue; }
    if (mode === "files_with_matches") {
      if (!add(row)) return null;
    } else if (mode === "json") {
      let value: unknown;
      try { value = JSON.parse(row); } catch { return null; }
      if (!value || typeof value !== "object") return null;
      const entry = value as { type?: unknown; path?: unknown; line_number?: unknown; text?: unknown; bytes?: unknown };
      if (entry.type === "diagnostic" && typeof entry.text === "string" &&
          (BOUNDED_NOTE.test(entry.text) || PATH_NOTE.test(entry.text))) { notes.push(entry.text); continue; }
      if (!(["match", "context", "context_before", "context_after"] as unknown[]).includes(entry.type) ||
          typeof entry.path !== "string" || !Number.isSafeInteger(entry.line_number) || Number(entry.line_number) < 1 ||
          typeof entry.text !== "string" || entry.bytes !== undefined ||
          !add(entry.path, { number: Number(entry.line_number), text: entry.text, context: entry.type !== "match" })) return null;
    } else {
      const match = /^(.+?)([:\-])([1-9]\d*)\2(.*)$/.exec(row);
      if (!match || !Number.isSafeInteger(Number(match[3])) ||
          /[:\-][1-9]\d*[:\-]/.test(match[4] ?? "") ||
          !add(match[1]!, { number: Number(match[3]), text: match[4]!, context: match[2] === "-" })) return null;
    }
  }
  return { mode: mode === "files_with_matches" ? "files" : "text", groups: [...groups.values()], matches,
    partial: details.truncated || storedBeyondPreview || notes.some((note) => BOUNDED_NOTE.test(note)), notes };
}

export function searchMetric(preview: SearchPreview): string {
  const suffix = preview.partial ? "+" : "";
  if (preview.mode === "files") return `${preview.groups.length}${suffix} ${preview.groups.length === 1 && !suffix ? "file" : "files"}`;
  if (!preview.groups.length && !preview.partial && !preview.notes.length) return "No matches";
  return `${preview.matches}${suffix} ${preview.matches === 1 && !suffix ? "match" : "matches"} · ${preview.groups.length}${suffix} ${preview.groups.length === 1 && !suffix ? "file" : "files"}`;
}

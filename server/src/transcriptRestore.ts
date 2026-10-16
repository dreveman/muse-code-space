// Translate a pilot transcript file (the durable events-<id>.jsonl log) into
// app transcript rows, so a session whose app-side rows were lost can be
// restored from the transcript alone. Mirrors the live sync translation in
// actions.ts (syncPilotEvents), plus userMessage items: live sync skips
// those because the app stores its own user rows at send time, but a restore
// has no app rows, so the transcript's user turns become the user rows.
import {
pilotAgentsRow,
pilotItemText,
pilotItemTime,
pilotReasoningSummary,
pilotSystemText,
pilotToolLabel,
pilotTurnCancelled,
pilotTurnOutcomeError,
type AgentsRow,
type PilotItem,
type PilotStreamEvent,
} from "./pilotEvents.ts";
import { toolDetailsFromItem } from "./toolDetails.ts";

export type RestoredEventRow = {
  kind: "stdout" | "system" | "user" | "tool" | "agents" | "message" | "thinking" | "pr_monitor";
  content: string;
  systemIsError: boolean;
  createdAt: Date;
  itemId: string | null;
  toolDetails: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type TranscriptImport = {
  rows: RestoredEventRow[];
  status: "succeeded" | "failed" | "stopped";
  summary: string | null;
  latestSeq: number;
};

type RawEvent = Record<string, unknown> & {
  seq?: number;
  type?: string;
  at?: string;
  text?: string;
  name?: string;
  cancelled?: boolean;
  direction?: "in" | "out";
  messageId?: string;
  from?: { kind: string; name: string; color?: string; sessionId?: string | null };
  to?: { kind: string; name: string; color?: string; sessionId?: string | null };
  queued?: boolean;
  outcome?: unknown;
  error?: unknown;
};

// Pilot session ids are minted by the pilot/app (uuid-shaped). Anything
// else must never reach a filesystem path: the privileged transcript
// reader builds `events-<id>.jsonl` from this value, so slashes or dot
// segments would turn it into a path-traversal read.
export function safeTranscriptId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

// The first user turn a pilot session receives is wrapped in a "[Code Space]
// You are agent …" preamble ending in a --- separator. The conversation's
// own words are what follows it.
export function cleanTranscriptPrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("[Code Space] You are agent")) {
    const marker = "\n---\n\n";
    const at = trimmed.indexOf(marker);
    if (at >= 0) return trimmed.slice(at + marker.length).trim();
  }
  return trimmed;
}

export type TranscriptSummary = {
  pilot_session_id: string;
  app_session_id: string | null;
  title: string | null;
  name: string | null;
  model_id: string | null;
  workspace_root: string | null;
  created_at: string | null;
  updated_at: string | null;
  prompt: string | null;
};

type LooseEvent = Record<string, unknown>;

function parseSummaryLine(line: string): LooseEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseEvent) : null;
  } catch {
    return null;
  }
}

function looseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// Everything reconcile needs to re-register a conversation lives at the
// head of its transcript: the session_started meta (app id, agent, model,
// workspace) and the first user prompt. The DB prompt is that first prompt
// verbatim (the assistant-authored session_summary is filled in later by
// the assistant, exactly as for live sessions), and updated_at is the
// file's mtime. Nothing from the tail is needed: list previews come from
// the imported rows themselves.
export function summarizeTranscript(pilotSessionId: string, raw: string, mtime: Date): TranscriptSummary | null {
  const lines = raw.split("\n").filter((line) => line.trim());
  let meta: LooseEvent | null = null;
  let name: string | null = null;
  let prompt: string | null = null;
  let createdAt: string | null = null;
  for (const line of lines.slice(0, 60)) {
    const event = parseSummaryLine(line);
    if (!event) continue;
    if (!createdAt) createdAt = looseString(event.at);
    if (event.type === "session_started" && event.meta && typeof event.meta === "object") {
      meta = event.meta as LooseEvent;
    }
    if (event.type === "name_changed") name = looseString(event.name) ?? name;
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ? (event.item as LooseEvent) : null;
    if (!prompt && item?.kind === "userMessage" && item.status !== "inProgress") {
      const text = looseString(item.text) ?? looseString(item.fallbackText);
      if (text) prompt = cleanTranscriptPrompt(text).slice(0, 20000) || null;
    }
    if (meta && prompt) break;
  }
  // A transcript with no user prompt in it is not a past conversation.
  if (!prompt) return null;
  return {
    pilot_session_id: pilotSessionId,
    app_session_id: meta ? looseString(meta.appSessionId) : null,
    title: meta ? looseString(meta.title) : null,
    name: name ?? (meta ? looseString(meta.name) : null),
    model_id: meta ? looseString(meta.modelId) : null,
    workspace_root: meta ? looseString(meta.workspaceRoot) : null,
    created_at: (meta ? looseString(meta.createdAt) : null) ?? createdAt,
    updated_at: mtime.toISOString(),
    prompt,
  };
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 200000);
  try {
    const encoded = JSON.stringify(error);
    if (encoded && encoded !== "{}") return encoded.slice(0, 200000);
  } catch {
    // Fall through.
  }
  return "Muse Code reported an error while running this turn.";
}

const MAX_CONTENT = 200000;

export function transcriptToRows(rawEvents: Array<Record<string, unknown>>, fallbackStart: Date): TranscriptImport {
  const events = rawEvents as RawEvent[];
  const rows: RestoredEventRow[] = [];
  const keyed = new Map<string, RestoredEventRow>();
  let status: TranscriptImport["status"] = "succeeded";
  let summary: string | null = null;
  let latestSeq = 0;
  let lastTime = fallbackStart;

  const pushKeyed = (key: string, row: RestoredEventRow) => {
    const existing = keyed.get(key);
    if (existing) {
      existing.content = row.content;
      existing.toolDetails = row.toolDetails;
      if (row.startedAt && !existing.startedAt) existing.startedAt = row.startedAt;
      if (row.finishedAt) existing.finishedAt = row.finishedAt;
      return existing;
    }
    keyed.set(key, row);
    rows.push(row);
    return row;
  };

  for (const event of events) {
    if (typeof event.seq === "number" && event.seq > latestSeq) latestSeq = event.seq;
    const eventAt = event.at ? new Date(event.at) : null;
    if (eventAt && Number.isFinite(eventAt.getTime())) lastTime = eventAt;
    const item = (event.item ?? undefined) as PilotItem | undefined;

    if (event.type === "item" && item) {
      const itemAt = pilotItemTime(item.recordedAt, event.at) ?? lastTime;
      if (item.kind === "userMessage") {
        if (item.status === "inProgress") continue;
        const text = cleanTranscriptPrompt(item.text ?? item.fallbackText ?? "");
        if (!text) continue;
        rows.push({
          kind: "user", content: text.slice(0, MAX_CONTENT), systemIsError: false,
          createdAt: itemAt, itemId: null, toolDetails: null, startedAt: null, finishedAt: null,
        });
        continue;
      }
      if (item.kind === "reasoning") {
        const itemId = item.itemId;
        if (!itemId) continue;
        const running = item.status === "inProgress";
        pushKeyed(`thinking:${itemId}`, {
          kind: "thinking", content: (pilotReasoningSummary(item) ?? "").slice(0, MAX_CONTENT),
          systemIsError: false, createdAt: itemAt, itemId, toolDetails: null,
          startedAt: itemAt, finishedAt: running ? null : itemAt,
        });
        continue;
      }
      if (item.kind === "workflow" || item.kind === "subagent") {
        const itemId = item.itemId ?? null;
        if (!itemId) continue;
        const existing = keyed.get(`agents:${itemId}`);
        let previous: AgentsRow | null = null;
        if (existing) {
          try { previous = JSON.parse(existing.content) as AgentsRow; } catch { previous = null; }
        }
        const agents = pilotAgentsRow(item, previous);
        if (!agents) continue;
        const running = agents.status === "inProgress";
        pushKeyed(`agents:${itemId}`, {
          kind: "agents", content: JSON.stringify(agents), systemIsError: false,
          createdAt: itemAt, itemId, toolDetails: null,
          startedAt: itemAt, finishedAt: running ? null : itemAt,
        });
        continue;
      }
      const toolContent = pilotToolLabel(item);
      if (toolContent && item.kind === "toolCall") {
        const itemId = item.itemId ?? null;
        if (!itemId) continue;
        const running = item.status === "inProgress";
        pushKeyed(`tool:${itemId}`, {
          kind: "tool", content: toolContent.slice(0, MAX_CONTENT), systemIsError: false,
          createdAt: itemAt, itemId, toolDetails: JSON.stringify(toolDetailsFromItem(item)),
          startedAt: running ? itemAt : null, finishedAt: running ? null : itemAt,
        });
        continue;
      }
      const content = pilotItemText(item);
      if (!content) continue;
      rows.push({
        kind: "stdout", content: content.slice(0, MAX_CONTENT), systemIsError: false,
        createdAt: itemAt, itemId: null, toolDetails: null, startedAt: null, finishedAt: null,
      });
      continue;
    }

    if (event.type === "agent_message" && event.direction && event.from && event.to && typeof event.text === "string") {
      rows.push({
        kind: "message",
        content: JSON.stringify({
          direction: event.direction,
          from: { kind: event.from.kind, name: event.from.name, ...(event.from.sessionId ? { sessionId: event.from.sessionId } : {}), ...(event.from.color ? { color: event.from.color } : {}) },
          to: { kind: event.to.kind, name: event.to.name, ...(event.to.sessionId ? { sessionId: event.to.sessionId } : {}), ...(event.to.color ? { color: event.to.color } : {}) },
          text: event.text,
          queued: event.queued === true,
        }).slice(0, MAX_CONTENT),
        systemIsError: false, createdAt: lastTime, itemId: event.messageId ?? null,
        toolDetails: null, startedAt: null, finishedAt: null,
      });
      continue;
    }

    if (event.type === "pr_monitor" && event.monitor && typeof event.monitor === "object") {
      const monitor = event.monitor as { id?: unknown };
      if (typeof monitor.id === "string" && monitor.id) {
        // One row per monitor; later polls replace the snapshot in place.
        pushKeyed(`pr_monitor:${monitor.id}`, {
          kind: "pr_monitor", content: JSON.stringify(monitor).slice(0, MAX_CONTENT), systemIsError: false,
          createdAt: lastTime, itemId: monitor.id, toolDetails: null, startedAt: null, finishedAt: null,
        });
      }
      continue;
    }

    if (event.type === "turn_completed") {
      if (event.cancelled === true || pilotTurnCancelled(event.outcome)) {
        rows.push({
          kind: "system", content: "Turn stopped.", systemIsError: false,
          createdAt: lastTime, itemId: null, toolDetails: null, startedAt: null, finishedAt: null,
        });
        status = "stopped";
        summary = null;
        continue;
      }
      const outcomeError = pilotTurnOutcomeError(event.outcome);
      if (outcomeError) {
        rows.push({
          kind: "system", content: outcomeError.slice(0, MAX_CONTENT), systemIsError: true,
          createdAt: lastTime, itemId: null, toolDetails: null, startedAt: null, finishedAt: null,
        });
        status = "failed";
        summary = outcomeError;
        continue;
      }
      status = "succeeded";
      summary = null;
      continue;
    }

    if (event.type === "turn_error" || event.type === "recovery_failed") {
      const content = event.type === "recovery_failed"
        ? pilotSystemText(event as PilotStreamEvent) ?? "Automatic recovery failed after the backend restarted."
        : errorText(event.error);
      rows.push({
        kind: "system", content: content.slice(0, MAX_CONTENT), systemIsError: true,
        createdAt: lastTime, itemId: null, toolDetails: null, startedAt: null, finishedAt: null,
      });
      status = "failed";
      summary = content;
      continue;
    }

    // Recovery/host notices render as small transcript lines; bookkeeping
    // kinds (session_started, name_changed, turn markers) return null.
    const notice = pilotSystemText(event as PilotStreamEvent);
    if (notice) {
      rows.push({
        kind: "system", content: notice.slice(0, MAX_CONTENT),
        systemIsError: event.type === "user_input_error",
        createdAt: lastTime, itemId: null, toolDetails: null, startedAt: null, finishedAt: null,
      });
    }
  }

  return { rows, status, summary, latestSeq };
}

import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

// One transcript file (events-<pilotSessionId>.jsonl in the pilot's state
// dir) is the durable record of a past conversation. The summaries returned
// by listTranscripts are derived from the files themselves — never from the
// pilot registry or the app database — so the past-conversation list can be
// rebuilt after either store is wiped.
type TranscriptSummary = {
  pilot_session_id: string;
  app_session_id: string | null;
  title: string | null;
  name: string | null;
  model_id: string | null;
  workspace_root: string | null;
  created_at: string | null;
  updated_at: string | null;
  prompt: string | null;
  latest_text: string | null;
  latest_seq: number;
  event_count: number;
};

export const privileged = definePrivilegedContracts({
  resolvePilotUrl: {
    request: z.object({}),
    response: z.object({ baseUrl: z.string().url() }),
    timeoutMs: 5_000,
  },
  listTranscripts: {
    request: z.object({}),
    response: z.object({
      transcripts: z.array(z.object({
        pilot_session_id: z.string(),
        app_session_id: z.string().nullable(),
        title: z.string().nullable(),
        name: z.string().nullable(),
        model_id: z.string().nullable(),
        workspace_root: z.string().nullable(),
        created_at: z.string().nullable(),
        updated_at: z.string().nullable(),
        prompt: z.string().nullable(),
        latest_text: z.string().nullable(),
        latest_seq: z.number().int().nonnegative(),
        event_count: z.number().int().nonnegative(),
      })),
    }),
    timeoutMs: 15_000,
  },
  readTranscript: {
    request: z.object({ pilot_session_id: z.string().min(1).max(200) }),
    response: z.object({
      found: z.boolean(),
      // Raw pilot stream events, in file order. Parsed loosely here; the
      // action layer translates them with the same helpers as live sync.
      events: z.array(z.record(z.string(), z.unknown())),
    }),
    timeoutMs: 30_000,
  },
});

type Runtime = typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

function pilotStateDir(): string {
  const env = (globalThis as Runtime).process?.env ?? {};
  const configured = env.MUSE_CODE_SPACE_PILOT_STATE_DIR?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const home = env.HOME?.trim() || "/home/hatch";
  return `${home}/workspace/muse-code-space-pilot/state`;
}

function transcriptPath(pilotSessionId: string): string {
  return `${pilotStateDir()}/events-${pilotSessionId}.jsonl`;
}

type LooseEvent = Record<string, unknown>;

function parseLine(line: string): LooseEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseEvent) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function itemOf(event: LooseEvent): LooseEvent | null {
  const item = event.item;
  return item && typeof item === "object" && !Array.isArray(item) ? (item as LooseEvent) : null;
}

// The first user turn a pilot session receives is wrapped in a "[Code Space]
// You are agent …" preamble ending in a --- separator. The conversation's
// own prompt is what follows it.
function cleanPrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("[Code Space] You are agent")) {
    const marker = "\n---\n\n";
    const at = trimmed.indexOf(marker);
    if (at >= 0) return trimmed.slice(at + marker.length).trim();
  }
  return trimmed;
}

function summarizeTranscript(pilotSessionId: string, raw: string, mtime: Date): TranscriptSummary | null {
  const lines = raw.split("\n").filter((line) => line.trim());
  let meta: LooseEvent | null = null;
  let name: string | null = null;
  let prompt: string | null = null;
  let createdAt: string | null = null;
  let latestSeq = 0;
  // Head: session_started meta, name, and the first real user prompt.
  for (const line of lines.slice(0, 60)) {
    const event = parseLine(line);
    if (!event) continue;
    if (!createdAt) createdAt = asString(event.at);
    if (typeof event.seq === "number" && event.seq > latestSeq) latestSeq = event.seq;
    if (event.type === "session_started" && event.meta && typeof event.meta === "object") {
      meta = event.meta as LooseEvent;
    }
    if (event.type === "name_changed") name = asString(event.name) ?? name;
    const item = itemOf(event);
    if (!prompt && item?.kind === "userMessage" && item.status !== "inProgress") {
      const text = asString(item.text) ?? asString(item.fallbackText);
      if (text) prompt = cleanPrompt(text).slice(0, 20000) || null;
    }
    if (meta && prompt) break;
  }
  // Tail: latest sequence and the last agent text, for the list preview.
  let latestText: string | null = null;
  let updatedAt: string | null = null;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i--) {
    const event = parseLine(lines[i]!);
    if (!event) continue;
    if (typeof event.seq === "number" && event.seq > latestSeq) latestSeq = event.seq;
    if (!updatedAt) updatedAt = asString(event.at);
    const item = itemOf(event);
    if (!latestText && item?.kind === "agentMessage" && item.status !== "inProgress") {
      const text = asString(item.text);
      if (text) latestText = text.slice(0, 500);
    }
    if (latestText && updatedAt) break;
  }
  // A transcript with no conversation in it is not a past conversation.
  if (!prompt && !latestText) return null;
  return {
    pilot_session_id: pilotSessionId,
    app_session_id: meta ? asString(meta.appSessionId) : null,
    title: meta ? asString(meta.title) : null,
    name: name ?? (meta ? asString(meta.name) : null),
    model_id: meta ? asString(meta.modelId) : null,
    workspace_root: meta ? asString(meta.workspaceRoot) : null,
    created_at: (meta ? asString(meta.createdAt) : null) ?? createdAt,
    updated_at: updatedAt ?? mtime.toISOString(),
    prompt,
    latest_text: latestText,
    latest_seq: latestSeq,
    event_count: lines.length,
  };
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  resolvePilotUrl() {
    const runtime = globalThis as Runtime;
    const configured = runtime.process?.env?.MUSE_CODE_SPACE_PILOT_URL?.trim();
    return {
      baseUrl: (configured || "http://127.0.0.1:18791").replace(/\/+$/, ""),
    };
  },

  listTranscripts() {
    const dir = pilotStateDir();
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return { transcripts: [] };
    }
    const transcripts: TranscriptSummary[] = [];
    for (const name of names) {
      const match = /^events-(.+)\.jsonl$/.exec(name);
      if (!match) continue;
      const pilotSessionId = match[1]!;
      try {
        const path = transcriptPath(pilotSessionId);
        const stat = statSync(path);
        if (!stat.isFile() || stat.size === 0) continue;
        // Transcripts are append logs; even a long one is a few MB. Skip
        // anything absurd rather than blowing the response budget.
        if (stat.size > 64 * 1024 * 1024) continue;
        const summary = summarizeTranscript(pilotSessionId, readFileSync(path, "utf8"), stat.mtime);
        if (summary) transcripts.push(summary);
      } catch {
        // One unreadable transcript must not hide the rest.
      }
    }
    transcripts.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return { transcripts };
  },

  readTranscript(args) {
    const path = transcriptPath(args.pilot_session_id);
    if (!existsSync(path)) return { found: false, events: [] };
    let raw: string;
    try {
      const stat = statSync(path);
      if (stat.size > 64 * 1024 * 1024) return { found: false, events: [] };
      raw = readFileSync(path, "utf8");
    } catch {
      return { found: false, events: [] };
    }
    const events: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const event = parseLine(line);
      if (event) events.push(event);
    }
    return { found: true, events };
  },
});

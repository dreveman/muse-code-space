import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { safeTranscriptId, summarizeTranscript, type TranscriptSummary } from "./transcriptRestore.ts";

// One transcript file (events-<pilotSessionId>.jsonl in the pilot's state
// dir) is the durable record of a past conversation. The summaries returned
// by listTranscripts are derived from the files themselves — never from the
// pilot registry or the app database — so the past-conversation list can be
// rebuilt after either store is wiped.

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

// Summaries are cached by file identity: reconcile runs inside
// listSessions (polled every few seconds), and an append-only transcript
// only needs re-summarizing when its size or mtime changes. Unchanged
// files cost one statSync per poll instead of a full read.
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: TranscriptSummary | null }>();
const HEAD_BYTES = 512 * 1024;

function readHead(path: string, size: number): string {
  const bytes = Math.min(size, HEAD_BYTES);
  const buffer = Buffer.alloc(bytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, bytes, 0);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
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
      if (!safeTranscriptId(pilotSessionId)) continue;
      try {
        const path = transcriptPath(pilotSessionId);
        const stat = statSync(path);
        if (!stat.isFile() || stat.size === 0) continue;
        // Transcripts are append logs; even a long one is a few MB. Skip
        // anything absurd rather than blowing the response budget.
        if (stat.size > 64 * 1024 * 1024) continue;
        const cached = summaryCache.get(path);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          if (cached.summary) transcripts.push(cached.summary);
          continue;
        }
        // Only the head is summarized; fall back to a full read when the
        // first prompt lives beyond it (e.g. an oversized first line).
        let summary = summarizeTranscript(pilotSessionId, readHead(path, stat.size), stat.mtime);
        if (!summary && stat.size > HEAD_BYTES) {
          summary = summarizeTranscript(pilotSessionId, readFileSync(path, "utf8"), stat.mtime);
        }
        summaryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
        if (summary) transcripts.push(summary);
      } catch {
        // One unreadable transcript must not hide the rest.
      }
    }
    transcripts.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return { transcripts };
  },

  readTranscript(args) {
    // The id becomes a filename; reject anything that could escape the
    // state dir before touching the filesystem.
    if (!safeTranscriptId(args.pilot_session_id)) return { found: false, events: [] };
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

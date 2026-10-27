/**
 * Muse Code Space — Pi Extension
 *
 * Allows a Pi coding-agent session on a host to act as the Muse Assistant
 * for a local Muse Code Space instance while serving the Code Space Web UI
 * directly from that host.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface PiToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: TParams, ctx?: unknown) => Promise<PiToolResult>;
}

export interface PiCommandContext {
  hasUI?: boolean;
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export interface PiExtensionAPI {
  on: (event: string, handler: (event: unknown, ctx: PiCommandContext) => unknown) => () => void;
  registerTool: <TParams = Record<string, unknown>>(tool: PiToolDefinition<TParams>) => void;
  registerCommand: (
    name: string,
    spec: {
      description: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void> | void;
    },
  ) => void;
  sendMessage: (
    message: { customType: string; content: string; display?: boolean },
    options?: { triggerTurn?: boolean },
  ) => void;
}

export type CodeSpaceExtensionConfig = {
  repoRoot: string;
  stateDir: string;
  pilotUrl: string;
  pilotPort: number;
  webHost: string;
  webPort: number;
  publicHost: string;
  tlsPem: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
  webToken: string;
  assistantName: string;
  userName: string | null;
  autoStart: boolean;
};

const BUILTIN_COMPANIONS: Record<string, { id: string; name: string }> = {
  poppy: { id: "poppy", name: "Poppy" },
  remy: { id: "remy", name: "Remy" },
  tilly: { id: "tilly", name: "Tilly" },
  nova: { id: "nova", name: "Nova" },
  sage: { id: "sage", name: "Sage" },
};

function chooseWritableStateDir(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  repoRoot: string,
): string {
  const candidates = [
    env.MUSE_CODE_SPACE_STATE_DIR?.trim(),
    path.join(homeDir, ".local", "share", "muse-code-space"),
    path.join(repoRoot, ".dev", "code-space-ext"),
    path.join(os.tmpdir(), "muse-code-space"),
  ].filter((c): c is string => Boolean(c));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const probe = path.join(dir, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, "ok", { mode: 0o600 });
      fs.unlinkSync(probe);
      return dir;
    } catch {
      // Try next candidate if sandboxed.
    }
  }
  return candidates[0]!;
}

export function resolveExtensionConfig(env: NodeJS.ProcessEnv = process.env): CodeSpaceExtensionConfig {
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = env.MUSE_CODE_SPACE_ROOT?.trim() || path.resolve(extDir, "../..");
  const homeDir = env.HOME?.trim() || os.homedir();
  const stateDir = chooseWritableStateDir(env, homeDir, repoRoot);

  const pilotPort = Number(env.MUSE_CODE_SPACE_PILOT_PORT ?? 18791);
  const pilotUrl = (env.MUSE_CODE_SPACE_PILOT_URL?.trim() || `http://127.0.0.1:${pilotPort}`).replace(/\/+$/, "");
  const webPort = Number(env.MUSE_CODE_SPACE_PORT ?? env.MUSE_CODE_SPACE_DEV_PORT ?? 4173);
  const webHost = env.MUSE_CODE_SPACE_HOST?.trim() || env.MUSE_CODE_SPACE_DEV_HOST?.trim() || "::";
  const publicHost = env.MUSE_CODE_SPACE_PUBLIC_HOST?.trim() || os.hostname() || "127.0.0.1";

  const tlsPem = env.MUSE_CODE_SPACE_TLS_PEM?.trim() || null;
  const tlsCert = env.MUSE_CODE_SPACE_TLS_CERT?.trim() || tlsPem;
  const tlsKey = env.MUSE_CODE_SPACE_TLS_KEY?.trim() || tlsPem;

  const tokenFile = path.join(stateDir, "web-token");
  let webToken = "";
  if (env.MUSE_CODE_SPACE_WEB_TOKEN !== undefined) {
    webToken = env.MUSE_CODE_SPACE_WEB_TOKEN.trim();
  } else {
    try {
      webToken = fs.readFileSync(tokenFile, "utf8").trim();
    } catch {
      webToken = "";
    }
    if (!webToken) {
      webToken = crypto.randomBytes(24).toString("base64url");
      try {
        fs.writeFileSync(tokenFile, `${webToken}\n`, { mode: 0o600 });
      } catch {
        // Ignore write error on read-only filesystems.
      }
    }
  }

  const assistantName = env.MUSE_CODE_SPACE_ASSISTANT_NAME?.trim() || "Jolly";
  const rawUser = env.MUSE_CODE_SPACE_USER_NAME?.trim() || env.USER?.trim() || os.userInfo().username || null;
  const userName = rawUser ? rawUser.slice(0, 40) : null;
  const autoStart = env.MUSE_CODE_SPACE_AUTO_START !== "false" && env.MUSE_CODE_SPACE_AUTO_START !== "0";

  return {
    repoRoot,
    stateDir,
    pilotUrl,
    pilotPort,
    webHost,
    webPort,
    publicHost,
    tlsPem,
    tlsCert,
    tlsKey,
    webToken,
    assistantName,
    userName,
    autoStart,
  };
}

export function formatPublicWebUrl(cfg: CodeSpaceExtensionConfig): string {
  const hasTls = Boolean(cfg.tlsCert && cfg.tlsKey && fs.existsSync(cfg.tlsCert) && fs.existsSync(cfg.tlsKey));
  const scheme = hasTls ? "https" : "http";
  const base = `${scheme}://${cfg.publicHost}:${cfg.webPort}/`;
  return cfg.webToken ? `${base}?token=${encodeURIComponent(cfg.webToken)}` : base;
}

export function formatLocalActionUrl(cfg: CodeSpaceExtensionConfig): string {
  const hasTls = Boolean(cfg.tlsCert && cfg.tlsKey && fs.existsSync(cfg.tlsCert) && fs.existsSync(cfg.tlsKey));
  const scheme = hasTls ? "https" : "http";
  return `${scheme}://127.0.0.1:${cfg.webPort}/actions`;
}

export async function invokeCodeSpaceAction<T = unknown>(
  cfg: CodeSpaceExtensionConfig,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const url = formatLocalActionUrl(cfg);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.webToken ? { authorization: `Bearer ${cfg.webToken}` } : {}),
    },
    body: JSON.stringify({
      action,
      args,
      actionCallId: `pi-ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { data?: T; error?: unknown };
  if (!res.ok || body.error) {
    throw new Error(typeof body.error === "string" ? body.error : `Action ${action} failed (${res.status})`);
  }
  return body.data as T;
}

export function loadInboxCursor(cursorFile: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorFile, "utf8")) as { cursor?: unknown };
    return typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor) ? parsed.cursor : 0;
  } catch {
    return 0;
  }
}

export function saveInboxCursor(cursorFile: string, cursor: number): void {
  try {
    const tmp = `${cursorFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, cursorFile);
  } catch {
    // Ignore cursor write errors.
  }
}

export function formatInboxPrompt(msg: {
  seq: number;
  from: string;
  text: string;
}): string {
  return [
    `[Muse Code Space message #${msg.seq} from ${msg.from}]`,
    msg.text.trim(),
    "",
    `Reply to ${msg.from} with the \`muse_code_space_send_message\` tool (to: "${msg.from}").`,
  ].join("\n");
}

export function deriveAutomaticSummary(prompt: string): string {
  const firstLine = prompt
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("!["));
  const cleaned = (firstLine ?? prompt).replace(/\s+/g, " ").trim();
  if (!cleaned) return "Coding task";
  return cleaned.length > 100 ? `${cleaned.slice(0, 97)}…` : cleaned;
}

export function readLastLogError(logPath: string): string | null {
  try {
    if (!fs.existsSync(logPath)) return null;
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("at "));
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
      const line = lines[i]!;
      if (/error|failed|not permitted|refused|exception/i.test(line)) {
        return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "").slice(0, 180);
      }
    }
    return lines.at(-1)?.slice(0, 180) ?? null;
  } catch {
    return null;
  }
}

export function formatStartupNotice(status: {
  pilotUp: boolean;
  webUp: boolean;
  webUrl: string;
  pilotUrl: string;
  stateDir: string;
  pilotError?: string | null;
  webError?: string | null;
}): { message: string; level: "info" | "warning" | "error" } {
  if (status.webUp && status.pilotUp) {
    return {
      level: "info",
      message: `Muse Code Space ready: ${status.webUrl}`,
    };
  }
  if (status.webUp && !status.pilotUp) {
    const reason = status.pilotError || `unreachable at ${status.pilotUrl}`;
    return {
      level: "warning",
      message: `Muse Code Space: pilot failed to start (${reason}). Web UI is up at ${status.webUrl} — see ${path.join(status.stateDir, "pilot.log")}`,
    };
  }
  if (!status.webUp && status.pilotUp) {
    const reason = status.webError || "web server unreachable";
    return {
      level: "error",
      message: `Muse Code Space: web server failed to start (${reason}) — see ${path.join(status.stateDir, "web.log")}`,
    };
  }
  const pilotReason = status.pilotError || "down";
  const webReason = status.webError || "down";
  return {
    level: "error",
    message: `Muse Code Space failed to start — pilot: ${pilotReason}; web: ${webReason} (logs in ${status.stateDir})`,
  };
}

async function isHttpReachable(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function museCodeSpaceExtension(pi: PiExtensionAPI) {
  const cfg = resolveExtensionConfig();
  const cursorFile = path.join(cfg.stateDir, "inbox-cursor.json");
  let spawnedPilot: ChildProcess | null = null;
  let spawnedWeb: ChildProcess | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let identitySynced = false;

  const ensureServicesRunning = async (): Promise<{ pilotUp: boolean; webUp: boolean }> => {
    let pilotUp = await isHttpReachable(`${cfg.pilotUrl}/health`);
    if (!pilotUp && cfg.autoStart) {
      const pilotDir = path.join(cfg.repoRoot, "pilot");
      const pilotScript = path.join(pilotDir, "pilot.mjs");
      if (fs.existsSync(pilotScript)) {
        const sdkDir = path.join(pilotDir, "node_modules", "@muse-code", "sdk");
        if (!fs.existsSync(sdkDir)) {
          spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
            cwd: pilotDir,
            stdio: "ignore",
          });
        }
        const pilotStateDir = path.join(cfg.stateDir, "pilot-state");
        fs.mkdirSync(pilotStateDir, { recursive: true, mode: 0o700 });
        const logFd = fs.openSync(path.join(cfg.stateDir, "pilot.log"), "w");
        spawnedPilot = spawn("node", [pilotScript], {
          cwd: cfg.repoRoot,
          env: {
            ...process.env,
            MUSE_CODE_SPACE_PILOT_PORT: String(cfg.pilotPort),
            MUSE_CODE_SPACE_RELAY_URL: process.env.MUSE_CODE_SPACE_RELAY_URL ?? "none",
            MUSE_CODE_SPACE_PILOT_STATE_DIR: pilotStateDir,
          },
          stdio: ["ignore", logFd, logFd],
          detached: true,
        });
        spawnedPilot.unref();
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 300));
          pilotUp = await isHttpReachable(`${cfg.pilotUrl}/health`);
          if (pilotUp) break;
        }
      }
    }

    const webCheckUrl = formatLocalActionUrl(cfg).replace(/\/actions$/, "/");
    const authHeaders = cfg.webToken ? { authorization: `Bearer ${cfg.webToken}` } : undefined;
    let webUp = await isHttpReachable(webCheckUrl, authHeaders);
    if (!webUp && cfg.autoStart) {
      const serverScript = path.join(cfg.repoRoot, "dev", "server.ts");
      if (fs.existsSync(serverScript)) {
        const webDir = path.join(cfg.stateDir, "web-build");
        const dbPath = path.join(cfg.stateDir, "app.db");
        fs.mkdirSync(webDir, { recursive: true, mode: 0o700 });
        const logFd = fs.openSync(path.join(cfg.stateDir, "web.log"), "w");
        spawnedWeb = spawn("bun", [serverScript], {
          cwd: cfg.repoRoot,
          env: {
            ...process.env,
            MUSE_CODE_SPACE_PILOT_URL: cfg.pilotUrl,
            MUSE_CODE_SPACE_DEV_HOST: cfg.webHost,
            MUSE_CODE_SPACE_DEV_PORT: String(cfg.webPort),
            MUSE_CODE_SPACE_DEV_DIR: webDir,
            MUSE_CODE_SPACE_DEV_DB: dbPath,
            MUSE_CODE_SPACE_WEB_TOKEN: cfg.webToken,
            ...(cfg.tlsCert ? { MUSE_CODE_SPACE_TLS_CERT: cfg.tlsCert } : {}),
            ...(cfg.tlsKey ? { MUSE_CODE_SPACE_TLS_KEY: cfg.tlsKey } : {}),
          },
          stdio: ["ignore", logFd, logFd],
          detached: true,
        });
        spawnedWeb.unref();
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 350));
          webUp = await isHttpReachable(webCheckUrl, authHeaders);
          if (webUp) break;
        }
      }
    }

    return { pilotUp, webUp };
  };

  const syncIdentityAndPollInbox = async () => {
    if (polling) return;
    polling = true;
    try {
      await ensureServicesRunning();
      if (!identitySynced) {
        try {
          await invokeCodeSpaceAction(cfg, "setAssistantIdentity", {
            name: cfg.assistantName,
            ...(cfg.userName ? { user_name: cfg.userName } : {}),
          });
          identitySynced = true;
        } catch {
          // Will retry on next tick when web/pilot are up.
        }
      }

      // Check for incoming messages addressed to the Muse assistant.
      const since = loadInboxCursor(cursorFile);
      let inbox = await invokeCodeSpaceAction<{
        ok: boolean;
        messages: Array<{
          seq: number;
          at: string;
          from: string;
          text: string;
        }>;
        latest: number;
        error: string | null;
      }>(cfg, "readMuseMessages", { since });

      if (inbox?.ok && typeof inbox.latest === "number" && inbox.latest < since) {
        saveInboxCursor(cursorFile, 0);
        inbox = await invokeCodeSpaceAction(cfg, "readMuseMessages", { since: 0 });
      }

      if (inbox?.ok && Array.isArray(inbox.messages) && inbox.messages.length > 0) {
        for (const msg of inbox.messages) {
          saveInboxCursor(cursorFile, msg.seq);
          pi.sendMessage(
            {
              customType: "muse-code-space-inbox",
              content: formatInboxPrompt(msg),
              display: true,
            },
            { triggerTurn: true },
          );
        }
      }

      // Sync pilot events and backfill missing task summaries for active sessions.
      const list = await invokeCodeSpaceAction<{
        sessions: Array<{
          id: string;
          status: string;
          archived: boolean;
          prompt: string;
          session_summary: string | null;
        }>;
      }>(cfg, "listSessions", { limit: 50 });

      for (const session of list?.sessions ?? []) {
        if (!session.archived && (session.status === "queued" || session.status === "running")) {
          try {
            await invokeCodeSpaceAction(cfg, "syncPilotEvents", { session_id: session.id });
          } catch {
            // ignore
          }
        }
        if (!session.session_summary && session.prompt?.trim()) {
          await invokeCodeSpaceAction(cfg, "setSessionSummary", {
            id: session.id,
            summary: deriveAutomaticSummary(session.prompt),
          });
        }
      }
    } catch {
      // Transient connectivity errors are retried on the next poll.
    } finally {
      polling = false;
    }
  };

  // ---- Register Tools (muse_code_space_*) ----

  pi.registerTool({
    name: "muse_code_space_status",
    label: "Code Space Status",
    description:
      "Check the status of the local Muse Code Space web interface, pilot daemon, assistant identity, and active companion tasks on this host.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const { pilotUp, webUp } = await ensureServicesRunning();
      const webUrl = formatPublicWebUrl(cfg);
      let activeCount = 0;
      let totalCount = 0;
      if (webUp) {
        try {
          const list = await invokeCodeSpaceAction<{
            sessions: Array<{ archived: boolean }>;
            active_count: number;
          }>(cfg, "listSessions", { limit: 100 });
          activeCount = list.active_count;
          totalCount = list.sessions.length;
        } catch {
          // ignore
        }
      }
      const details = {
        webUrl,
        pilotUrl: cfg.pilotUrl,
        pilotUp,
        webUp,
        assistantName: cfg.assistantName,
        userName: cfg.userName,
        activeCount,
        totalCount,
      };
      const text = [
        `Web UI URL: ${webUrl}`,
        `Web Server: ${webUp ? "running" : "down"}`,
        `Pilot (${cfg.pilotUrl}): ${pilotUp ? "running" : "down"}`,
        `Assistant Identity: @${cfg.assistantName}${cfg.userName ? ` (user: ${cfg.userName})` : ""}`,
        `Companion Tasks: ${activeCount} active (${totalCount} total)`,
      ].join("\n");
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerTool<{ include_archived?: boolean }>({
    name: "muse_code_space_list_tasks",
    label: "List Code Space Tasks",
    description:
      "List companion tasks in Muse Code Space on this host, including companion name, task ID, status, summary, and workspace path.",
    parameters: {
      type: "object",
      properties: {
        include_archived: {
          type: "boolean",
          description: "Include archived (past) tasks as well as active tasks (default false).",
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params) {
      await ensureServicesRunning();
      const data = await invokeCodeSpaceAction<{
        sessions: Array<{
          id: string;
          title: string;
          status: string;
          archived: boolean;
          session_summary: string | null;
          prompt: string;
          workspace_root: string;
          updated_at: string;
        }>;
      }>(cfg, "listSessions", { limit: 100 });
      const filtered = (data.sessions ?? []).filter((s) => params.include_archived || !s.archived);
      if (filtered.length === 0) {
        return {
          content: [{ type: "text", text: "No companion tasks found." }],
          details: { tasks: [] },
        };
      }
      const lines = filtered.map((s) => {
        const summary = s.session_summary?.trim() || deriveAutomaticSummary(s.prompt);
        return `- ${s.title} (${s.id}) [${s.archived ? "archived" : s.status}]: ${summary} — ${s.workspace_root}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { tasks: filtered },
      };
    },
  });

  pi.registerTool<{ task_id: string; event_limit?: number }>({
    name: "muse_code_space_read_task",
    label: "Read Code Space Task",
    description: "Read the details and recent transcript events of a Muse Code Space companion task by task ID.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The session/task ID from muse_code_space_list_tasks." },
        event_limit: {
          type: "number",
          description: "Maximum number of recent transcript events to return (default 40).",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await ensureServicesRunning();
      try {
        await invokeCodeSpaceAction(cfg, "syncPilotEvents", { session_id: params.task_id });
      } catch {
        // ignore
      }
      const limit = Math.max(1, Math.min(200, Math.floor(params.event_limit ?? 40)));
      const data = await invokeCodeSpaceAction<{
        session: {
          id: string;
          title: string;
          status: string;
          session_summary: string | null;
          workspace_root: string;
        } | null;
        events: Array<{
          id: number;
          kind: string;
          content: string;
          created_at: string;
        }>;
      }>(cfg, "getSession", { id: params.task_id, event_limit: limit });
      if (!data.session) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.task_id}` }],
          details: undefined,
          isError: true,
        };
      }
      const tail = data.events.slice(-limit);
      const formattedEvents = tail
        .map((e) => `[${e.kind}] ${e.content.slice(0, 600)}`)
        .join("\n\n");
      const text = [
        `Companion: ${data.session.title} (${data.session.id})`,
        `Status: ${data.session.status}`,
        `Summary: ${data.session.session_summary ?? "(none)"}`,
        `Workspace: ${data.session.workspace_root}`,
        "",
        formattedEvents || "(No transcript events yet.)",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { session: data.session, eventCount: tail.length },
      };
    },
  });

  pi.registerTool<{ to: string; message: string }>({
    name: "muse_code_space_send_message",
    label: "Message Code Space Companion",
    description:
      "Send a message as the Muse Assistant into an active Code Space companion conversation (by companion name such as 'Poppy' or by task ID). Wakes the companion to process your message.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient companion name (e.g. 'Poppy', 'Remy') or session/task ID.",
        },
        message: {
          type: "string",
          description: "Message content to send to the companion.",
        },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await ensureServicesRunning();
      const res = await invokeCodeSpaceAction<{
        ok: boolean;
        to: string | null;
        queued: boolean;
        error: string | null;
      }>(cfg, "sendAgentMessage", {
        to: params.to,
        text: params.message,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Failed to send message: ${res.error ?? "unknown error"}` }],
          details: res,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Sent message to ${res.to ?? params.to}${res.queued ? " [queued for next turn]" : ""}.`,
          },
        ],
        details: res,
      };
    },
  });

  pi.registerTool<{
    companion: string;
    prompt: string;
    workspace_root?: string;
    repo?: string;
    summary?: string;
  }>({
    name: "muse_code_space_start_task",
    label: "Start Code Space Companion Task",
    description:
      "Start a new companion task in Muse Code Space on this host with a chosen companion (e.g. Poppy, Remy, Tilly, Nova, Sage), initial prompt, and optional workspace path under ~/workspace or GitHub repo (owner/repo).",
    parameters: {
      type: "object",
      properties: {
        companion: {
          type: "string",
          description: "Companion name or ID (Poppy, Remy, Tilly, Nova, Sage).",
        },
        prompt: {
          type: "string",
          description: "Initial task instructions for the companion.",
        },
        workspace_root: {
          type: "string",
          description:
            "Optional path under ~/workspace (e.g. '~/workspace/code/my-task'). Defaults to a generated '~/workspace/code/...' path.",
        },
        repo: {
          type: "string",
          description: "Optional GitHub repository to clone ('owner/repo').",
        },
        summary: {
          type: "string",
          description: "Optional short task title/summary.",
        },
      },
      required: ["companion", "prompt"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await ensureServicesRunning();
      const key = params.companion.trim().toLowerCase();
      const match = BUILTIN_COMPANIONS[key] ?? { id: key, name: params.companion.trim() };
      const sessionId = crypto.randomUUID();
      const shortToken = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${sessionId.slice(0, 6)}`;
      const defaultWorkspace = `~/workspace/code/${shortToken}`;
      const rawWorkspace = params.workspace_root?.trim();
      const workspaceRoot =
        rawWorkspace && (rawWorkspace.startsWith("~/workspace") || rawWorkspace.includes("/workspace/"))
          ? rawWorkspace
          : defaultWorkspace;
      const created = await invokeCodeSpaceAction<{
        ok: boolean;
        id: string | null;
        start_status: string | null;
        error: string | null;
      }>(cfg, "createSession", {
        session_id: sessionId,
        title: match.name,
        prompt: params.prompt,
        workspaceRoot,
        ...(params.repo?.trim() ? { repo: params.repo.trim() } : {}),
      });
      if (!created.ok || !created.id) {
        return {
          content: [{ type: "text", text: `Failed to start task: ${created.error ?? "unknown error"}` }],
          details: created,
          isError: true,
        };
      }
      const summary = params.summary?.trim() || deriveAutomaticSummary(params.prompt);
      await invokeCodeSpaceAction(cfg, "setSessionSummary", {
        id: created.id,
        summary,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started ${match.name} on task ${created.id} in ${workspaceRoot} (status: ${created.start_status ?? "started"}).`,
          },
        ],
        details: { sessionId: created.id, companion: match.name, workspaceRoot, startStatus: created.start_status },
      };
    },
  });

  pi.registerTool<{
    task_id: string;
    summary?: string;
    archived?: boolean;
    compact_context?: boolean;
  }>({
    name: "muse_code_space_update_task",
    label: "Update Code Space Task",
    description:
      "Update a companion task's summary, archive/restore state, or compact its conversation context.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The session/task ID." },
        summary: { type: "string", description: "New short summary for the task." },
        archived: { type: "boolean", description: "Set true to archive or false to restore." },
        compact_context: { type: "boolean", description: "Set true to compact the task's context window." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await ensureServicesRunning();
      const updates: string[] = [];
      if (params.summary !== undefined) {
        const res = await invokeCodeSpaceAction<{ ok: boolean; error: string | null }>(cfg, "setSessionSummary", {
          id: params.task_id,
          summary: params.summary.trim() || null,
        });
        if (!res.ok) throw new Error(res.error ?? "Failed to update summary");
        updates.push("summary updated");
      }
      if (params.archived !== undefined) {
        const res = await invokeCodeSpaceAction<{ ok: boolean; error: string | null }>(cfg, "setSessionArchived", {
          id: params.task_id,
          archived: params.archived,
        });
        if (!res.ok) throw new Error(res.error ?? "Failed to update archive state");
        updates.push(params.archived ? "archived" : "restored");
      }
      if (params.compact_context) {
        const res = await invokeCodeSpaceAction<{ ok: boolean; error: string | null }>(cfg, "compactContext", {
          session_id: params.task_id,
        });
        if (!res.ok) throw new Error(res.error ?? "Failed to compact context");
        updates.push("context compacted");
      }
      return {
        content: [
          {
            type: "text",
            text: `Task ${params.task_id}: ${updates.join(", ") || "no changes requested"}.`,
          },
        ],
        details: { taskId: params.task_id, updates },
      };
    },
  });

  // ---- Register /code-space Command ----

  pi.registerCommand("code-space", {
    description: "Show Muse Code Space Web UI URL and status (or /code-space restart | stop)",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "stop") {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        spawnedWeb?.kill();
        spawnedPilot?.kill();
        ctx.ui.notify("Stopped Muse Code Space background polling and spawned services.", "info");
        return;
      }
      if (sub === "restart") {
        spawnedWeb?.kill();
        spawnedPilot?.kill();
        identitySynced = false;
      }
      const { pilotUp, webUp } = await ensureServicesRunning();
      void syncIdentityAndPollInbox();
      const notice = formatStartupNotice({
        pilotUp,
        webUp,
        webUrl: formatPublicWebUrl(cfg),
        pilotUrl: cfg.pilotUrl,
        stateDir: cfg.stateDir,
        pilotError: pilotUp ? null : readLastLogError(path.join(cfg.stateDir, "pilot.log")),
        webError: webUp ? null : readLastLogError(path.join(cfg.stateDir, "web.log")),
      });
      ctx.ui.notify(notice.message, notice.level);
    },
  });

  // ---- Lifecycle Hooks ----

  pi.on("session_start", async (_event, ctx) => {
    const { pilotUp, webUp } = await ensureServicesRunning();
    void syncIdentityAndPollInbox();
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void syncIdentityAndPollInbox();
      }, 3000);
    }
    if (ctx?.hasUI) {
      const notice = formatStartupNotice({
        pilotUp,
        webUp,
        webUrl: formatPublicWebUrl(cfg),
        pilotUrl: cfg.pilotUrl,
        stateDir: cfg.stateDir,
        pilotError: pilotUp ? null : readLastLogError(path.join(cfg.stateDir, "pilot.log")),
        webError: webUp ? null : readLastLogError(path.join(cfg.stateDir, "web.log")),
      });
      ctx.ui.notify(notice.message, notice.level);
    }
  });

  pi.on("session_shutdown", () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

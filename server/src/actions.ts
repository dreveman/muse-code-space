import { defineAction, z, type ActionsModule, type Ctx, type PrivilegedExecutor } from "@hatch/space-sdk";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { privileged } from "@space/privileged";
import {
buildUserInputAnswers,
type AgentsRow,
pilotBackendChanged,
pilotItemText,
pilotReasoningSummary,
pilotAgentsRow,
pilotItemTime,
pilotSystemText,
pilotToolLabel,
pilotTurnCancelled,
pilotTurnOutcomeError,
type PilotItem,
type UserInputQuestionShape,
} from "./pilotEvents";
import { buildProjectBriefing } from "./projectBriefing";
import { isGeneratedWorkspaceRoot, shortWorkspaceToken } from "./generatedWorkspace";
import { countsAsUnread } from "./transcriptVisibility";
import { parseToolDetails, toolDetailsFromItem, type ToolDetails } from "./toolDetails";
import { ownedArtifactPaths } from "./ownedArtifacts";
import { ownedPullRequestsFromEvents } from "./ownedPullRequests";
import {
  applyPrMonitorSnapshot,
  createdPullRequestFromToolEvent,
  summarizeCompanionStatistics,
  type TrackedPr,
} from "./companionStatistics";
import { validateAssistantAvatar } from "./assistantAvatar.mjs";
import { pilotRequest, isPilotUnavailable, readPilotModels } from "./pilotRequest";
import { parseRepoSlug } from "./repoSlug";
import { companionModelAccess, modelUpgradeMessage, PAID_COMPANION_MODELS } from "./companionModels";
import { isReservedAgentName } from "./agentNames";
import { transcriptToRows, type TranscriptImport } from "./transcriptRestore";
import * as schema from "./schema";
import companionCatalog from "../../companions/catalog.json" with { type: "json" };
import poppySoul from "../../companions/poppy/SOUL.md" with { type: "text" };
import remySoul from "../../companions/remy/SOUL.md" with { type: "text" };
import tillySoul from "../../companions/tilly/SOUL.md" with { type: "text" };
import novaSoul from "../../companions/nova/SOUL.md" with { type: "text" };
import sageSoul from "../../companions/sage/SOUL.md" with { type: "text" };

// Built-in SOUL.md texts, bundled so session starts can inject them into
// the pilot's first turn wherever the actions bundle runs.
const BUILTIN_SOULS: Readonly<Record<string, string>> = {
  poppy: poppySoul, remy: remySoul, tilly: tillySoul, nova: novaSoul, sage: sageSoul,
};

const statusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "stopped",
]);
const eventKindSchema = z.enum(["stdout", "stderr", "system", "result", "user", "tool", "agents", "message", "thinking", "pr_monitor"]);
const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const ownedPrSchema = z.object({
  key: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string().nullable(),
  url: z.string(),
  branchLine: z.string().nullable(),
  draft: z.boolean(),
  state: z.enum(["open", "merged", "closed"]),
  checks: z.enum(["pending", "success", "failure", "none"]).nullable(),
  checksSummary: z.string().nullable(),
  latestChange: z.string().nullable(),
  monitoring: z.boolean(),
});

const sessionResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  workspace_root: z.string(),
  pilot_session_id: z.string().nullable(),
  model_id: z.string(),
  reasoning_effort: reasoningEffortSchema,
  status: statusSchema,
  summary: z.string().nullable(),
  session_summary: z.string().nullable(),
  started_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
  archived: z.boolean(),
  archived_at: z.string().nullable(),
  restored_at: z.string().nullable(),
  needs_you: z.boolean(),
  output_revision: z.number().int().nonnegative(),
  seen_output_revision: z.number().int().nonnegative(),
  output_count: z.number(),
  latest_output: z.string().nullable(),
  project_id: z.string().nullable(),
  repo_slug: z.string().nullable(),
  git_author: z.object({ name: z.string(), email: z.string() }).nullable().optional(),
  preview_port: z.number().int().nullable().optional(),
  owned_prs: z.array(ownedPrSchema).optional(),
});

const userAttachmentResponseSchema = z.object({
  name: z.string(),
  mediaType: z.string(),
  dataUrl: z.string(),
});

function serializeUserAttachments(attachments: readonly PilotAttachmentInput[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  return JSON.stringify(
    attachments.map((att) => ({
      name: att.name,
      mediaType: att.mediaType,
      dataUrl: `data:${att.mediaType};base64,${att.base64Data}`,
    })),
  );
}

function parseUserAttachments(raw: string | null): Array<{ name: string; mediaType: string; dataUrl: string }> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const valid = parsed.filter(
      (item): item is { name: string; mediaType: string; dataUrl: string } =>
        Boolean(item && typeof item.name === "string" && typeof item.mediaType === "string" && typeof item.dataUrl === "string"),
    );
    return valid.length > 0 ? valid : undefined;
  } catch {
    return undefined;
  }
}

const eventResponseSchema = z.object({
  id: z.number(),
  kind: eventKindSchema,
  content: z.string(),
  created_at: z.string(),
  system_is_error: z.boolean(),
  // Tool rows: when the tool started/finished (null while running, or for
  // rows recorded before timing existed).
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  tool_details: z.object({
    tool: z.string().nullable(),
    status: z.string().nullable(),
    args: z.string().nullable(),
    output: z.string().nullable(),
    failureReason: z.string().nullable(),
    truncated: z.boolean(),
    outputRef: z.object({ id: z.string(), byteLen: z.number().int().nonnegative(), availability: z.string(), mediaType: z.string().nullable(), kind: z.string().nullable() }).nullable(),
    patchRef: z.object({ id: z.string(), byteLen: z.number().int().nonnegative(), availability: z.string(), mediaType: z.string().nullable(), kind: z.string().nullable() }).nullable(),
    patchSummary: z.object({ files: z.number().int().nonnegative(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).nullable(),
  }).nullable(),
  attachments: z.array(userAttachmentResponseSchema).optional(),
});

const createSessionResponseSchema = z.object({
  ok: z.boolean(),
  retryable: z.boolean().optional(),
  id: z.string().nullable(),
  start_status: z.enum(["waking", "waiting", "fallback"]).nullable(),
  error: z.string().nullable(),
});

const modelResponseSchema = z.object({
  id: z.string(),
  display_name: z.string(),
});

const syncModelsResponseSchema = z.object({
  ok: z.literal(true),
  count: z.number().int().nonnegative(),
});

const pilotSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().nullable(),
  // The canonical name Muse settled for the agent (null if it rejected it).
  name: z.string().nullable().optional(),
  // The model the pilot actually used (its catalog default when none was
  // sent). Optional: older pilots don't report it.
  modelId: z.string().min(1).optional(),
});

const pilotTurnResponseSchema = z.object({
  turnId: z.string().min(1),
  admitMs: z.number().nonnegative(),
  modelSwitched: z.boolean(),
  modelId: z.string().min(1),
});

const pilotPollResponseSchema = z.object({
  events: z.array(z.object({
    seq: z.number().int().nonnegative(),
    type: z.string(),
    at: z.string().optional(),
    text: z.string().optional(),
    item: z.object({
      kind: z.string(),
      itemId: z.string().optional(),
      recordedAt: z.string().optional(),
      // workflow / subagent items (agent-to-agent work)
      workflowRunId: z.string().optional(),
      entryId: z.string().optional(),
      message: z.string().optional(),
      children: z.array(z.object({
        childId: z.string().optional(),
        attempt: z.number().optional(),
        label: z.string().optional(),
        status: z.string().optional(),
        phase: z.string().optional(),
        durationMs: z.number().optional(),
        terminal: z.string().optional(),
      })).optional(),
      subagentId: z.string().optional(),
      objective: z.string().optional(),
      role: z.string().optional(),
      controlStatus: z.string().optional(),
      result: z.object({ summary: z.string().optional(), text: z.string().optional(), errorKind: z.string().optional() }).optional(),
      failureReason: z.string().optional(),
      text: z.string().optional(),
      fallbackText: z.string().optional(),
      summary: z.array(z.string()).optional(),
      status: z.string().optional(),
      tool: z.string().optional(),
      args: z.string().optional(),
      visibleOutput: z.string().optional(),
      truncated: z.boolean().optional(),
      outputRef: z.object({
        id: z.string(), byteLen: z.number().int().nonnegative(), availability: z.string(),
        mediaType: z.string().optional(), kind: z.string().optional(),
      }).optional(),
      patchRef: z.object({
        id: z.string(), byteLen: z.number().int().nonnegative(), availability: z.string(),
        mediaType: z.string().optional(), kind: z.string().optional(),
      }).optional(),
      patchSummary: z.object({ files: z.number().int().nonnegative(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).optional(),
    }).optional(),
    error: z.unknown().optional(),
    outcome: z.unknown().optional(),
    cancelled: z.boolean().optional(),
    // name_changed: Muse's name for the agent changed.
    name: z.string().optional(),
    // agent_message: a message between agents (or from/to the user's Muse).
    direction: z.enum(["in", "out"]).optional(),
    messageId: z.string().optional(),
    from: z.object({ kind: z.string(), name: z.string(), color: z.string().optional(), sessionId: z.string().nullable().optional() }).optional(),
    to: z.object({ kind: z.string(), name: z.string(), color: z.string().optional(), sessionId: z.string().nullable().optional() }).optional(),
    queued: z.boolean().optional(),
    // pr_monitor: the pilot's background PR monitor row (upserted by id).
    monitor: z.object({
      id: z.string(), owner: z.string(), repo: z.string(), number: z.number().int(),
      title: z.string(), url: z.string(), status: z.string(),
      checks: z.object({ passed: z.number(), failed: z.number(), pending: z.number(), failing: z.array(z.string()) }),
      approvals: z.number(), comments: z.number(),
      additions: z.number().nullable().optional(), deletions: z.number().nullable().optional(), filesChanged: z.number().nullable().optional(),
      changes: z.array(z.object({ at: z.string(), text: z.string() })),
      startedAt: z.string(), updatedAt: z.string(),
    }).optional(),
  })),
  latestSeq: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  backendSessionId: z.string().nullable().optional(),
  hasOpenTurn: z.boolean().optional(),
});

const pilotUserInputQuestionSchema = z.object({
  id: z.string(),
  header: z.string().optional(),
  question: z.string().optional(),
  selection: z.object({
    mode: z.string(),
    minSelections: z.number().int().optional(),
    maxSelections: z.number().int().optional(),
  }),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional(),
  })).optional(),
});

const pilotUserInputsResponseSchema = z.object({
  inputs: z.array(z.object({
    userInputId: z.string(),
    turnId: z.string().nullable().optional(),
    autoResolutionMs: z.number().nullable().optional(),
    questions: z.array(pilotUserInputQuestionSchema),
  })),
});

const userInputAnswerSchema = z.object({
  questionId: z.string().min(1).max(200),
  selectedLabels: z.array(z.string().max(500)).max(20).optional(),
  freeText: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
});

const syncPilotEventsResponseSchema = z.object({
  added: z.number().int().nonnegative(),
  status: statusSchema,
  // Null for a queued first prompt with no pilot id yet. Pilot outages must
  // be distinguishable from healthy, empty polls while the app DB stays up.
  pilot_available: z.boolean().nullable(),
});

const wireDebugEntrySchema = z.object({
  at: z.string(),
  dir: z.string(),
  method: z.string(),
  ms: z.number().optional(),
  ok: z.boolean().optional(),
  params: z.string().optional(),
  error: z.string().optional(),
});

const wireDebugGetResponseSchema = z.object({
  enabled: z.boolean(),
  entries: z.array(wireDebugEntrySchema),
});

const relayDebugResponseSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(["up", "down", "disabled"]),
  entries: z.array(z.object({
    id: z.number().int().nonnegative(), at: z.string(), method: z.string(), path: z.string(),
    status: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(),
    requestBytes: z.number().int().nonnegative(), responseBytes: z.number().int().nonnegative(),
    stage: z.string(), errorType: z.string().nullable(),
  })).max(100),
  startedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  error: z.string().nullable(),
});

const projectReferenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  target: z.string(),
});

const customCompanionResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon_id: z.string(),
  icon_data_url: z.string().nullable(),
  character: z.string(),
  role: z.string(),
  description: z.string(),
  skills: z.array(z.string()),
  trade_off: z.string(),
  soul: z.string(),
  model_id: z.string(),
  effort: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const projectResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  briefing: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  references: z.array(projectReferenceSchema),
  session_count: z.number().int().nonnegative(),
});

type SessionStatus = z.infer<typeof statusSchema>;
type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
type PilotEvent = {
  seq: number;
  type: string;
  at?: string;
  text?: string;
  item?: PilotItem;
  error?: unknown;
  outcome?: unknown;
  cancelled?: boolean;
  name?: string;
  direction?: "in" | "out";
  messageId?: string;
  from?: { kind: string; name: string; color?: string; sessionId?: string | null };
  to?: { kind: string; name: string; color?: string; sessionId?: string | null };
  queued?: boolean;
  monitor?: {
    id: string; owner: string; repo: string; number: number;
    title: string; url: string; status: string;
    checks: { passed: number; failed: number; pending: number; failing: string[] };
    approvals: number; comments: number;
    changes: Array<{ at: string; text: string }>;
    startedAt: string; updatedAt: string;
  };
};
type PilotPoll = {
  events: PilotEvent[];
  latestSeq: number;
  sessionId?: string;
  backendSessionId?: string | null;
  hasOpenTurn?: boolean;
};
type PilotAttachmentInput = {
  name: string;
  mediaType: string;
  base64Data: string;
};

type PilotTurnBody = {
  text: string;
  ifBusy: string;
  reasoningEffort: ReasoningEffort;
  modelId: string;
  attachments?: readonly PilotAttachmentInput[];
};

const attachmentInputSchema = z.object({
  name: z.string().trim().min(1).max(260),
  mediaType: z.string().trim().regex(/^image\/[a-z0-9.+-]+$/i),
  base64Data: z.string().min(1).max(15_000_000),
});


function pilotErrorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 200000);
  try {
    const encoded = JSON.stringify(error);
    if (encoded && encoded !== "{}") return encoded.slice(0, 200000);
  } catch {
    // Fall through to a stable user-facing message.
  }
  return "Muse Code reported an error while running this turn.";
}

function pilotRequestErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();
    if (/^pilot (?:is resuming sessions|not connected)/i.test(message)) return "Connecting to Muse Code. Try again shortly.";
    if (/^credential relay unavailable/i.test(message)) return "Model connection unavailable. Try again shortly.";
    return message.slice(0, 20000);
  }
  return "Muse Code could not accept the message. Try again.";
}

function isUnknownPilotSession(error: unknown): boolean {
  if (error instanceof Error) {
    if ((error as Error & { code?: string }).code === "unknown_session") return true;
    if (/unknown session/i.test(error.message)) return true;
  }
  return false;
}

// Submit a turn, recovering the pilot backend session inline when the serve
// host no longer knows it (post-restart). The app session row is never
// replaced: recovery reuses the same app-visible id, so the UI keeps one
// continuous session instead of a duplicate "continued" copy.
async function postPilotTurnWithRecovery(
  baseUrl: string,
  pilotSessionId: string,
  body: PilotTurnBody,
): Promise<z.infer<typeof pilotTurnResponseSchema>> {
  await requirePaidModelAccess(baseUrl, body.modelId);
  const path = `/sessions/${encodeURIComponent(pilotSessionId)}/turns`;
  const init: RequestInit = { method: "POST", body: JSON.stringify(body) };
  try {
    return await pilotRequest(baseUrl, path, init, pilotTurnResponseSchema);
  } catch (error) {
    if (!isUnknownPilotSession(error)) throw error;
    await pilotRequest(
      baseUrl,
      `/sessions/${encodeURIComponent(pilotSessionId)}/recover`,
      { method: "POST" },
      z.object({ sessionId: z.string().min(1), recovered: z.boolean() }),
    );
    return await pilotRequest(baseUrl, path, init, pilotTurnResponseSchema);
  }
}

function legacyPrompt(content: string, modelId: string, effort: ReasoningEffort): string {
  return `[Model: ${modelId} | Effort: ${effort}]\n\n${content}`;
}

// Home folder on the machine the pilot (and muse serve) runs on; workspace
// paths are paths there. The VM is /home/hatch. The artifact platform forbids
// the `process` global in action handlers, so dev/server.ts passes its local
// override on globalThis before importing this module.
const configuredHomeRoot = (globalThis as { __MUSE_CODE_SPACE_HOME_ROOT__?: string }).__MUSE_CODE_SPACE_HOME_ROOT__
  ?.trim()
  .replace(/\/+$/, "");
const HOME_ROOT = configuredHomeRoot && configuredHomeRoot.startsWith("/") ? configuredHomeRoot : "/home/hatch";
const WORKSPACE_ROOT = `${HOME_ROOT}/workspace`;
// Placeholder model id stored before the pilot reports the one it chose.
const FALLBACK_MODEL_ID = "muse-spark-1.3";
const companionAssignmentLocks = new Set<string>();
function lockCompanionAssignment(taskId: string, name: string): (() => void) | null {
  const keys = [`task:${taskId}`, `companion:${name.trim().toLowerCase()}`];
  if (keys.some((key) => companionAssignmentLocks.has(key))) return null;
  keys.forEach((key) => companionAssignmentLocks.add(key));
  return () => keys.forEach((key) => companionAssignmentLocks.delete(key));
}

function companionIsFreeCondition(taskId: string, name: string) {
  return sql`not exists (select 1 from sessions as occupied where occupied.id <> ${taskId} and occupied.archived = 0 and lower(trim(occupied.title)) = ${name.trim().toLowerCase()})`;
}

const companionBusyMessage = (name: string) => `${name} is assigned to another session. Assign an available agent to resume this session.`;
const PILOT_START_LEASE_MS = 30_000; // pilotRequest times out in 10s
const PILOT_START_RETRY_MS = 5_000;
// Repo-picked starts clone before admission. The pilot lets a progressing
// clone run up to a 60-minute ceiling (killed only after 5 minutes without
// progress), so the admission request timeout and the retry lease must
// outlast that ceiling — otherwise the app aborts and retries a clone the
// pilot would have finished.
const REPO_CLONE_START_TIMEOUT_MS = 65 * 60_000;
const REPO_CLONE_START_LEASE_MS = REPO_CLONE_START_TIMEOUT_MS + 5 * 60_000;

// Sessions normally store their explicit workspaceRoot. The fallback is only
// for old rows that predate that column; it does not move any saved workspace.
function defaultWorkspaceRoot(sessionId: string): string {
  return `${WORKSPACE_ROOT}/code/${shortWorkspaceToken(sessionId)}`;
}


function resolveWorkspaceRoot(input: string): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) {
    return { ok: false, error: "Enter an absolute path under ~/workspace." };
  }

  let expanded: string;
  if (trimmed === "~") expanded = HOME_ROOT;
  else if (trimmed.startsWith("~/")) expanded = `${HOME_ROOT}/${trimmed.slice(2)}`;
  else expanded = trimmed;

  if (!expanded.startsWith("/")) {
    return { ok: false, error: "Enter an absolute path under ~/workspace." };
  }

  const segments: string[] = [];
  for (const segment of expanded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    return { ok: false, error: "Working directory must be inside ~/workspace." };
  }
  return { ok: true, path: resolved };
}

function continuationTaskMessage(sessionId: string, userDirection: string, workspaceRoot: string): string {
  return `Resume the completed Muse Code Space session ${sessionId} immediately in its existing workspace.

This continuation was explicitly sent from the dashboard. Use the artifact actions to drive the pilot session directly. Follow this protocol:
1. Call getSession for id ${sessionId}. If it is missing or its status is not queued, stop without changing it because another supervisor has claimed it.
2. Read the original request and existing transcript. The newest user event is the continuation instruction. It must exactly equal the direction below. If it does not, stop and leave the session queued for manual review.
3. Use the model_id and reasoning_effort stored on the session. Never change them from a user message. Strip any legacy first-line "[Model: <id> | Effort: <level>]" metadata header and its following blank line before assembling the prompt file; it cannot override the assigned agent configuration.
4. Claim it by calling upsertSession with the exact same id, title, and original prompt from getSession, with status running.
5. Do not append a continuation, handoff, takeover, or lifecycle acknowledgement. The dashboard already recorded the user's message and should read like a normal coding harness.
6. Reuse the session working directory given by the exact JSON string ${JSON.stringify(workspaceRoot)}. Write a prompt to /tmp/mch-${sessionId}-prompt.txt that includes the original task, a concise account of the prior transcript and workspace progress, then only the stripped latest user direction under the neutral heading "Next user message:". Do not discard or recreate the workspace. Do not echo the assembled prompt or describe any control handoff in the visible output.
7. Continue the session through the pilot: POST the assembled prompt as a new turn to the pilot session via the artifact's sendAgentMessage action, preserving the session's assigned model id and effort. Stream the turn's output events into the transcript via the artifact actions. Never invoke muse directly.
8. Supervise until exit. About every 5 seconds, call getSession FIRST and handle any newer user events as ordinary follow-up messages before reading more log output. Strip legacy Model/Effort metadata headers, but always retain the session's assigned agent configuration. Do not append operational acknowledgements. Stream only normal Muse Code stdout to appendOutput as stdout in chunks no larger than about 8000 characters.
9. At exit, append remaining stdout and call finishSession with succeeded or failed and a one-sentence summary. Do not append a result event.

Latest user message:
---
${userDirection}
---

Do not create a second app session. Start now.`;
}

// ---- terminals (shells in session workspaces on the pilot's host) ----
// A shell is full access to the VM, so only the space's owner may use it.
// (ctx.viewer is absent for local/owner-run invocations.)
function terminalAccessError(viewer: { isOwner: boolean } | undefined, resource: "terminal" | "file" = "terminal"): string | null {
  return viewer && !viewer.isOwner ? `Only the owner of this space can open a ${resource}.` : null;
}
const terminalIdSchema = z.string().min(1).max(100);

// Kill an app session's shell on the pilot, if it has one. Best effort: an
// older pilot without terminals (or one that's restarting) has none to kill.
async function killSessionTerminal(ctx: PrivilegedExecutor, sessionId: string): Promise<void> {
  try {
    const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
    await pilotRequest(baseUrl, `/terminals/by-key/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, z.object({ ok: z.boolean() }));
  } catch {
    // ignore
  }
}
const terminalResultSchema = z.object({ ok: z.boolean(), error: z.string().nullable(), gone: z.boolean().optional() });
function terminalFailure(error: unknown): { ok: false; error: string; gone: boolean } {
  const code = (error as Error & { code?: string }).code;
  return { ok: false, error: pilotRequestErrorText(error), gone: code === "unknown_terminal" || code === "terminal_exited" };
}

// Sidebar/session preview of the latest transcript row: agents rows are JSON,
// so describe them instead of showing raw JSON.
function previewText(row: { content: string; kind: string } | undefined): string | null {
  if (!row) return null;
  if (row.kind === "message") {
    try {
      const parsed = JSON.parse(row.content) as { direction?: string; from?: { name?: string }; to?: { name?: string }; text?: string };
      return parsed.direction === "in" ? `From ${parsed.from?.name}: ${parsed.text}` : `To ${parsed.to?.name}: ${parsed.text}`;
    } catch {
      return null;
    }
  }
  if (row.kind !== "agents") return row.content;
  try {
    const parsed = JSON.parse(row.content) as { kind?: string; title?: string; message?: string | null };
    return parsed.message || `${parsed.kind === "subagent" ? "Helper" : "Workflow"}: ${parsed.title ?? ""}`.trim();
  } catch {
    return null;
  }
}

async function pilotSessionIdFor(db: ReturnType<Parameters<typeof Actions.getSession.handler>[0]["db"]>, sessionId: string): Promise<string | null> {
  const rows = await db
    .select({ pilotSessionId: schema.sessions.pilotSessionId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  return rows[0]?.pilotSessionId ?? null;
}

type PilotStartRow = Pick<typeof schema.sessions.$inferSelect,
  "id" | "title" | "prompt" | "workspaceRoot" | "repoSlug" | "gitAuthorName" | "gitAuthorEmail" | "modelId" | "requestedModelId" | "reasoningEffort"> & {
  attachments?: readonly PilotAttachmentInput[];
  soul?: string;
  projectBriefing?: string | null;
};

async function requirePaidModelAccess(baseUrl: string, modelId: string) {
  if (!Object.hasOwn(PAID_COMPANION_MODELS, modelId)) return;
  const models = await readPilotModels(baseUrl);
  if (!models.some((model) => model.id === modelId)) throw new Error(modelUpgradeMessage(modelId));
}

type AssignableCompanion = {
  id: string;
  name: string;
  effort: string;
  soul: string;
  model: { preferredId: string; ifUnavailable: string };
};

const BUILTIN_COMPANION_IDS = ["poppy", "remy", "tilly", "nova", "sage"] as const;
const CUSTOM_COMPANION_LIMIT = 20;
type CompanionDb = ReturnType<Parameters<typeof Actions.getSession.handler>[0]["db"]>;
const companionNameKey = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

function builtinAssignableCompanions(): AssignableCompanion[] {
  return BUILTIN_COMPANION_IDS.flatMap((id) => {
    const entry = companionCatalog.companions.find((item) => item.id === id);
    return entry ? [{ id: entry.id, name: entry.name, effort: entry.effort, soul: BUILTIN_SOULS[entry.id] ?? "", model: entry.model }] : [];
  });
}

type CustomCompanionRow = typeof schema.customCompanions.$inferSelect;

function customToAssignable(row: CustomCompanionRow): AssignableCompanion {
  return {
    id: row.id,
    name: row.name,
    effort: row.effort,
    soul: row.soul,
    model: {
      preferredId: row.modelId,
      ifUnavailable: Object.hasOwn(PAID_COMPANION_MODELS, row.modelId) ? "upgrade-required" : "use-catalog-default",
    },
  };
}

function customToResponse(row: CustomCompanionRow): z.infer<typeof customCompanionResponseSchema> {
  let skills: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.skills);
    if (Array.isArray(parsed)) skills = parsed.filter((item): item is string => typeof item === "string");
  } catch { skills = []; }
  return {
    id: row.id, name: row.name, icon_id: row.iconId, icon_data_url: row.iconDataUrl, character: row.character, role: row.role,
    description: row.description, skills, trade_off: row.tradeOff, soul: row.soul,
    model_id: row.modelId, effort: row.effort,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  };
}

async function listCustomCompanionRows(db: CompanionDb): Promise<CustomCompanionRow[]> {
  return db.select().from(schema.customCompanions).orderBy(asc(schema.customCompanions.createdAt));
}

async function assignableCompanions(db: CompanionDb): Promise<AssignableCompanion[]> {
  return [...builtinAssignableCompanions(), ...(await listCustomCompanionRows(db)).map(customToAssignable)];
}

async function assignableCompanionById(db: CompanionDb, id: string): Promise<AssignableCompanion | undefined> {
  return (await assignableCompanions(db)).find((companion) => companion.id === id);
}

async function projectBriefingFor(db: CompanionDb, projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  const project = rows[0];
  if (!project) return null;
  const refs = await db.select().from(schema.projectReferences)
    .where(eq(schema.projectReferences.projectId, project.id))
    .orderBy(asc(schema.projectReferences.createdAt));
  return buildProjectBriefing({
    name: project.name,
    description: project.description,
    references: refs.map((ref) => ({ label: ref.label, target: ref.target })),
    briefing: project.briefing,
  });
}

async function assignableCompanionByName(db: CompanionDb, name: string): Promise<AssignableCompanion | undefined> {
  const key = companionNameKey(name);
  return (await assignableCompanions(db)).find((companion) => companionNameKey(companion.name) === key);
}

// --- Companion statistics -------------------------------------------------
// Counters are incremented live as events are ingested (see syncPilotEvents,
// sendInput, continueSession, createSession) and stored in their own tables.
// Nothing here ever reads old transcripts, so pre-tracking work is never
// counted. Statistics writes are best-effort: they must never fail the
// session flow they ride along with.

type CompanionStatisticsDelta = {
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
  toolCalls?: number;
  userTurns?: number;
  runtimeMs?: number;
};

async function guardCompanionStatistics(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch { /* statistics are best-effort and never break a session */ }
}

async function bumpCompanionStatistics(db: CompanionDb, companionId: string, delta: CompanionStatisticsDelta, activeAt?: Date): Promise<void> {
  const now = new Date();
  await db.insert(schema.companionStatistics).values({ companionId, createdAt: now, updatedAt: now }).onConflictDoNothing();
  await db.update(schema.companionStatistics).set({
    linesAdded: sql`${schema.companionStatistics.linesAdded} + ${delta.linesAdded ?? 0}`,
    linesRemoved: sql`${schema.companionStatistics.linesRemoved} + ${delta.linesRemoved ?? 0}`,
    filesChanged: sql`${schema.companionStatistics.filesChanged} + ${delta.filesChanged ?? 0}`,
    toolCalls: sql`${schema.companionStatistics.toolCalls} + ${delta.toolCalls ?? 0}`,
    userTurns: sql`${schema.companionStatistics.userTurns} + ${delta.userTurns ?? 0}`,
    runtimeMs: sql`${schema.companionStatistics.runtimeMs} + ${delta.runtimeMs ?? 0}`,
    ...(activeAt ? { lastActiveAt: activeAt } : {}),
    updatedAt: now,
  }).where(eq(schema.companionStatistics.companionId, companionId));
}

async function recordCompanionUserTurn(db: CompanionDb, sessionTitle: string, at: Date): Promise<void> {
  await guardCompanionStatistics(async () => {
    const companion = await assignableCompanionByName(db, sessionTitle);
    if (companion) await bumpCompanionStatistics(db, companion.id, { userTurns: 1 }, at);
  });
}

async function recordTrackedPrCreation(db: CompanionDb, companionId: string, created: { repo: string; number: number }, at: Date): Promise<void> {
  const now = new Date();
  await db.insert(schema.companionTrackedPrs).values({
    id: `${created.repo.toLowerCase()}#${created.number}`,
    companionId,
    repo: created.repo,
    prNumber: created.number,
    state: "open",
    createdAt: at,
    updatedAt: now,
  }).onConflictDoNothing();
}

async function recordTrackedPrSnapshot(db: CompanionDb, monitor: {
  owner: string; repo: string; number: number; status: string;
  additions?: number | null; deletions?: number | null; filesChanged?: number | null;
}, at: Date): Promise<void> {
  const id = `${monitor.owner}/${monitor.repo}#${monitor.number}`.toLowerCase();
  const rows = await db.select().from(schema.companionTrackedPrs).where(eq(schema.companionTrackedPrs.id, id)).limit(1);
  const row = rows[0];
  if (!row) return; // Created before tracking landed, or by an untracked path.
  const tracked: TrackedPr = {
    companionId: row.companionId,
    repo: row.repo,
    number: row.prNumber,
    state: row.state,
    linesCounted: row.linesCounted,
    additions: row.additions,
    deletions: row.deletions,
    filesChanged: row.filesChanged,
  };
  const { tracked: next, linesDelta } = applyPrMonitorSnapshot(tracked, {
    status: monitor.status,
    additions: monitor.additions ?? null,
    deletions: monitor.deletions ?? null,
    filesChanged: monitor.filesChanged ?? null,
  });
  await db.update(schema.companionTrackedPrs).set({
    state: next.state,
    linesCounted: next.linesCounted,
    additions: next.additions,
    deletions: next.deletions,
    filesChanged: next.filesChanged,
    ...(next.state === "merged" && row.state !== "merged" ? { mergedAt: at } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.companionTrackedPrs.id, id));
  if (linesDelta) {
    await bumpCompanionStatistics(db, row.companionId, {
      linesAdded: linesDelta.additions,
      linesRemoved: linesDelta.deletions,
      filesChanged: linesDelta.filesChanged,
    }, at);
  }
}

async function resolveCompanionModel(ctx: Ctx, companion: AssignableCompanion,
  storedModels: readonly { id: string }[]) {
  let models = storedModels;
  if (companion.model.ifUnavailable === "upgrade-required") {
    const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
    models = await readPilotModels(baseUrl);
  }
  const access = companionModelAccess(companion, models);
  if (access.status !== "ready") throw new Error(modelUpgradeMessage(companion.model.preferredId));
  return access.modelId;
}

async function startPilotAgent(baseUrl: string, row: PilotStartRow) {
  await requirePaidModelAccess(baseUrl, row.requestedModelId ?? row.modelId);
  return pilotRequest(
    baseUrl,
    "/sessions",
    {
      method: "POST",
      body: JSON.stringify({
        title: row.title,
        name: row.title,
        prompt: row.prompt,
        // Old queued rows predate requestedModelId. For those, don't send
        // our placeholder model id; let the pilot choose its catalog default.
        modelId: row.requestedModelId ?? (row.modelId === FALLBACK_MODEL_ID ? undefined : row.modelId),
        reasoningEffort: row.reasoningEffort,
        workspaceName: row.id, // stable idempotency key in the pilot
        workspaceRoot: row.workspaceRoot ?? defaultWorkspaceRoot(row.id),
        generatedWorkspace: row.workspaceRoot === null || isGeneratedWorkspaceRoot(row.id, row.workspaceRoot, WORKSPACE_ROOT),
        // The pilot clones this into the workspace before the first turn.
        ...(row.repoSlug ? { repo: row.repoSlug } : {}),
        ...(row.repoSlug && row.gitAuthorName && row.gitAuthorEmail
          ? { gitAuthor: { name: row.gitAuthorName, email: row.gitAuthorEmail } }
          : {}),
        ...(row.soul?.trim() ? { soul: row.soul } : {}),
        ...(row.projectBriefing?.trim() ? { project_briefing: row.projectBriefing } : {}),
        ...(row.attachments && row.attachments.length > 0 ? { attachments: row.attachments } : {}),
      }),
    },
    pilotSessionResponseSchema,
    // A clone can take far longer than the usual 10s admission budget;
    // REPO_CLONE_START_TIMEOUT_MS outlasts the pilot's clone ceiling.
    row.repoSlug ? REPO_CLONE_START_TIMEOUT_MS : 10_000,
  );
}

function transientPilotStartError(error: unknown): boolean {
  const code = (error as Error & { code?: string })?.code;
  return isPilotUnavailable(error) || error instanceof TypeError || (error instanceof Error && error.name === "AbortError") ||
    code === "relay_down" || code === "pilot_down" || code === "recovery_failed" || code === "turn_not_admitted";
}

// Durable retry of an agent whose first prompt has not been admitted. A DB
// compare-and-set lease prevents two app workers/tabs from starting it at
// once; after a worker crash the lease expires. The pilot also deduplicates
// by workspaceName, covering a lost HTTP response after it accepted the turn.
async function startOneQueuedAgent(ctx: Ctx, id?: string): Promise<{ started: number; failed: number }> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const eligible = or(isNull(schema.sessions.pilotRetryAt), lte(schema.sessions.pilotRetryAt, now));
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.status, "queued"), eq(schema.sessions.archived, false), isNull(schema.sessions.pilotSessionId), eligible,
      id ? eq(schema.sessions.id, id) : undefined))
    .orderBy(asc(schema.sessions.startedAt));
  // A queued legacy continuation can also lack a pilot id. Only bootstrap
  // the first prompt: otherwise we'd replay the original task over a real
  // supervisor continuation. This also recognizes old stuck startup rows
  // created before pilot_retry_at existed (their single user event survived).
  let row: (typeof rows)[number] | undefined;
  for (const candidate of rows) {
    const firstTwo = await db.select({ id: schema.outputEvents.id })
      .from(schema.outputEvents)
      .where(and(eq(schema.outputEvents.sessionId, candidate.id), eq(schema.outputEvents.kind, "user")))
      .limit(2);
    if (firstTwo.length === 1) {
      row = candidate;
      break;
    }
  }
  if (!row) return { started: 0, failed: 0 };

  let baseUrl: string;
  try {
    ({ baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {}));
    // A short probe avoids holding up polling for the full pilotRequest
    // timeout when the pilot service is simply offline.
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1200) });
    if (!health.ok) return { started: 0, failed: 0 };
  } catch {
    return { started: 0, failed: 0 };
  }

  const lease = await db
    .update(schema.sessions)
    // A repo clone can hold the start attempt well past the usual lease;
    // the pilot dedupes by workspaceName, so a longer lease is safe.
    .set({ pilotRetryAt: new Date(Date.now() + (row.repoSlug ? REPO_CLONE_START_LEASE_MS : PILOT_START_LEASE_MS)) })
    .where(and(eq(schema.sessions.id, row.id), eq(schema.sessions.status, "queued"),
      isNull(schema.sessions.pilotSessionId),
      or(isNull(schema.sessions.pilotRetryAt), lte(schema.sessions.pilotRetryAt, now))))
    .returning({ id: schema.sessions.id });
  if (!lease[0]) return { started: 0, failed: 0 };

  const soulCompanion = await assignableCompanionByName(db, row.title).catch(() => undefined);
  const queuedBriefing = await projectBriefingFor(db, row.projectId).catch(() => null);
  try {
    const pilot = await startPilotAgent(baseUrl, { ...row, soul: soulCompanion?.soul, projectBriefing: queuedBriefing });
    if (!pilot.turnId) {
      const error = new Error("Pilot has not admitted the first turn yet") as Error & { code?: string };
      error.code = "turn_not_admitted";
      throw error;
    }
    const updated = await db
      .update(schema.sessions)
      .set({
        pilotSessionId: pilot.sessionId,
        pilotSeq: 0,
        pilotRetryAt: null,
        status: "running",
        modelId: pilot.modelId ?? row.modelId,
        title: pilot.name ?? row.title,
      })
      .where(and(eq(schema.sessions.id, row.id), eq(schema.sessions.status, "queued"),
        isNull(schema.sessions.pilotSessionId)))
      .returning({ id: schema.sessions.id });
    if (updated[0]) ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", row.id]] });
    return { started: updated.length, failed: 0 };
  } catch (error) {
    if (transientPilotStartError(error)) {
      await db.update(schema.sessions)
        .set({ pilotRetryAt: new Date(Date.now() + PILOT_START_RETRY_MS) })
        .where(and(eq(schema.sessions.id, row.id), eq(schema.sessions.status, "queued"),
          isNull(schema.sessions.pilotSessionId)));
      return { started: 0, failed: 0 };
    }
    const reason = `Agent could not start: ${pilotRequestErrorText(error).slice(0, 1000)}. Retry when the connection is restored.`;
    await db.insert(schema.outputEvents).values({ sessionId: row.id, kind: "system", content: reason, systemIsError: true, createdAt: new Date() });
    await db.update(schema.sessions)
      .set({ status: "failed", summary: reason, finishedAt: new Date(), pilotRetryAt: null,
        outputRevision: sql`${schema.sessions.outputRevision} + 1` })
      .where(and(eq(schema.sessions.id, row.id), eq(schema.sessions.status, "queued"),
        isNull(schema.sessions.pilotSessionId)));
    ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", row.id]] });
    return { started: 0, failed: 1 };
  }
}

// ---- transcript-driven restore of past conversations ----
// The list of past conversations does not rely on app state. The pilot host
// keeps one transcript file per session (events-<pilotSessionId>.jsonl); any
// transcript with no app session row is re-registered in Past with its
// transcript imported, so wiping app.db never orphans a conversation whose
// transcript still exists. Deleting a session deletes its transcript too
// (see deleteSession), so a restored row can never resurrect a conversation
// the user actually deleted.

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
};

function transcriptDate(value: string | null, fallback: Date): Date {
  if (value) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return fallback;
}

async function fetchTranscriptImport(ctx: Ctx, pilotSessionId: string, fallbackStart: Date): Promise<TranscriptImport | null> {
  try {
    const res = await ctx.executePrivileged(privileged.readTranscript, { pilot_session_id: pilotSessionId });
    if (!res.found) return null;
    return transcriptToRows(res.events, fallbackStart);
  } catch {
    return null;
  }
}

async function insertImportedRows(ctx: Ctx, sessionId: string, imported: TranscriptImport): Promise<void> {
  const db = ctx.db<typeof schema>();
  for (const row of imported.rows) {
    await db.insert(schema.outputEvents).values({
      sessionId,
      kind: row.kind,
      content: row.content,
      systemIsError: row.systemIsError,
      createdAt: row.createdAt,
      itemId: row.itemId,
      toolDetails: row.toolDetails,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  }
}

type ReconcileResult = {
  available: boolean;
  restored: number;
  linked: number;
  pruned: number;
  kept: string[];
  error: string | null;
};

async function reconcileTranscripts(ctx: Ctx, opts: { pruneExceptTitle?: string }): Promise<ReconcileResult> {
  const db = ctx.db<typeof schema>();
  let transcripts: TranscriptSummary[];
  try {
    const res = await ctx.executePrivileged(privileged.listTranscripts, {});
    transcripts = res.transcripts;
  } catch {
    return { available: false, restored: 0, linked: 0, pruned: 0, kept: [], error: null };
  }
  const keepTitle = opts.pruneExceptTitle?.trim().toLowerCase() || null;
  const matchesKeep = (t: TranscriptSummary) =>
    !keepTitle || (t.name ?? "").trim().toLowerCase() === keepTitle || (t.title ?? "").trim().toLowerCase() === keepTitle;
  if (keepTitle && !transcripts.some(matchesKeep)) {
    // Refuse to prune everything when the conversation to keep has no
    // transcript: that would delete every past conversation and restore none.
    return {
      available: true, restored: 0, linked: 0, pruned: 0, kept: [],
      error: `No transcript found for "${opts.pruneExceptTitle}". Nothing was deleted or restored.`,
    };
  }

  let restored = 0;
  let linked = 0;
  const keptIds = new Set<string>();
  const existingRows = await db.select().from(schema.sessions);
  const byPilot = new Map(existingRows.filter((r) => r.pilotSessionId).map((r) => [r.pilotSessionId!, r]));
  const byId = new Map(existingRows.map((r) => [r.id, r]));

  for (const t of transcripts) {
    if (!matchesKeep(t)) continue;
    const restoredId = `restored-${t.pilot_session_id}`;
    const existing = byPilot.get(t.pilot_session_id)
      ?? (t.app_session_id ? byId.get(t.app_session_id) : undefined)
      ?? byId.get(restoredId);
    if (existing) {
      keptIds.add(existing.id);
      if (existing.pilotSessionId !== t.pilot_session_id) {
        await db.update(schema.sessions)
          .set({ pilotSessionId: t.pilot_session_id, ...(existing.workspaceRoot ? {} : { workspaceRoot: t.workspace_root }) })
          .where(eq(schema.sessions.id, existing.id));
        linked += 1;
      }
      // Heal a husk row (session exists but its transcript rows are gone)
      // from the surviving transcript file.
      if (existing.status !== "queued" && existing.status !== "running") {
        const anyEvent = await db.select({ id: schema.outputEvents.id })
          .from(schema.outputEvents)
          .where(eq(schema.outputEvents.sessionId, existing.id))
          .limit(1);
        if (anyEvent.length > 0 && existing.sessionSummary && /recorded no transcript/i.test(existing.sessionSummary)) {
          // A summary written while the transcript was missing is false
          // once transcript rows exist; clear it wherever the import
          // happened (including by an older build).
          await db.update(schema.sessions)
            .set({ sessionSummary: null })
            .where(eq(schema.sessions.id, existing.id));
          linked += 1;
        }
        if (anyEvent.length === 0) {
          const imported = await fetchTranscriptImport(ctx, t.pilot_session_id, existing.startedAt);
          if (imported) {
            await insertImportedRows(ctx, existing.id, imported);
            await db.update(schema.sessions)
              .set({
                pilotSeq: imported.latestSeq,
                outputRevision: imported.rows.length,
                seenOutputRevision: imported.rows.length,
                status: imported.status,
                summary: imported.summary,
                // A summary written while the transcript was missing (e.g.
                // "no transcript recorded") is false once it is imported.
                sessionSummary: null,
                finishedAt: transcriptDate(t.updated_at, existing.updatedAt),
              })
              .where(eq(schema.sessions.id, existing.id));
            linked += 1;
          }
        }
      }
      continue;
    }

    const id = t.app_session_id ?? restoredId;
    if (byId.has(id)) continue; // id belongs to an unrelated session; never hijack it
    const companion = companionCatalog.companions.find(
      (c) => c.name.toLowerCase() === (t.name ?? t.title ?? "").trim().toLowerCase(),
    );
    const title = companion?.name ?? t.title
      ?? (t.name ? t.name.charAt(0).toUpperCase() + t.name.slice(1) : "Restored session");
    const createdAt = transcriptDate(t.created_at, new Date());
    const updatedAt = transcriptDate(t.updated_at, createdAt);
    const modelId = t.model_id ?? companion?.model.preferredId ?? FALLBACK_MODEL_ID;
    let effort: ReasoningEffort = "high";
    if (companion) {
      const parsed = reasoningEffortSchema.safeParse(companion.effort);
      if (parsed.success) effort = parsed.data;
    }
    await db.insert(schema.sessions).values({
      id,
      title,
      prompt: t.prompt ?? "Restored from its session transcript.",
      workspaceRoot: t.workspace_root,
      status: "succeeded",
      startedAt: createdAt,
      updatedAt,
      finishedAt: updatedAt,
      archived: true,
      archivedAt: updatedAt,
      pilotSessionId: t.pilot_session_id,
      pilotSeq: 0,
      modelId,
      requestedModelId: modelId,
      reasoningEffort: effort,
    });
    const imported = await fetchTranscriptImport(ctx, t.pilot_session_id, createdAt);
    if (imported) {
      await insertImportedRows(ctx, id, imported);
      await db.update(schema.sessions)
        .set({
          pilotSeq: imported.latestSeq,
          outputRevision: imported.rows.length,
          seenOutputRevision: imported.rows.length,
          status: imported.status,
          summary: imported.summary,
        })
        .where(eq(schema.sessions.id, id));
    }
    byId.set(id, (await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1))[0]!);
    keptIds.add(id);
    restored += 1;
  }

  let pruned = 0;
  if (keepTitle) {
    let baseUrl: string | null = null;
    try {
      ({ baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {}));
    } catch {
      baseUrl = null;
    }
    const allRows = await db.select().from(schema.sessions);
    for (const row of allRows) {
      if (keptIds.has(row.id)) continue;
      if (row.status === "queued" || row.status === "running") continue;
      if (row.pilotSessionId) {
        if (!baseUrl) continue;
        try {
          await pilotRequest(baseUrl, `/sessions/${encodeURIComponent(row.pilotSessionId)}`, { method: "DELETE" }, z.object({ ok: z.boolean() }));
        } catch {
          continue; // pilot couldn't confirm the transcript is gone; keep the row
        }
      }
      await killSessionTerminal(ctx, row.id);
      await db.delete(schema.outputEvents).where(eq(schema.outputEvents.sessionId, row.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.id, row.id));
      pruned += 1;
    }
    // Transcripts that never had an app row are deleted too, except the kept one.
    if (baseUrl) {
      for (const t of transcripts) {
        if (matchesKeep(t)) continue;
        try {
          await pilotRequest(baseUrl, `/sessions/${encodeURIComponent(t.pilot_session_id)}`, { method: "DELETE" }, z.object({ ok: z.boolean() }));
        } catch {
          // Best effort: a running session's transcript refuses deletion.
        }
      }
    }
  }

  if (restored > 0 || linked > 0 || pruned > 0) ctx.invalidateQueries({ queryKey: ["code-sessions"] });
  return { available: true, restored, linked, pruned, kept: [...keptIds], error: null };
}

export const Actions = {
  // ---- agent-to-agent messages, for the user's Muse assistant ----
  // (artifact.invoke_action). Agents themselves use the session-scoped
  // mcp__code_space__send_message tool; both go through the pilot, which
  // delivers each message as a new turn labeled with its sender.

  // Send a message to an agent as Muse (the user's personal assistant).
  sendAgentMessage: defineAction({
    request: z.object({
      to: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(20000),
    }),
    response: z.object({ ok: z.boolean(), to: z.string().nullable(), queued: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, to: null, queued: false, error: denied };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(
          baseUrl,
          "/messages",
          { method: "POST", body: JSON.stringify({ from: "muse", to: args.to, text: args.text }) },
          z.object({ ok: z.boolean(), queued: z.boolean().optional(), to: z.object({ name: z.string() }).optional() }),
        );
        ctx.invalidateQueries({ queryKey: ["code-sessions"] });
        return { ok: true, to: res.to?.name ?? args.to, queued: res.queued === true, error: null };
      } catch (error) {
        return { ok: false, to: null, queued: false, error: pilotRequestErrorText(error) };
      }
    },
  }),

  // How agents see the user's Muse assistant: its avatar name and theme color
  // (default Jolly, #d0e4fc). On a Muse VM the assistant sets its real ones.
  // The name is reserved: agents message it by that name (or "muse").
  // The same payload carries user_name: the user's own name, provided by
  // the assistant alongside its own identity (null until it does).
  getAssistantIdentity: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), name: z.string().nullable(), color: z.string().nullable(), avatar_data_url: z.string().nullable(), user_name: z.string().nullable(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(baseUrl, "/assistant", { method: "GET" }, z.object({ name: z.string(), color: z.string(), avatar_data_url: z.string().nullable(), user_name: z.string().nullable().optional() }));
        return { ok: true, name: res.name, color: res.color, avatar_data_url: res.avatar_data_url, user_name: res.user_name ?? null, error: null };
      } catch (error) {
        return { ok: false, name: null, color: null, avatar_data_url: null, user_name: null, error: pilotRequestErrorText(error) };
      }
    },
  }),

  setAssistantIdentity: defineAction({
    request: z.object({
      name: z.string().trim().min(1).max(40).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      avatar_data_url: z.string().max(350000).nullable().optional(),
      // The user's own name, provided by the assistant alongside its own
      // identity. Omission keeps it, null clears it.
      user_name: z.string().trim().min(1).max(40).nullable().optional(),
    }),
    response: z.object({ ok: z.boolean(), name: z.string().nullable(), color: z.string().nullable(), avatar_data_url: z.string().nullable(), user_name: z.string().nullable(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, name: null, color: null, avatar_data_url: null, user_name: null, error: denied };
      if (args.avatar_data_url != null) {
        const error = validateAssistantAvatar(args.avatar_data_url);
        if (error) return { ok: false, name: null, color: null, avatar_data_url: null, user_name: null, error };
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(baseUrl, "/assistant", { method: "POST", body: JSON.stringify(args) }, z.object({ name: z.string(), color: z.string(), avatar_data_url: z.string().nullable(), user_name: z.string().nullable().optional() }));
        ctx.invalidateQueries({ queryKey: ["assistant-identity"] });
        return { ok: true, name: res.name, color: res.color, avatar_data_url: res.avatar_data_url, user_name: res.user_name ?? null, error: null };
      } catch (error) {
        return { ok: false, name: null, color: null, avatar_data_url: null, user_name: null, error: pilotRequestErrorText(error) };
      }
    },
  }),

  // Global git commit identity (pilot git-identity.json, merged into the
  // session gitconfig). Per-checkout overrides ride createSession instead.
  getGitIdentity: defineAction({
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(baseUrl, "/git-identity", { method: "GET" },
          z.object({ identity: z.object({ name: z.string(), email: z.string() }).nullable() }));
        return { ok: true, name: res.identity?.name ?? null, email: res.identity?.email ?? null, error: null };
      } catch (error) {
        return { ok: false, name: null, email: null, error: pilotRequestErrorText(error) };
      }
    },
  }),

  setGitIdentity: defineAction({
    request: z.object({
      name: z.string().trim().min(1).max(100).nullable(),
      email: z.string().trim().min(3).max(200).nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, name: null, email: null, error: denied };
      if ((args.name === null) !== (args.email === null)) {
        return { ok: false, name: null, email: null, error: "Provide both an author name and email, or clear both." };
      }
      if (args.name !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email ?? "")) {
        return { ok: false, name: null, email: null, error: "Provide a valid author email." };
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(baseUrl, "/git-identity",
          { method: "POST", body: JSON.stringify(args.name === null ? { identity: null } : { name: args.name, email: args.email }) },
          z.object({ identity: z.object({ name: z.string(), email: z.string() }).nullable() }));
        ctx.invalidateQueries({ queryKey: ["git-identity"] });
        return { ok: true, name: res.identity?.name ?? null, email: res.identity?.email ?? null, error: null };
      } catch (error) {
        return { ok: false, name: null, email: null, error: pilotRequestErrorText(error) };
      }
    },
  }),

  // GitHub setup progress (broker + GitHub App steps) for the repo
  // picker's setup dialog. The Commit author step rides get/setGitIdentity.
  getGithubSetup: defineAction({
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      broker_done: z.boolean(),
      app_done: z.boolean(),
      broker_requested: z.boolean(),
      app_requested: z.boolean(),
      app_help_requested: z.boolean(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(baseUrl, "/github-setup", { method: "GET" },
          z.object({ brokerDone: z.boolean(), appDone: z.boolean(), brokerRequested: z.boolean().optional(), appRequested: z.boolean().optional(), appHelpRequested: z.boolean().optional() }));
        return { ok: true, broker_done: res.brokerDone, app_done: res.appDone, broker_requested: res.brokerRequested ?? false, app_requested: res.appRequested ?? false, app_help_requested: res.appHelpRequested ?? false, error: null };
      } catch (error) {
        return { ok: false, broker_done: false, app_done: false, broker_requested: false, app_requested: false, app_help_requested: false, error: pilotRequestErrorText(error) };
      }
    },
  }),

  performGithubSetupStep: defineAction({
    request: z.object({
      step: z.enum(["broker", "app", "app-help"]),
      app_id: z.string().trim().max(32).optional(),
      installation_id: z.string().trim().max(32).optional(),
      private_key: z.string().max(16_000).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      broker_done: z.boolean(),
      app_done: z.boolean(),
      broker_requested: z.boolean(),
      app_requested: z.boolean(),
      app_help_requested: z.boolean(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, broker_done: false, app_done: false, broker_requested: false, app_requested: false, app_help_requested: false, error: denied };
      if (args.step === "app") {
        if (!/^\d+$/.test(args.app_id ?? "") || !/^\d+$/.test(args.installation_id ?? "")) {
          return { ok: false, broker_done: false, app_done: false, broker_requested: false, app_requested: false, app_help_requested: false, error: "App ID and installation ID must be numeric." };
        }
        const key = args.private_key ?? "";
        if (!key.includes("-----BEGIN") || !key.includes("PRIVATE KEY-----") || !key.includes("-----END")) {
          return { ok: false, broker_done: false, app_done: false, broker_requested: false, app_requested: false, app_help_requested: false, error: "Paste the App private key (.pem)." };
        }
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        // App-step validation runs in the pilot under its own bounded
        // retry budget (~35s worst case); the default 10s pilot timeout
        // would abort first and mask the real outcome as "Could not
        // connect", so this call gets a timeout that outlasts it.
        const res = await pilotRequest(baseUrl, "/github-setup",
          { method: "POST", body: JSON.stringify({ step: args.step, appId: args.app_id, installationId: args.installation_id, privateKey: args.private_key }) },
          z.object({ brokerDone: z.boolean(), appDone: z.boolean(), brokerRequested: z.boolean().optional(), appRequested: z.boolean().optional(), appHelpRequested: z.boolean().optional() }), 60_000);
        ctx.invalidateQueries({ queryKey: ["github-setup"] });
        ctx.invalidateQueries({ queryKey: ["github-repos"] });
        return { ok: true, broker_done: res.brokerDone, app_done: res.appDone, broker_requested: res.brokerRequested ?? false, app_requested: res.appRequested ?? false, app_help_requested: res.appHelpRequested ?? false, error: null };
      } catch (error) {
        return { ok: false, broker_done: false, app_done: false, broker_requested: false, app_requested: false, app_help_requested: false, error: pilotRequestErrorText(error) };
      }
    },
  }),

  // Per-checkout commit author for an already-started session (the repo
  // dropdown in the conversation). Pilot applies it as repo-local git
  // config in the session workspace; clearing falls back to the global
  // identity in the session gitconfig.
  setSessionGitAuthor: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(100).nullable(),
      email: z.string().trim().min(3).max(200).nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, name: null, email: null, error: denied };
      if ((args.name === null) !== (args.email === null)) {
        return { ok: false, name: null, email: null, error: "Provide both an author name and email, or clear both." };
      }
      if (args.name !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email ?? "")) {
        return { ok: false, name: null, email: null, error: "Provide a valid author email." };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db.select({
        id: schema.sessions.id, pilotSessionId: schema.sessions.pilotSessionId, repoSlug: schema.sessions.repoSlug,
      }).from(schema.sessions).where(eq(schema.sessions.id, args.session_id)).limit(1);
      const session = rows[0];
      if (!session) return { ok: false, name: null, email: null, error: "Session not found" };
      if (!session.repoSlug) return { ok: false, name: null, email: null, error: "This session has no repository checkout." };
      // Pilot first: a failed apply must not leave the row claiming an
      // author the checkout does not have. Queued sessions have no pilot
      // session yet; their stored author rides the start payload instead.
      if (session.pilotSessionId) {
        try {
          const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
          await pilotRequest(baseUrl, `/sessions/${encodeURIComponent(session.pilotSessionId)}/git-author`,
            { method: "POST", body: JSON.stringify(args.name === null ? { identity: null } : { name: args.name, email: args.email }) },
            z.object({ ok: z.boolean() }));
        } catch (error) {
          return { ok: false, name: null, email: null, error: `Couldn't apply the author to the checkout (${pilotRequestErrorText(error).slice(0, 200)}). Nothing was changed.` };
        }
      }
      await db.update(schema.sessions)
        .set({ gitAuthorName: args.name, gitAuthorEmail: args.email, updatedAt: new Date() })
        .where(eq(schema.sessions.id, session.id));
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", session.id]] });
      return { ok: true, name: args.name, email: args.email, error: null };
    },
  }),

  // Messageable agents plus the user's current Muse assistant avatar name.
  listAgents: defineAction({


    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      agents: z.array(z.object({ name: z.string(), session_id: z.string(), busy: z.boolean() })),
      assistant_name: z.string().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, agents: [], assistant_name: null, error: denied };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(
          baseUrl,
          "/agents",
          { method: "GET" },
          z.object({
            agents: z.array(z.object({ name: z.string(), sessionId: z.string(), busy: z.boolean() })),
            assistant: z.object({ name: z.string() }).optional(),
          }),
        );
        return {
          ok: true,
          agents: res.agents.map((a) => ({ name: a.name, session_id: a.sessionId, busy: a.busy })),
          assistant_name: res.assistant?.name ?? null,
          error: null,
        };
      } catch (error) {
        return { ok: false, agents: [], assistant_name: null, error: pilotRequestErrorText(error) };
      }
    },
  }),

  // Messages agents sent to Muse through their MCP tool, after `since`.
  readMuseMessages: defineAction({
    request: z.object({ since: z.number().int().nonnegative().default(0) }),
    response: z.object({
      ok: z.boolean(),
      messages: z.array(z.object({ seq: z.number(), at: z.string(), from: z.string(), text: z.string() })),
      latest: z.number(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, messages: [], latest: args.since, error: denied };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(
          baseUrl,
          `/messages/muse?since=${args.since}`,
          { method: "GET" },
          z.object({
            messages: z.array(z.object({ seq: z.number(), at: z.string(), from: z.object({ name: z.string() }), text: z.string() })),
            latest: z.number(),
          }),
        );
        return {
          ok: true,
          messages: res.messages.map((m) => ({ seq: m.seq, at: m.at, from: m.from.name, text: m.text })),
          latest: res.latest,
          error: null,
        };
      } catch (error) {
        return { ok: false, messages: [], latest: args.since, error: pilotRequestErrorText(error) };
      }
    },
  }),

  // ---- agent-to-agent work: a workflow's child agents / subagents ----

  // Stop a running workflow (workflow/cancel) and its child agents.
  cancelWorkflow: defineAction({
    request: z.object({ session_id: z.string().min(1).max(200), workflow_run_id: z.string().min(1).max(300) }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, error: denied };
      const pilotSessionId = await pilotSessionIdFor(ctx.db<typeof schema>(), args.session_id);
      if (!pilotSessionId) return { ok: false, error: "Session not found" };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(pilotSessionId)}/workflows/${encodeURIComponent(args.workflow_run_id)}/cancel`,
          { method: "POST" },
          z.object({ ok: z.boolean() }),
        );
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: pilotRequestErrorText(error) };
      }
    },
  }),

  // The session's terminals (the side pane's terminal tabs), oldest first.
  listSessionTerminals: defineAction({
    request: z.object({ session_id: z.string().min(1).max(200) }),
    response: z.object({
      ok: z.boolean(),
      terminals: z.array(z.object({ terminal_id: z.string(), number: z.number().int(), exited: z.boolean() })),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, terminals: [], error: denied };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(
          baseUrl,
          `/terminals?key=${encodeURIComponent(args.session_id)}`,
          { method: "GET" },
          z.object({ terminals: z.array(z.object({ terminalId: z.string(), number: z.number(), exited: z.boolean() })) }),
        );
        return { ok: true, terminals: res.terminals.map((t) => ({ terminal_id: t.terminalId, number: t.number, exited: t.exited })), error: null };
      } catch (error) {
        return { ok: false, terminals: [], error: pilotRequestErrorText(error) };
      }
    },
  }),

  // Derive the agent's files from its durable, byte-confirmed write_file
  // events. Reads/edits never create ownership; no filesystem scan is needed.
  listOwnedArtifacts: defineAction({
    request: z.object({ session_id: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), files: z.array(z.string()), error: z.string().nullable() }),
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer, "file");
      if (denied) return { ok: false, files: [], error: denied };
      const db = ctx.db<typeof schema>();
      const session = (await db.select({ id: schema.sessions.id, workspaceRoot: schema.sessions.workspaceRoot })
        .from(schema.sessions).where(eq(schema.sessions.id, args.session_id)).limit(1))[0];
      if (!session) return { ok: false, files: [], error: "Session not found." };
      const rows = await db.select({ toolDetails: schema.outputEvents.toolDetails })
        .from(schema.outputEvents)
        .where(and(eq(schema.outputEvents.sessionId, session.id), eq(schema.outputEvents.kind, "tool"), isNotNull(schema.outputEvents.toolDetails)))
        .orderBy(desc(schema.outputEvents.id));
      return { ok: true, files: ownedArtifactPaths(rows, session.workspaceRoot ?? defaultWorkspaceRoot(session.id), parseToolDetails), error: null };
    },
  }),

  // Current on-disk file for a read-only side-panel tab (not historical tool
  // output). The pilot validates the path against this session's workspace.
  readSessionFile: defineAction({
    request: z.object({ session_id: z.string().min(1).max(200), path: z.string().min(1).max(2000) }),
    response: z.object({ ok: z.boolean(), path: z.string().nullable(), content: z.string().nullable(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const empty = (error: string) => ({ ok: false, path: null, content: null, error });
      const denied = terminalAccessError(ctx.viewer, "file");
      if (denied) return empty(denied);
      const db = ctx.db<typeof schema>();
      const session = (await db.select({ pilotSessionId: schema.sessions.pilotSessionId })
        .from(schema.sessions).where(eq(schema.sessions.id, args.session_id)).limit(1))[0];
      if (!session?.pilotSessionId) return empty("Agent connection unavailable.");
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const result = await pilotRequest(baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/files/read`,
          { method: "POST", body: JSON.stringify({ path: args.path }) },
          z.object({ ok: z.literal(true), path: z.string(), content: z.string() }));
        return { ok: true, path: result.path, content: result.content, error: null };
      } catch (error) {
        if (error instanceof Error && error.message.trim() === "not found") {
          return empty("File viewing requires an updated Muse Code service. Restart the service to enable file tabs.");
        }
        return empty(pilotRequestErrorText(error));
      }
    },
  }),

  // Read a binary/SVG image from the session's workspace for inline Markdown
  // rendering (`![alt](relative/path.png)`) and preview screenshot cards.
  readSessionImage: defineAction({
    request: z.object({ session_id: z.string().min(1).max(200), path: z.string().min(1).max(2000) }),
    response: z.object({
      ok: z.boolean(),
      path: z.string().nullable(),
      media_type: z.string().nullable(),
      base64_data: z.string().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const empty = (error: string) => ({ ok: false, path: null, media_type: null, base64_data: null, error });
      const denied = terminalAccessError(ctx.viewer, "file");
      if (denied) return empty(denied);
      const db = ctx.db<typeof schema>();
      const session = (await db.select({ pilotSessionId: schema.sessions.pilotSessionId })
        .from(schema.sessions).where(eq(schema.sessions.id, args.session_id)).limit(1))[0];
      if (!session?.pilotSessionId) return empty("Agent connection unavailable.");
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const result = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/files/read-image`,
          { method: "POST", body: JSON.stringify({ path: args.path }) },
          z.object({
            ok: z.literal(true),
            path: z.string(),
            mediaType: z.string(),
            base64Data: z.string(),
          }),
        );
        return {
          ok: true,
          path: result.path,
          media_type: result.mediaType,
          base64_data: result.base64Data,
          error: null,
        };
      } catch (error) {
        return empty(pilotRequestErrorText(error));
      }
    },
  }),

  // A new shell in the session's workspace, or (with terminal_id) reattach
  // to one of its shells.
  openTerminal: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      terminal_id: z.string().min(1).max(100).optional(),
      cols: z.number().int().min(10).max(1000).default(80),
      rows: z.number().int().min(4).max(500).default(24),
    }),
    response: z.object({
      ok: z.boolean(),
      terminal_id: z.string().nullable(),
      number: z.number().int().nullable(),
      cwd: z.string().nullable(),
      reattached: z.boolean(),
      gone: z.boolean().optional(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, terminal_id: null, number: null, cwd: null, reattached: false, error: denied };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.sessions.id, workspaceRoot: schema.sessions.workspaceRoot })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, terminal_id: null, number: null, cwd: null, reattached: false, error: "Session not found" };
      const cwd = session.workspaceRoot ?? defaultWorkspaceRoot(session.id);
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const opened = await pilotRequest(
          baseUrl,
          "/terminals",
          { method: "POST", body: JSON.stringify({ key: session.id, cwd, cols: args.cols, rows: args.rows, terminalId: args.terminal_id }) },
          z.object({ terminalId: z.string(), reattached: z.boolean(), cwd: z.string(), number: z.number() }),
        );
        return { ok: true, terminal_id: opened.terminalId, number: opened.number, cwd: opened.cwd, reattached: opened.reattached, error: null };
      } catch (error) {
        const { gone } = terminalFailure(error);
        return { ok: false, terminal_id: null, number: null, cwd: null, reattached: false, gone, error: pilotRequestErrorText(error) };
      }
    },
  }),

  terminalInput: defineAction({
    request: z.object({ terminal_id: terminalIdSchema, data: z.string().min(1).max(65536) }),
    response: terminalResultSchema,
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, error: denied };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        await pilotRequest(baseUrl, `/terminals/${encodeURIComponent(args.terminal_id)}/input`, { method: "POST", body: JSON.stringify({ data: args.data }) }, z.object({ ok: z.boolean() }));
        return { ok: true, error: null };
      } catch (error) {
        return terminalFailure(error);
      }
    },
  }),

  // Long-poll: waits up to wait_ms for output past `since` (a byte offset).
  terminalOutput: defineAction({
    request: z.object({
      terminal_id: terminalIdSchema,
      since: z.number().int().nonnegative(),
      wait_ms: z.number().int().min(0).max(8000).default(0),
    }),
    response: terminalResultSchema.extend({
      data: z.string(), // base64 terminal bytes
      next: z.number().int().nonnegative(),
      exited: z.boolean(),
      exit_code: z.number().nullable(),
      truncated: z.boolean(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const empty = { data: "", next: args.since, exited: false, exit_code: null, truncated: false };
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, error: denied, ...empty };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const outSchema = z.object({ data: z.string(), next: z.number(), exited: z.boolean(), exitCode: z.number().nullable(), truncated: z.boolean() });
        let out = await pilotRequest(
          baseUrl,
          `/terminals/${encodeURIComponent(args.terminal_id)}/output?since=${args.since}&waitMs=${args.wait_ms}`,
          { method: "GET" },
          outSchema,
        );
        // Coalesce burst multi-write() TUI frames (e.g. htop header + process table)
        // when the long-poll wakes on the initial small write chunk.
        if (args.wait_ms > 0 && out.data && !out.exited && out.next - args.since < 2048) {
          await new Promise((resolve) => setTimeout(resolve, 3));
          const tail = await pilotRequest(
            baseUrl,
            `/terminals/${encodeURIComponent(args.terminal_id)}/output?since=${out.next}&waitMs=0`,
            { method: "GET" },
            outSchema,
          ).catch(() => null);
          if (tail && tail.data) {
            const combined = Buffer.concat([Buffer.from(out.data, "base64"), Buffer.from(tail.data, "base64")]);
            out = {
              data: combined.toString("base64"),
              next: tail.next,
              exited: tail.exited,
              exitCode: tail.exitCode,
              truncated: out.truncated || tail.truncated,
            };
          }
        }
        return { ok: true, error: null, data: out.data, next: out.next, exited: out.exited, exit_code: out.exitCode, truncated: out.truncated };
      } catch (error) {
        return { ...terminalFailure(error), ...empty };
      }
    },
  }),

  terminalResize: defineAction({
    request: z.object({ terminal_id: terminalIdSchema, cols: z.number().int().min(10).max(1000), rows: z.number().int().min(4).max(500) }),
    response: terminalResultSchema,
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, error: denied };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        await pilotRequest(baseUrl, `/terminals/${encodeURIComponent(args.terminal_id)}/resize`, { method: "POST", body: JSON.stringify({ cols: args.cols, rows: args.rows }) }, z.object({ ok: z.boolean() }));
        return { ok: true, error: null };
      } catch (error) {
        return terminalFailure(error);
      }
    },
  }),

  closeTerminal: defineAction({
    request: z.object({ terminal_id: terminalIdSchema }),
    response: terminalResultSchema,
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return { ok: false, error: denied };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        await pilotRequest(baseUrl, `/terminals/${encodeURIComponent(args.terminal_id)}`, { method: "DELETE" }, z.object({ ok: z.boolean() }));
        return { ok: true, error: null };
      } catch (error) {
        return terminalFailure(error);
      }
    },
  }),


  // Host facts the client needs to build and shorten workspace paths, so it
  // never hard-codes the VM's home folder.
  getHostConfig: defineAction({
    request: z.object({}),
    response: z.object({ home_root: z.string(), workspace_root: z.string() }),
    async handler() {
      return { home_root: HOME_ROOT, workspace_root: WORKSPACE_ROOT };
    },
  }),

  // Repos the composer's repo picker can offer. The pilot asks the GitHub
  // broker; "not set up" is a normal empty answer, never an error, so the
  // picker can still accept a pasted owner/repo or github.com URL.
  listRepos: defineAction({
    request: z.object({}),
    response: z.object({
      github_enabled: z.boolean(),
      repos: z.array(z.object({
        slug: z.string(),
        name: z.string(),
        owner: z.string(),
        owner_avatar_url: z.string().nullable().optional(),
        private: z.boolean(),
        description: z.string().nullable(),
        default_branch: z.string().nullable(),
        updated_at: z.string().nullable(),
        html_url: z.string(),
      })),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        return await pilotRequest(baseUrl, "/repos", { method: "GET" }, z.object({
          enabled: z.boolean(),
          repos: z.array(z.object({
            slug: z.string(),
            name: z.string(),
            owner: z.string(),
            owner_avatar_url: z.string().nullable().optional(),
            private: z.boolean(),
            description: z.string().nullable(),
            default_branch: z.string().nullable(),
            updated_at: z.string().nullable(),
            html_url: z.string(),
          })),
        }).transform((value) => ({ github_enabled: value.enabled, repos: value.repos })), 20_000);
      } catch {
        return { github_enabled: false, repos: [] };
      }
    },
  }),

  // GitHub-side search for the repo picker: the listRepos list is bounded
  // by the broker credential (an App installation only enumerates installed
  // repos), so repos the user contributes to elsewhere — public ones like
  // google/perfetto — are only findable by asking GitHub directly.
  searchRepos: defineAction({
    request: z.object({ q: z.string().trim().min(1).max(200) }),
    response: z.object({
      github_enabled: z.boolean(),
      repos: z.array(z.object({
        slug: z.string(),
        name: z.string(),
        owner: z.string(),
        owner_avatar_url: z.string().nullable().optional(),
        private: z.boolean(),
        description: z.string().nullable(),
        default_branch: z.string().nullable(),
        updated_at: z.string().nullable(),
        html_url: z.string(),
      })),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, input) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        return await pilotRequest(baseUrl, `/repos/search?q=${encodeURIComponent(input.q)}`, { method: "GET" }, z.object({
          enabled: z.boolean(),
          repos: z.array(z.object({
            slug: z.string(),
            name: z.string(),
            owner: z.string(),
            owner_avatar_url: z.string().nullable().optional(),
            private: z.boolean(),
            description: z.string().nullable(),
            default_branch: z.string().nullable(),
            updated_at: z.string().nullable(),
            html_url: z.string(),
          })),
        }).transform((value) => ({ github_enabled: value.enabled, repos: value.repos })), 20_000);
      } catch {
        return { github_enabled: false, repos: [] };
      }
    },
  }),

  setPreviewPort: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      port: z.number().int().min(1024).max(65535).nullable(),
    }).strict(),
    response: z.object({
      ok: z.boolean(),
      port: z.number().int().nullable(),
      reachable: z.boolean().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer, "file");
      if (denied) return { ok: false, port: null, reachable: null, error: denied };
      if (args.port !== null && [443, 18790, 18791, 18792, 18793].includes(args.port)) {
        return { ok: false, port: null, reachable: null, error: `Port ${args.port} is reserved by Code Space.` };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.sessions.id, pilotSessionId: schema.sessions.pilotSessionId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, port: null, reachable: null, error: "Session not found." };
      await db
        .update(schema.sessions)
        .set({ previewPort: args.port })
        .where(eq(schema.sessions.id, args.session_id));
      let reachable: boolean | null = null;
      if (args.port !== null && session.pilotSessionId) {
        try {
          const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
          const check = await pilotRequest(
            baseUrl,
            `/sessions/${encodeURIComponent(session.pilotSessionId)}/preview/ports?port=${args.port}`,
            { method: "GET" },
            z.object({
              ports: z.array(z.object({ port: z.number(), command: z.string(), pid: z.number() })),
              activeReachable: z.boolean().nullable(),
            }),
            5_000,
          );
          reachable = check.activeReachable;
        } catch {
          reachable = false;
        }
      }
      ctx.invalidateQueries({
        queryKeys: [
          ["preview-ports", args.session_id],
        ],
      });
      return { ok: true, port: args.port, reachable, error: null };
    },
  }),

  listPreviewPorts: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
    }).strict(),
    response: z.object({
      ok: z.boolean(),
      configured_port: z.number().int().nullable(),
      reachable: z.boolean().nullable(),
      ports: z.array(z.object({
        port: z.number().int(),
        command: z.string(),
        pid: z.number().int(),
      })),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer, "file");
      if (denied) return { ok: false, configured_port: null, reachable: null, ports: [] };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          pilotSessionId: schema.sessions.pilotSessionId,
          previewPort: schema.sessions.previewPort,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, configured_port: null, reachable: null, ports: [] };
      const configuredPort = session.previewPort ?? null;
      if (!session.pilotSessionId) {
        return { ok: true, configured_port: configuredPort, reachable: configuredPort ? false : null, ports: [] };
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const query = configuredPort ? `?port=${configuredPort}` : "";
        const res = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/preview/ports${query}`,
          { method: "GET" },
          z.object({
            ports: z.array(z.object({ port: z.number().int(), command: z.string(), pid: z.number().int() })),
            activeReachable: z.boolean().nullable(),
          }),
          5_000,
        );
        return {
          ok: true,
          configured_port: configuredPort,
          reachable: res.activeReachable,
          ports: res.ports,
        };
      } catch {
        return {
          ok: true,
          configured_port: configuredPort,
          reachable: configuredPort ? false : null,
          ports: [],
        };
      }
    },
  }),

  previewProxy: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      method: z.string().min(1).max(16).default("GET"),
      path: z.string().min(1).max(4000).default("/"),
      headers: z.record(z.string(), z.string()).default({}),
      bodyBase64: z.string().max(15_000_000).nullable().default(null),
      previewBasePath: z.string().max(500).default(""),
    }).strict(),
    response: z.object({
      ok: z.boolean(),
      reachable: z.boolean(),
      port: z.number().int().nullable(),
      status: z.number().int(),
      statusText: z.string(),
      headers: z.record(z.string(), z.string()),
      bodyBase64: z.string(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer, "file");
      if (denied) {
        return { ok: false, reachable: false, port: null, status: 403, statusText: "Forbidden", headers: {}, bodyBase64: "", error: denied };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          pilotSessionId: schema.sessions.pilotSessionId,
          previewPort: schema.sessions.previewPort,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) {
        return { ok: false, reachable: false, port: null, status: 404, statusText: "Not Found", headers: {}, bodyBase64: "", error: "Session not found." };
      }
      const port = session.previewPort ?? null;
      if (port === null) {
        return { ok: false, reachable: false, port: null, status: 409, statusText: "Conflict", headers: {}, bodyBase64: "", error: "No preview port is attached to this session." };
      }
      if (!session.pilotSessionId) {
        return { ok: false, reachable: false, port, status: 502, statusText: "Bad Gateway", headers: {}, bodyBase64: "", error: `Session has not started on the pilot yet (port ${port}).` };
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const result = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/preview/request`,
          {
            method: "POST",
            body: JSON.stringify({
              port,
              method: args.method,
              path: args.path,
              headers: args.headers,
              bodyBase64: args.bodyBase64,
              previewBasePath: args.previewBasePath,
            }),
          },
          z.object({
            reachable: z.boolean(),
            status: z.number().int(),
            statusText: z.string(),
            headers: z.record(z.string(), z.string()),
            bodyBase64: z.string(),
            error: z.string().nullable(),
          }),
          20_000,
        );
        return {
          ok: result.reachable,
          reachable: result.reachable,
          port,
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
          bodyBase64: result.bodyBase64,
          error: result.error,
        };
      } catch (error) {
        return {
          ok: false,
          reachable: false,
          port,
          status: 502,
          statusText: "Bad Gateway",
          headers: {},
          bodyBase64: "",
          error: `Could not reach 127.0.0.1:${port}: ${pilotRequestErrorText(error).slice(0, 200)}`,
        };
      }
    },
  }),

  previewWs: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      cmd: z.enum(["open", "send", "poll", "close"]),
      clientId: z.string().max(120).optional(),
      path: z.string().max(2000).optional(),
      protocols: z.array(z.string().max(100)).max(10).optional(),
      data: z.string().max(1_000_000).optional(),
      since: z.record(z.string(), z.number().int().nonnegative()).optional(),
      waitMs: z.number().int().min(0).max(12_000).optional(),
    }).strict(),
    response: z.object({
      ok: z.boolean(),
      events: z.array(z.object({
        clientId: z.string(),
        seq: z.number().int(),
        event: z.enum(["open", "message", "close", "error"]),
        protocol: z.string().optional(),
        data: z.string().optional(),
        code: z.number().int().optional(),
        reason: z.string().optional(),
      })).optional(),
      nextSince: z.record(z.string(), z.number().int()).optional(),
      error: z.string().nullable().optional(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const denied = terminalAccessError(ctx.viewer, "file");
      if (denied) return { ok: false, error: denied };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          pilotSessionId: schema.sessions.pilotSessionId,
          previewPort: schema.sessions.previewPort,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session || !session.pilotSessionId || session.previewPort === null) {
        return { ok: false, error: "Preview is not active for this session." };
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/preview/ws`,
          {
            method: "POST",
            body: JSON.stringify({
              cmd: args.cmd,
              port: session.previewPort,
              clientId: args.clientId,
              path: args.path,
              protocols: args.protocols,
              data: args.data,
              since: args.since,
              waitMs: args.waitMs,
            }),
          },
          z.object({
            ok: z.boolean().optional(),
            events: z.array(z.object({
              clientId: z.string(),
              seq: z.number().int(),
              event: z.enum(["open", "message", "close", "error"]),
              protocol: z.string().optional(),
              data: z.string().optional(),
              code: z.number().int().optional(),
              reason: z.string().optional(),
            })).optional(),
            nextSince: z.record(z.string(), z.number().int()).optional(),
            error: z.string().nullable().optional(),
          }),
          15_000,
        );
        return {
          ok: res.ok ?? true,
          events: res.events,
          nextSince: res.nextSince,
          error: res.error ?? null,
        };
      } catch (error) {
        return { ok: false, error: pilotRequestErrorText(error).slice(0, 200) };
      }
    },
  }),

  getSessionVcsStatus: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
    }),
    response: z.object({
      isGitCheckout: z.boolean(),
      branch: z.string().nullable(),
      headSha: z.string().nullable(),
      uncommittedFileCount: z.number().int().nonnegative(),
      totalAdditions: z.number().int().nonnegative(),
      totalDeletions: z.number().int().nonnegative(),
      files: z.array(z.object({
        path: z.string(),
        status: z.string(),
        additions: z.number().nullable(),
        deletions: z.number().nullable(),
      })),
      smartlogCommits: z.array(z.object({
        hash: z.string(),
        parents: z.array(z.string()),
        phase: z.enum(["public", "draft"]),
        isDot: z.boolean(),
        title: z.string(),
        author: z.string(),
        date: z.string(),
        bookmarks: z.array(z.string()),
        remoteBookmarks: z.array(z.string()),
      })),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const empty = {
        isGitCheckout: false,
        branch: null,
        headSha: null,
        uncommittedFileCount: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        files: [],
        smartlogCommits: [],
      };
      try {
        const db = ctx.db<typeof schema>();
        const rows = await db
          .select({ pilotSessionId: schema.sessions.pilotSessionId })
          .from(schema.sessions)
          .where(eq(schema.sessions.id, args.session_id))
          .limit(1);
        const pilotId = rows[0]?.pilotSessionId ?? null;
        if (!pilotId) return empty;
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        return await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(pilotId)}/vcs-status`,
          { method: "GET" },
          z.object({
            isGitCheckout: z.boolean(),
            branch: z.string().nullable(),
            headSha: z.string().nullable(),
            uncommittedFileCount: z.number().int().nonnegative(),
            totalAdditions: z.number().int().nonnegative(),
            totalDeletions: z.number().int().nonnegative(),
            files: z.array(z.object({
              path: z.string(),
              status: z.string(),
              additions: z.number().nullable(),
              deletions: z.number().nullable(),
            })),
            smartlogCommits: z.array(z.object({
              hash: z.string(),
              parents: z.array(z.string()),
              phase: z.enum(["public", "draft"]),
              isDot: z.boolean(),
              title: z.string(),
              author: z.string(),
              date: z.string(),
              bookmarks: z.array(z.string()),
              remoteBookmarks: z.array(z.string()),
            })),
          }),
          8_000,
        );
      } catch {
        return empty;
      }
    },
  }),

  getRepoCloneProgress: defineAction({
    request: z.object({
      session_id: z.string().min(1),
    }),
    response: z.object({
      active: z.boolean(),
      repo: z.string().nullable(),
      phase: z.string().nullable(),
      percent: z.number().nullable(),
      transferred: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const query = new URLSearchParams({ workspaceName: args.session_id }).toString();
        return await pilotRequest(baseUrl, `/repos/clone-progress?${query}`, { method: "GET" }, z.object({
          active: z.boolean(),
          repo: z.string().nullable(),
          phase: z.string().nullable(),
          percent: z.number().nullable(),
          transferred: z.string().nullable(),
        }), 5_000);
      } catch {
        return { active: false, repo: null, phase: null, percent: null, transferred: null };
      }
    },
  }),

  listModels: defineAction({
    request: z.object({}),
    response: z.object({ models: z.array(modelResponseSchema), access_checked: z.boolean() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        return { models: await readPilotModels(baseUrl), access_checked: true };
      } catch { /* Preserve saved catalog labels, but do not infer paid access. */ }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.codingModels.id,
          display_name: schema.codingModels.displayName,
        })
        .from(schema.codingModels)
        .orderBy(asc(schema.codingModels.sortOrder), asc(schema.codingModels.id));
      return { models: rows, access_checked: false };
    },
  }),

  syncModels: defineAction({
    request: z.object({
      models: z.array(
        z.object({
          id: z.string().trim().min(1).max(200),
          display_name: z.string().trim().min(1).max(200),
        }),
      ).max(100),
    }),
    response: syncModelsResponseSchema,
    async handler(ctx, args): Promise<z.infer<typeof syncModelsResponseSchema>> {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      await db.delete(schema.codingModels);
      if (args.models.length > 0) {
        await db.insert(schema.codingModels).values(
          args.models.map((model, index) => ({
            id: model.id,
            displayName: model.display_name,
            sortOrder: index,
            updatedAt: now,
          })),
        );
      }
      ctx.invalidateQueries({ queryKey: ["code-models"] });
      return { ok: true, count: args.models.length };
    },
  }),

  // Poll while the UI is open (and on the next open after a VM restart).
  // Pending first prompts live in app.db; they aren't entrusted to a detached
  // supervisor whose wake can be lost while the pilot is down.
  recoverPendingAgents: defineAction({
    request: z.object({}),
    response: z.object({ started: z.number(), failed: z.number() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      return startOneQueuedAgent(ctx);
    },
  }),

  // A permanent pilot rejection fails visibly rather than spinning. The user
  // can retry the original, durably stored prompt after fixing the cause.
  retryAgentStart: defineAction({
    request: z.object({ id: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const updated = await db.update(schema.sessions)
        // Retry the saved agent configuration; the client cannot override it.
        .set({ status: "queued", summary: null, finishedAt: null, pilotRetryAt: null })
        .where(and(eq(schema.sessions.id, args.id), eq(schema.sessions.status, "failed"),
          isNull(schema.sessions.pilotSessionId)))
        .returning({ id: schema.sessions.id });
      if (!updated[0]) return { ok: false, error: "This session has already started or is not waiting to connect." };
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.id]] });
      return { ok: true, error: null };
    },
  }),

  listSessions: defineAction({
    request: z.object({
      limit: z.number().int().positive().max(100).default(50),
    }),
    response: z.object({
      sessions: z.array(sessionResponseSchema),
      active_count: z.number().int().nonnegative(),
    }),
    privileged: [privileged.resolvePilotUrl, privileged.listTranscripts, privileged.readTranscript],
    async handler(ctx, args) {
      // Transcript-driven list: re-register any pilot transcript that has
      // no app row before reading the DB, so past conversations survive an
      // app-state wipe. Best effort — if the pilot host is unreachable, the
      // stored rows are served as-is.
      await reconcileTranscripts(ctx, {}).catch(() => null);
      const db = ctx.db<typeof schema>();
      const activeRows = await db
        .select({ value: count() })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.archived, false),
            inArray(schema.sessions.status, ["queued", "running"]),
          ),
        );
      const rows = await db
        .select()
        .from(schema.sessions)
        .orderBy(desc(schema.sessions.updatedAt))
        .limit(args.limit);

      const sessionIds = rows.map((row) => row.id);
      const prEventRows = sessionIds.length > 0
        ? await db
            .select({
              sessionId: schema.outputEvents.sessionId,
              kind: schema.outputEvents.kind,
              content: schema.outputEvents.content,
              toolDetails: schema.outputEvents.toolDetails,
            })
            .from(schema.outputEvents)
            .where(
              and(
                inArray(schema.outputEvents.sessionId, sessionIds),
                or(
                  eq(schema.outputEvents.kind, "pr_monitor"),
                  and(
                    eq(schema.outputEvents.kind, "tool"),
                    sql`${schema.outputEvents.toolDetails} LIKE '%github.com/%/pull/%'`,
                  ),
                ),
              ),
            )
            .orderBy(asc(schema.outputEvents.id))
        : [];
      const prEventsBySession = new Map<string, Array<{ kind: string; content: string; tool_details: ToolDetails | null }>>();
      for (const ev of prEventRows) {
        let list = prEventsBySession.get(ev.sessionId);
        if (!list) {
          list = [];
          prEventsBySession.set(ev.sessionId, list);
        }
        list.push({
          kind: ev.kind,
          content: ev.content,
          tool_details: ev.kind === "tool" ? parseToolDetails(ev.toolDetails) : null,
        });
      }

      const sessions = await Promise.all(
        rows.map(async (row) => {
          const visibleEventFilter = and(
            eq(schema.outputEvents.sessionId, row.id),
            ne(schema.outputEvents.kind, "result"),
          );
          const countRows = await db
            .select({ value: count() })
            .from(schema.outputEvents)
            .where(visibleEventFilter);
          const latestRows = await db
            .select({ content: schema.outputEvents.content, kind: schema.outputEvents.kind })
            .from(schema.outputEvents)
            .where(visibleEventFilter)
            .orderBy(desc(schema.outputEvents.id))
            .limit(1);
          const latest = previewText(latestRows[0]);
          const ownedPrs = ownedPullRequestsFromEvents(prEventsBySession.get(row.id) ?? []);
          return {
            id: row.id,
            title: row.title,
            prompt: row.prompt,
            workspace_root: row.workspaceRoot ?? defaultWorkspaceRoot(row.id),
            pilot_session_id: row.pilotSessionId,
            model_id: row.modelId,
            reasoning_effort: row.reasoningEffort,
            status: row.status,
            summary: row.summary,
            session_summary: row.sessionSummary,
            started_at: row.startedAt.toISOString(),
            updated_at: row.updatedAt.toISOString(),
            finished_at: row.finishedAt?.toISOString() ?? null,
            archived: row.archived,
            archived_at: row.archivedAt?.toISOString() ?? null,
            restored_at: row.restoredAt?.toISOString() ?? null,
            needs_you: row.needsUserInput || row.status === "failed",
            output_revision: row.outputRevision,
            seen_output_revision: row.seenOutputRevision,
            output_count: countRows[0]?.value ?? 0,
            latest_output: latest ? latest.slice(0, 220) : null,
            project_id: row.projectId ?? null,
            repo_slug: row.repoSlug ?? null,
            git_author: row.gitAuthorName && row.gitAuthorEmail ? { name: row.gitAuthorName, email: row.gitAuthorEmail } : null,
            preview_port: row.previewPort ?? null,
            owned_prs: ownedPrs,
          };
        }),
      );
      return { sessions, active_count: activeRows[0]?.value ?? 0 };
    },
  }),

  getSession: defineAction({
    request: z.object({
      id: z.string().min(1),
      event_limit: z.number().int().positive().max(2000).default(1000),
      after_id: z.number().int().nonnegative().optional(),
    }),
    response: z.object({
      session: sessionResponseSchema.nullable(),
      events: z.array(eventResponseSchema),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.id))
        .limit(1);
      const row = rows[0];
      if (!row) return { session: null, events: [] };

      const events = await db
        .select()
        .from(schema.outputEvents)
        .where(
          and(
            eq(schema.outputEvents.sessionId, args.id),
            ne(schema.outputEvents.kind, "result"),
            ...(args.after_id !== undefined ? [gt(schema.outputEvents.id, args.after_id)] : []),
          ),
        )
        .orderBy(desc(schema.outputEvents.id))
        .limit(args.event_limit);
      // The bottom must contain the latest event even for long transcripts;
      // otherwise viewing its "bottom" could acknowledge output not shown.
      events.reverse();
      const latest = previewText(events[events.length - 1]);

      return {
        session: {
          id: row.id,
          title: row.title,
          prompt: row.prompt,
          workspace_root: row.workspaceRoot ?? defaultWorkspaceRoot(row.id),
          pilot_session_id: row.pilotSessionId,
          model_id: row.modelId,
          reasoning_effort: row.reasoningEffort,
          status: row.status,
          summary: row.summary,
          session_summary: row.sessionSummary,
          started_at: row.startedAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
          finished_at: row.finishedAt?.toISOString() ?? null,
          archived: row.archived,
          archived_at: row.archivedAt?.toISOString() ?? null,
          restored_at: row.restoredAt?.toISOString() ?? null,
          needs_you: row.needsUserInput || row.status === "failed",
          output_revision: row.outputRevision,
          seen_output_revision: row.seenOutputRevision,
          output_count: events.length,
          latest_output: latest ? latest.slice(0, 220) : null,
          project_id: row.projectId ?? null,
          repo_slug: row.repoSlug ?? null,
          git_author: row.gitAuthorName && row.gitAuthorEmail ? { name: row.gitAuthorName, email: row.gitAuthorEmail } : null,
          preview_port: row.previewPort ?? null,
        },
        events: events.map((event) => ({
          id: event.id,
          kind: event.kind,
          content: event.content,
          created_at: event.createdAt.toISOString(),
          system_is_error: event.kind === "system" && event.systemIsError,
          started_at: event.startedAt?.toISOString() ?? null,
          finished_at: event.finishedAt?.toISOString() ?? null,
          tool_details: event.kind === "tool" ? parseToolDetails(event.toolDetails) : null,
          ...(event.kind === "user" ? { attachments: parseUserAttachments(event.toolDetails) } : {}),
        })),
      };
    },
  }),

  // Fetch a stored tool output page only when the user explicitly asks to
  // expand beyond the bounded transcript-visible output. Never trust a ref
  // supplied by the browser: it must come from this session's tool row.
  readToolOutputPage: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      event_id: z.number().int().positive(),
      offset_bytes: z.number().int().nonnegative(),
      source: z.enum(["output", "patch"]).default("output"),
    }),
    response: z.object({
      ok: z.boolean(), content: z.string(), encoding: z.enum(["utf8", "base64"]).nullable(),
      media_type: z.string().nullable(), byte_len: z.number().int().nonnegative(), offset_bytes: z.number().int().nonnegative(),
      eof: z.boolean(), error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const empty = (error: string) => ({ ok: false, content: "", encoding: null as null, media_type: null as null, byte_len: 0, offset_bytes: args.offset_bytes, eof: true, error });
      const denied = terminalAccessError(ctx.viewer);
      if (denied) return empty(denied);
      const db = ctx.db<typeof schema>();
      const session = (await db.select({ pilotSessionId: schema.sessions.pilotSessionId })
        .from(schema.sessions).where(eq(schema.sessions.id, args.session_id)).limit(1))[0];
      const event = (await db.select({ itemId: schema.outputEvents.itemId, toolDetails: schema.outputEvents.toolDetails })
        .from(schema.outputEvents)
        .where(and(eq(schema.outputEvents.id, args.event_id), eq(schema.outputEvents.sessionId, args.session_id), eq(schema.outputEvents.kind, "tool")))
        .limit(1))[0];
      const details = parseToolDetails(event?.toolDetails ?? null);
      const ref = args.source === "patch" ? details?.patchRef : details?.outputRef;
      if (!session?.pilotSessionId || !event?.itemId || !ref || ref.availability !== "available") {
        return empty(args.source === "patch" ? "An applied patch is not available for this call." : "Full tool output is not available for this call.");
      }
      if (args.source === "patch" && (ref.kind !== "tool_patch" || ref.mediaType !== "application/json" || ref.byteLen > 4 * 1024 * 1024)) {
        return empty("Patch format is unsupported or exceeds the 4 MiB preview limit.");
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const page = await pilotRequest(baseUrl, `/sessions/${encodeURIComponent(session.pilotSessionId)}/tools/output`, {
          method: "POST",
          body: JSON.stringify({ itemId: event.itemId, outputRef: ref.id, offsetBytes: args.offset_bytes, lengthBytes: 256 * 1024 }),
        }, z.object({
          content: z.string(), encoding: z.enum(["utf8", "base64"]), mediaType: z.string().optional(), byteLen: z.number().int().nonnegative(),
          offsetBytes: z.number().int().nonnegative(), eof: z.boolean(),
        }));
        if (args.source === "patch" && (page.encoding !== "utf8" || page.mediaType !== "application/json")) return empty("Patch is not UTF-8 JSON.");
        return { ok: true, content: page.content, encoding: page.encoding, media_type: page.mediaType ?? null, byte_len: page.byteLen,
          offset_bytes: page.offsetBytes, eof: page.eof, error: null };
      } catch (error) {
        return empty(pilotRequestErrorText(error));
      }
    },
  }),

  // Acknowledge only output that the client actually rendered while at the
  // bottom. Clamp to the current revision so racing new events stay unread;
  // max makes out-of-order acknowledgements monotonic across windows.
  markAgentSeen: defineAction({
    request: z.object({ id: z.string().min(1).max(200), output_revision: z.number().int().nonnegative() }),
    response: z.object({ ok: z.boolean(), seen_output_revision: z.number().int().nonnegative(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.update(schema.sessions)
        .set({ seenOutputRevision: sql`max(${schema.sessions.seenOutputRevision}, min(${schema.sessions.outputRevision}, ${args.output_revision}))` })
        .where(eq(schema.sessions.id, args.id))
        .returning({ seenOutputRevision: schema.sessions.seenOutputRevision });
      if (!rows[0]) return { ok: false, seen_output_revision: 0, error: "Session not found" };
      return { ok: true, seen_output_revision: rows[0].seenOutputRevision, error: null };
    },
  }),

  listProjects: defineAction({
    request: z.object({}),
    response: z.object({ projects: z.array(projectResponseSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projects)
        .orderBy(asc(schema.projects.name));
      return {
        projects: await Promise.all(
          rows.map(async (row) => {
            const references = await db
              .select()
              .from(schema.projectReferences)
              .where(eq(schema.projectReferences.projectId, row.id))
              .orderBy(asc(schema.projectReferences.createdAt));
            const filed = await db
              .select({ id: schema.sessions.id })
              .from(schema.sessions)
              .where(eq(schema.sessions.projectId, row.id));
            return {
              id: row.id,
              name: row.name,
              description: row.description,
              color: row.color,
              briefing: row.briefing,
              created_at: row.createdAt.toISOString(),
              updated_at: row.updatedAt.toISOString(),
              references: references.map((ref) => ({
                id: ref.id,
                label: ref.label,
                target: ref.target,
              })),
              session_count: filed.length,
            };
          }),
        ),
      };
    },
  }),

  createProject: defineAction({
    request: z.object({
      project_id: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(2000).default(""),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      briefing: z.string().max(8000).default(""),
    }),
    response: z.object({ ok: z.boolean(), id: z.string().nullable(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      // Projects created without a color (e.g. by the assistant) get a
      // stable one derived from their id.
      let hash = 0;
      for (let i = 0; i < args.project_id.length; i++) hash = (hash * 31 + args.project_id.charCodeAt(i)) >>> 0;
      const color = args.color ?? `hsl(${hash % 360} 45% 45%)`;
      const inserted = await db
        .insert(schema.projects)
        .values({ id: args.project_id, name: args.name, description: args.description, color, briefing: args.briefing, createdAt: now, updatedAt: now })
        .returning({ id: schema.projects.id });
      if (!inserted[0]) return { ok: false, id: null, error: "Project was not created" };
      ctx.invalidateQueries({ queryKey: ["code-projects"] });
      return { ok: true, id: inserted[0].id, error: null };
    },
  }),

  updateProject: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(2000),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      briefing: z.string().max(8000).optional(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.projects)
        .set({ name: args.name, description: args.description, ...(args.color !== undefined ? { color: args.color } : {}), ...(args.briefing !== undefined ? { briefing: args.briefing } : {}), updatedAt: new Date() })
        .where(eq(schema.projects.id, args.id))
        .returning({ id: schema.projects.id });
      if (updated.length === 0) return { ok: false, error: "Project not found" };
      ctx.invalidateQueries({ queryKey: ["code-projects"] });
      return { ok: true, error: null };
    },
  }),

  deleteProject: defineAction({
    request: z.object({ id: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.sessions)
        .set({ projectId: null })
        .where(eq(schema.sessions.projectId, args.id));
      await db.delete(schema.projectReferences).where(eq(schema.projectReferences.projectId, args.id));
      const deleted = await db
        .delete(schema.projects)
        .where(eq(schema.projects.id, args.id))
        .returning({ id: schema.projects.id });
      if (deleted.length === 0) return { ok: false, error: "Project not found" };
      ctx.invalidateQueries({ queryKeys: [["code-projects"], ["code-sessions"]] });
      return { ok: true, error: null };
    },
  }),

  createProjectReference: defineAction({
    request: z.object({
      reference_id: z.string().trim().min(1).max(200),
      project_id: z.string().trim().min(1).max(200),
      label: z.string().trim().min(1).max(200),
      target: z.string().trim().min(1).max(2000),
    }),
    response: z.object({ ok: z.boolean(), id: z.string().nullable(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const project = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, args.project_id))
        .limit(1);
      if (!project[0]) return { ok: false, id: null, error: "Project not found" };
      const inserted = await db
        .insert(schema.projectReferences)
        .values({
          id: args.reference_id,
          projectId: args.project_id,
          label: args.label,
          target: args.target,
          createdAt: new Date(),
        })
        .returning({ id: schema.projectReferences.id });
      if (!inserted[0]) return { ok: false, id: null, error: "Reference was not added" };
      await db
        .update(schema.projects)
        .set({ updatedAt: new Date() })
        .where(eq(schema.projects.id, args.project_id));
      ctx.invalidateQueries({ queryKey: ["code-projects"] });
      return { ok: true, id: inserted[0].id, error: null };
    },
  }),

  deleteProjectReference: defineAction({
    request: z.object({ id: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.projectReferences)
        .where(eq(schema.projectReferences.id, args.id))
        .returning({ id: schema.projectReferences.id });
      if (deleted.length === 0) return { ok: false, error: "Reference not found" };
      ctx.invalidateQueries({ queryKey: ["code-projects"] });
      return { ok: true, error: null };
    },
  }),

  setSessionProject: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      project_id: z.string().trim().min(1).max(200).nullable(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.project_id !== null) {
        const project = await db
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.id, args.project_id))
          .limit(1);
        if (!project[0]) return { ok: false, error: "Project not found" };
      }
      const updated = await db
        .update(schema.sessions)
        .set({ projectId: args.project_id })
        .where(eq(schema.sessions.id, args.session_id))
        .returning({ id: schema.sessions.id, pilotSessionId: schema.sessions.pilotSessionId });
      if (updated.length === 0) return { ok: false, error: "Session not found" };
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.session_id]] });
      // Match the SOUL handoff: the (new) project's briefing is seeded into
      // the live conversation's next turn, hidden from the transcript.
      const pilotSessionId = updated[0]?.pilotSessionId;
      if (pilotSessionId) {
        try {
          const briefing = await projectBriefingFor(db, args.project_id);
          const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
          await pilotRequest(baseUrl, `/sessions/${encodeURIComponent(pilotSessionId)}/briefing`,
            { method: "POST", body: JSON.stringify({ briefing }) }, z.object({ ok: z.boolean() }));
        } catch { /* filing still succeeded; the briefing just won't seed */ }
      }
      return { ok: true, error: null };
    },
  }),

  listCustomCompanions: defineAction({
    request: z.object({}),
    response: z.object({ companions: z.array(customCompanionResponseSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await listCustomCompanionRows(db);
      return { companions: rows.map(customToResponse) };
    },
  }),

  // Global lifetime statistics per companion, read only from the statistics
  // tables (no transcript access). Companions with no tracked work yet
  // report zeros.
  getCompanionStatistics: defineAction({
    request: z.object({}),
    response: z.object({
      statistics: z.array(z.object({
        companion_id: z.string(),
        prs_created: z.number().int().nonnegative(),
        prs_merged: z.number().int().nonnegative(),
        prs_closed: z.number().int().nonnegative(),
        prs_open: z.number().int().nonnegative(),
        merge_rate: z.number().min(0).max(1).nullable(),
        lines_added: z.number().int().nonnegative(),
        lines_removed: z.number().int().nonnegative(),
        net_lines: z.number().int(),
        files_changed: z.number().int().nonnegative(),
        tool_calls: z.number().int().nonnegative(),
        user_turns: z.number().int().nonnegative(),
        runtime_ms: z.number().int().nonnegative(),
        last_active_at: z.string().nullable(),
      })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const companions = await assignableCompanions(db);
      const counterRows = await db.select().from(schema.companionStatistics);
      const countersById = new Map(counterRows.map((row) => [row.companionId, row]));
      const prRows = await db.select().from(schema.companionTrackedPrs);
      const prsByCompanion = new Map<string, TrackedPr[]>();
      for (const row of prRows) {
        const tracked: TrackedPr = {
          companionId: row.companionId, repo: row.repo, number: row.prNumber, state: row.state,
          linesCounted: row.linesCounted, additions: row.additions, deletions: row.deletions, filesChanged: row.filesChanged,
        };
        const list = prsByCompanion.get(row.companionId) ?? [];
        list.push(tracked);
        prsByCompanion.set(row.companionId, list);
      }
      return {
        statistics: companions.map((companion) => {
          const counters = countersById.get(companion.id);
          return summarizeCompanionStatistics(companion.id, counters ? {
            linesAdded: counters.linesAdded,
            linesRemoved: counters.linesRemoved,
            filesChanged: counters.filesChanged,
            toolCalls: counters.toolCalls,
            userTurns: counters.userTurns,
            runtimeMs: counters.runtimeMs,
            lastActiveAt: counters.lastActiveAt?.toISOString() ?? null,
          } : null, prsByCompanion.get(companion.id) ?? []);
        }),
      };
    },
  }),

  createCompanion: defineAction({
    request: z.object({
      companion_id: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(40),
      icon_id: z.string().trim().min(1).max(100),
      role: z.string().trim().max(80).default(""),
      description: z.string().trim().max(240).default(""),
      skills: z.array(z.string().trim().min(1).max(40)).max(3).default([]),
      icon_data_url: z.string().startsWith("data:image/").max(2_800_000).optional(),
      trade_off: z.string().trim().max(240).default(""),
      soul: z.string().max(8000).default(""),
      model_id: z.string().trim().min(1).max(200),
      effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]),
    }).strict(),
    response: z.object({ ok: z.boolean(), companion: customCompanionResponseSchema.nullable(), error: z.string().nullable() }),
    async handler(ctx, args) {
      if (isReservedAgentName(args.name)) {
        return { ok: false, companion: null, error: "That name is reserved for your Muse assistant." };
      }
      const customImage = args.icon_data_url ?? null;
      const donor = customImage ? null : companionCatalog.companions.find((item) => item.id === args.icon_id);
      if (!customImage && !donor) return { ok: false, companion: null, error: "Pick an icon from the list." };
      const db = ctx.db<typeof schema>();
      const nameKey = companionNameKey(args.name);
      const catalogTaken = companionCatalog.companions.some((item) => companionNameKey(item.name) === nameKey);
      const customs = await listCustomCompanionRows(db);
      if (!customImage && donor && ((BUILTIN_COMPANION_IDS as readonly string[]).includes(donor.id)
        || customs.some((row) => row.iconId === donor.id))) {
        return { ok: false, companion: null, error: "That icon is already used by another companion." };
      }
      if (customs.length >= CUSTOM_COMPANION_LIMIT) {
        return { ok: false, companion: null, error: `You can create up to ${CUSTOM_COMPANION_LIMIT} companions.` };
      }
      if (catalogTaken || customs.some((row) => companionNameKey(row.name) === nameKey)) {
        return { ok: false, companion: null, error: "A companion with that name already exists." };
      }
      const sessionTitles = await db.select({ title: schema.sessions.title }).from(schema.sessions);
      if (sessionTitles.some((row) => companionNameKey(row.title) === nameKey)) {
        return { ok: false, companion: null, error: "That name is already used by a task." };
      }
      const now = new Date();
      const inserted = await db.insert(schema.customCompanions).values({
        id: args.companion_id,
        name: args.name,
        iconId: customImage ? "custom" : donor!.id,
        iconDataUrl: customImage,
        character: customImage ? "Custom image" : donor!.character,
        role: args.role,
        description: args.description,
        skills: JSON.stringify(args.skills),
        tradeOff: args.trade_off,
        soul: args.soul,
        modelId: args.model_id,
        effort: args.effort,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const row = inserted[0];
      if (!row) return { ok: false, companion: null, error: "Companion was not created" };
      ctx.invalidateQueries({ queryKey: ["custom-companions"] });
      return { ok: true, companion: customToResponse(row), error: null };
    },
  }),

  createSession: defineAction({
    request: z.object({
      session_id: z.string().trim().min(1).max(200),
      // A fixed-roster agent name; omitted chooses the first available agent.
      title: z.string().trim().min(1).max(200).optional(),
      prompt: z.string().trim().min(1).max(20000),
      workspaceRoot: z.string().trim().min(1).max(2000),
      project_id: z.string().trim().min(1).max(200).nullable().optional(),
      // Repo picked before the first message (`owner/repo` or a github.com
      // URL); the pilot clones it into the workspace before starting.
      repo: z.string().trim().min(1).max(300).nullable().optional(),
      // Per-checkout commit author override (requires `repo`); the pilot
      // writes it as repo-local git config after cloning.
      git_author: z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().min(3).max(200),
      }).nullable().optional(),
      attachments: z.array(attachmentInputSchema).max(8).optional(),
    }).strict(),
    response: createSessionResponseSchema,
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args): Promise<z.infer<typeof createSessionResponseSchema>> {
      const db = ctx.db<typeof schema>();
      const workspace = resolveWorkspaceRoot(args.workspaceRoot);
      if (!workspace.ok) {
        return {
          ok: false,
          id: null,
          start_status: null,
          error: workspace.error,
        };
      }
      const repoSlug = args.repo == null ? null : parseRepoSlug(args.repo);
      if (args.repo != null && !repoSlug) {
        return {
          ok: false,
          id: null,
          start_status: null,
          error: "Pick a repository as owner/repo or a github.com URL.",
        };
      }
      if (args.git_author != null && !repoSlug) {
        return { ok: false, id: null, start_status: null, error: "A commit author override needs a picked repository." };
      }
      if (args.git_author != null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.git_author.email)) {
        return { ok: false, id: null, start_status: null, error: "Provide a valid author email for this checkout." };
      }
      // Generated short paths cannot accidentally be assigned to two app
      // sessions. Explicitly chosen shared project directories stay allowed.
      if (isGeneratedWorkspaceRoot(args.session_id, workspace.path, WORKSPACE_ROOT)) {
        const occupied = await db.select({ id: schema.sessions.id }).from(schema.sessions)
          .where(eq(schema.sessions.workspaceRoot, workspace.path)).limit(1);
        if (occupied.length) {
          return { ok: false, id: null, start_status: null, error: "This generated working directory is already in use. Start a new session." };
        }
      }
      const now = new Date();
      const id = args.session_id;
      const existing = await db.select({ title: schema.sessions.title, archived: schema.sessions.archived }).from(schema.sessions);
      const assignable = await assignableCompanions(db);
      const agent = args.title
        ? assignable.find((item) => companionNameKey(item.name) === companionNameKey(args.title!))
        : assignable.find((item) => !existing.some((row) => !row.archived && companionNameKey(row.title) === companionNameKey(item.name)));
      if (!agent) return { ok: false, id: null, start_status: null, error: args.title ? "Agent not found in the roster." : "No agents are available." };
      const agentName = agent.name;
      const models = await db.select().from(schema.codingModels).orderBy(asc(schema.codingModels.sortOrder));
      let modelId: string;
      try { modelId = await resolveCompanionModel(ctx, agent, models); }
      catch (error) { return { ok: false, id: null, start_status: null, error: pilotRequestErrorText(error), retryable: isPilotUnavailable(error) }; }
      const effort = reasoningEffortSchema.parse(agent.effort);
      const release = lockCompanionAssignment(id, agentName);
      if (!release) return { ok: false, id: null, start_status: null, error: "This agent is being assigned. Try again in a moment." };
      try {
        const taken = await db.select({ id: schema.sessions.id }).from(schema.sessions)
          .where(and(ne(schema.sessions.id, id), eq(schema.sessions.archived, false),
            sql`lower(trim(${schema.sessions.title})) = ${agentName.trim().toLowerCase()}`)).limit(1);
        if (taken.length) return { ok: false, id: null, start_status: null, error: `${agentName} is already assigned to a session.` };
        let projectId: string | null = null;
        let briefing: string | null = null;
        if (args.project_id != null) {
          const projectRows = await db
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.id, args.project_id))
            .limit(1);
          const project = projectRows[0];
          if (!project) {
            return { ok: false, id: null, start_status: null, error: "Project not found" };
          }
          const refs = await db
            .select()
            .from(schema.projectReferences)
            .where(eq(schema.projectReferences.projectId, project.id))
            .orderBy(asc(schema.projectReferences.createdAt));
          projectId = project.id;
          briefing = buildProjectBriefing({
            name: project.name,
            description: project.description,
            references: refs.map((ref) => ({ label: ref.label, target: ref.target })),
            briefing: project.briefing,
          });
        }
        // The project briefing travels to the pilot separately (first-turn
        // preamble), so the stored prompt and the displayed first message
        // stay exactly what the user wrote.
        const prompt = args.prompt;
        const inserted = await db
          .insert(schema.sessions)
          .values({
            id,
            title: agentName,
            prompt,
            projectId,
            workspaceRoot: workspace.path,
            repoSlug,
            gitAuthorName: args.git_author?.name ?? null,
            gitAuthorEmail: args.git_author?.email ?? null,
            status: "queued",
            pilotRetryAt: new Date(Date.now() + (repoSlug ? REPO_CLONE_START_LEASE_MS : PILOT_START_LEASE_MS)),
            startedAt: now,
            updatedAt: now,
            archived: false,
            modelId,
            requestedModelId: modelId,
            reasoningEffort: effort,
          })
          .returning({ id: schema.sessions.id });
        const session = inserted[0];
        if (!session) {
          return {
            ok: false,
            id: null,
            start_status: null,
            error: "Session was not created",
          };
        }

        // A second process may have inserted another claim between our first
        // check and insertion. Refuse before starting either conflicting turn.
        const conflicts = await db.select({ id: schema.sessions.id }).from(schema.sessions)
          .where(and(ne(schema.sessions.id, id), eq(schema.sessions.archived, false),
            sql`lower(trim(${schema.sessions.title})) = ${agentName.trim().toLowerCase()}`)).limit(1);
        if (conflicts.length) {
          await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
          return { ok: false, id: null, start_status: null, error: `${agentName} is already assigned to a session.` };
        }

        await db.insert(schema.outputEvents).values({
          sessionId: session.id,
          kind: "user",
          content: prompt,
          toolDetails: serializeUserAttachments(args.attachments),
          createdAt: now,
        });
        await guardCompanionStatistics(async () => {
          await bumpCompanionStatistics(db, agent.id, { userTurns: 1 }, now);
        });

        try {
          const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
          const pilot = await startPilotAgent(baseUrl, {
            id: session.id,
            title: agentName,
            prompt,
            workspaceRoot: workspace.path,
            repoSlug,
            gitAuthorName: args.git_author?.name ?? null,
            gitAuthorEmail: args.git_author?.email ?? null,
            modelId,
            requestedModelId: modelId,
            reasoningEffort: effort,
            soul: agent.soul,
            projectBriefing: briefing,
            attachments: args.attachments,
          });
          if (!pilot.turnId) throw new Error("Pilot has not admitted the first turn yet");
          await db
            .update(schema.sessions)
            .set({
              status: "running",
              pilotSessionId: pilot.sessionId,
              pilotSeq: 0,
              pilotRetryAt: null,
              ...(pilot.modelId ? { modelId: pilot.modelId } : {}),
              ...(pilot.name ? { title: pilot.name } : {}),
            })
            .where(eq(schema.sessions.id, session.id));
          ctx.invalidateQueries({ queryKeys: [["code-sessions"]] });
          return {
            ok: true,
            id: session.id,
            start_status: "waking",
            error: null,
          };
        } catch {
          // The first prompt is in app.db. Keep this row queued and retry
          // through recoverPendingAgents when the pilot returns. No detached
          // supervisor is spawned: two independent owners could run it twice.
        }

        await db.insert(schema.outputEvents).values({
          sessionId: session.id,
          kind: "system",
          content: "Connecting… Your first message is saved and will be sent automatically.",
          createdAt: new Date(),
        });
        await db.update(schema.sessions)
          .set({ pilotRetryAt: new Date(Date.now() + PILOT_START_RETRY_MS) })
          .where(eq(schema.sessions.id, session.id));
        ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", session.id]] });
        return { ok: true, id: session.id, start_status: "waiting", error: null };
      } finally {
        release();
      }
    },
  }),

  // Permanently delete a session: the pilot's transcript and registry entry
  // first, then the app's rows (session + transcript events). Refused while a
  // turn is running. If the pilot can't confirm, nothing is deleted, so a
  // retry can finish the job instead of leaving the pilot transcript behind.
  deleteSession: defineAction({
    request: z.object({ id: z.string().min(1).max(200) }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.sessions.id,
          status: schema.sessions.status,
          pilotSessionId: schema.sessions.pilotSessionId,
          workspaceRoot: schema.sessions.workspaceRoot,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: true, error: null };
      if (session.status === "queued" || session.status === "running") {
        return { ok: false, error: "Stop this session before deleting it." };
      }
      // Its terminal (if one was opened) goes before removing the workspace.
      await killSessionTerminal(ctx, session.id);
      if (session.pilotSessionId || session.workspaceRoot) {
        try {
          const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
          const targetId = session.pilotSessionId ?? session.id;
          const query = session.workspaceRoot
            ? `?${new URLSearchParams({ workspaceRoot: session.workspaceRoot }).toString()}`
            : "";
          await pilotRequest(
            baseUrl,
            `/sessions/${encodeURIComponent(targetId)}${query}`,
            { method: "DELETE" },
            z.object({ ok: z.boolean() }),
          );
        } catch (error) {
          const code = (error as Error & { code?: string }).code;
          if (code === "turn_running") return { ok: false, error: "Stop this session before deleting it." };
          if (session.pilotSessionId) {
            return { ok: false, error: `Couldn't delete the session transcript (${pilotRequestErrorText(error).slice(0, 200)}). Nothing was deleted; try again.` };
          }
        }
      }
      await db.delete(schema.outputEvents).where(eq(schema.outputEvents.sessionId, session.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", session.id]] });
      return { ok: true, error: null };
    },
  }),

  setSessionArchived: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      archived: z.boolean(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.sessions.id, title: schema.sessions.title, status: schema.sessions.status,
          archived: schema.sessions.archived, restoredAt: schema.sessions.restoredAt,
          modelId: schema.sessions.modelId,
          needsUserInput: schema.sessions.needsUserInput })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, error: "Session not found" };
      if (args.archived && (session.status === "queued" || session.status === "running")) {
        return { ok: false, error: "Stop or finish this session before archiving it" };
      }
      const release = lockCompanionAssignment(session.id, session.title);
      if (!release) return { ok: false, error: "This session or agent is being assigned. Try again in a moment." };
      try {
        if (!args.archived && Object.hasOwn(PAID_COMPANION_MODELS, session.modelId)) {
          try {
            const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
            await requirePaidModelAccess(baseUrl, session.modelId);
          } catch (error) { return { ok: false, error: pilotRequestErrorText(error) }; }
        }
        const now = new Date();
        const updated = await db
          .update(schema.sessions)
          .set({
            archived: args.archived,
            archivedAt: args.archived ? now : null,
            // Restore to Active without pretending a new prompt/reply arrived.
            restoredAt: args.archived ? null : session.archived ? now : session.restoredAt,
            needsUserInput: args.archived ? false : session.needsUserInput,
          })
          .where(and(eq(schema.sessions.id, args.id), eq(schema.sessions.title, session.title), eq(schema.sessions.archived, session.archived),
            eq(schema.sessions.status, session.status), args.archived ? sql`1 = 1` : companionIsFreeCondition(session.id, session.title)))
          .returning({ id: schema.sessions.id });
        if (!updated.length) return { ok: false, error: args.archived ? "The session changed. Refresh and try again." : companionBusyMessage(session.title) };
        // Archiving ends the session's terminal (resuming starts a fresh one).
        if (args.archived) await killSessionTerminal(ctx, args.id);
        ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.id]] });
        return { ok: true, error: null };
      } finally {
        release();
      }
    },
  }),

  // The user's Muse assistant may attach a short, transcript-based sentence
  // later. Missing summaries are normal; this action never changes activity.
  setSessionSummary: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      summary: z.string().max(1000).nullable(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const summary = args.summary?.replace(/\s+/g, " ").trim() || null;
      if (summary && summary.length > 240) {
        return { ok: false, error: "Session summaries must be 240 characters or less." };
      }
      const db = ctx.db<typeof schema>();
      const updated = await db.update(schema.sessions)
        .set({ sessionSummary: summary })
        .where(eq(schema.sessions.id, args.id))
        .returning({ id: schema.sessions.id });
      if (updated.length === 0) return { ok: false, error: "Session not found" };
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.id]] });
      return { ok: true, error: null };
    },
  }),

  assignAgent: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      agent_id: z.string().min(1).max(200),
    }).strict(),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const companion = await assignableCompanionById(ctx.db<typeof schema>(), args.agent_id);
      if (!companion) return { ok: false, error: "Agent not found." };
      const release = lockCompanionAssignment(args.id, companion.name);
      if (!release) {
        return { ok: false, error: "A handoff is already in progress. Try again in a moment." };
      }
      try {
        const db = ctx.db<typeof schema>();
        const sessions = await db.select().from(schema.sessions);
        const session = sessions.find((item) => item.id === args.id);
        if (!session) return { ok: false, error: "Task not found." };
        if (session.status === "running" || session.status === "queued") {
          return { ok: false, error: "Stop the current turn before assigning another agent." };
        }
        if (sessions.some((item) => item.id !== session.id && !item.archived && item.title.trim().toLowerCase() === companion.name.toLowerCase())) {
          return { ok: false, error: `${companion.name} is already assigned to a session.` };
        }
        if (session.title === companion.name) return { ok: true, error: null };
        const models = await db.select().from(schema.codingModels).orderBy(asc(schema.codingModels.sortOrder));
        if (!models.length && companion.model.ifUnavailable !== "upgrade-required") {
          return { ok: false, error: "Connect to load the available models before assigning another agent." };
        }
        let modelId: string;
        try { modelId = await resolveCompanionModel(ctx, companion, models); }
        catch (error) { return { ok: false, error: pilotRequestErrorText(error) }; }
        const effort = reasoningEffortSchema.parse(companion.effort);
        let baseUrl: string | null = null;
        try {
          if (session.pilotSessionId) {
            ({ baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {}));
            const renamed = await pilotRequest(baseUrl, `/sessions/${encodeURIComponent(session.pilotSessionId)}/rename`,
              { method: "POST", body: JSON.stringify({ name: companion.name, soul: companion.soul }) }, z.object({ name: z.string() }));
            if (renamed.name !== companion.name) throw new Error("The pilot could not use the selected agent's name.");
          }
          // Claim only if the task stayed idle and the target is still free.
          // Keep its identity, workspace, history, project, and activity time.
          const updated = await db.update(schema.sessions).set({
            title: companion.name, modelId, requestedModelId: modelId, reasoningEffort: effort,
          }).where(and(
            eq(schema.sessions.id, session.id), eq(schema.sessions.title, session.title),
            eq(schema.sessions.status, session.status), eq(schema.sessions.archived, session.archived),
            companionIsFreeCondition(session.id, companion.name),
          )).returning({ id: schema.sessions.id });
          if (!updated.length) throw new Error("The session or agent changed. Refresh and try again.");
        } catch (error) {
          if (baseUrl && session.pilotSessionId) {
            try {
              await pilotRequest(baseUrl, `/sessions/${encodeURIComponent(session.pilotSessionId)}/rename`,
                { method: "POST", body: JSON.stringify({ name: session.title }) }, z.object({ name: z.string() }));
            } catch {
              return { ok: false, error: "The handoff failed and the pilot could not restore the previous name. Reconnect and refresh before continuing." };
            }
          }
          return { ok: false, error: `Could not assign the agent: ${pilotRequestErrorText(error).slice(0, 200)}` };
        }
        ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.id]] });
        return { ok: true, error: null };
      } finally {
        release();
      }
    },
  }),

  upsertSession: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      title: z.string().min(1).max(200),
      prompt: z.string().min(1).max(20000),
      status: statusSchema.default("queued"),
    }),
    response: z.object({ ok: z.literal(true), id: z.string() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args): Promise<{ ok: true; id: string }> {
      const agent = await assignableCompanionByName(ctx.db<typeof schema>(), args.title);
      if (!agent) throw new Error("Agent not found in the roster.");
      const release = lockCompanionAssignment(args.id, agent.name);
      if (!release) throw new Error("This session or agent is being assigned. Try again in a moment.");
      try {
        const db = ctx.db<typeof schema>();
        const sessions = await db.select().from(schema.sessions);
        const existing = sessions.find((item) => item.id === args.id);
        if (existing && existing.title !== agent.name) throw new Error("Use assignAgent to change the session's agent.");
        if (!existing?.archived && sessions.some((item) => item.id !== args.id && !item.archived && item.title.toLowerCase() === agent.name.toLowerCase())) {
          throw new Error("This agent is assigned to another session.");
        }
        const models = await db.select().from(schema.codingModels).orderBy(asc(schema.codingModels.sortOrder));
        const modelId = existing?.modelId ?? await resolveCompanionModel(ctx, agent, models);
        const now = new Date();
        await db.insert(schema.sessions).values({
          id: args.id, title: agent.name, prompt: args.prompt, status: args.status,
          modelId, requestedModelId: modelId, reasoningEffort: reasoningEffortSchema.parse(agent.effort),
          startedAt: now, updatedAt: now,
        }).onConflictDoUpdate({
          target: schema.sessions.id,
          set: { prompt: args.prompt, status: args.status },
        });
        ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.id]] });
        return { ok: true, id: args.id };
      } finally {
        release();
      }
    },
  }),

  appendOutput: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      kind: eventKindSchema.default("stdout"),
      content: z.string().min(1).max(200000),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.sessions.id, status: schema.sessions.status })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = existing[0];
      if (!session) {
        return { ok: false, id: null, error: "Session not found" };
      }
      const now = new Date();
      const inserted = await db
        .insert(schema.outputEvents)
        .values({
          sessionId: args.session_id,
          kind: args.kind,
          content: args.content,
          createdAt: now,
        })
        .returning({ id: schema.outputEvents.id });
      const event = inserted[0];
      if (!event) return { ok: false, id: null, error: "Output was not saved" };

      const nextStatus: SessionStatus =
        session.status === "queued" ? "running" : session.status;
      await db
        .update(schema.sessions)
        .set({ status: nextStatus,
          ...(args.kind === "user" || args.kind === "stdout" ? { updatedAt: now } : {}),
          ...(countsAsUnread(args) ? { outputRevision: sql`${schema.sessions.outputRevision} + 1` } : {}),
        })
        .where(eq(schema.sessions.id, args.session_id));
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.session_id]] });
      return { ok: true, id: event.id, error: null };
    },
  }),

  sendInput: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      content: z.string().trim().min(1).max(20000),
      attachments: z.array(attachmentInputSchema).max(8).optional(),
    }).strict(),
    response: z.object({
      ok: z.boolean(),
      retryable: z.boolean().optional(),
      id: z.number().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.sessions.id,
          title: schema.sessions.title,
          archived: schema.sessions.archived,
          status: schema.sessions.status,
          pilotSessionId: schema.sessions.pilotSessionId,
          modelId: schema.sessions.modelId,
          reasoningEffort: schema.sessions.reasoningEffort,
          workspaceRoot: schema.sessions.workspaceRoot,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, id: null, error: "Session not found" };
      if (session.archived) return { ok: false, id: null, error: "Resume this session with an available agent before sending a message." };
      if (!session.pilotSessionId && (session.status === "queued" || session.status === "failed")) {
        return { ok: false, id: null, error: "The first message has not reached the agent yet. Wait for the connection or retry the start." };
      }
      // Failed sessions can be retried: a new message restarts the turn.
      // Succeeded and stopped sessions are truly over.
      if (session.status !== "queued" && session.status !== "running" && session.status !== "failed") {
        return { ok: false, id: null, error: "This session has already ended" };
      }

      const effort = session.reasoningEffort;
      const modelId = session.modelId;
      let effectiveModelId = modelId;
      let storedContent = args.content;
      if (session.pilotSessionId) {
        try {
          const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
          const pilot = await postPilotTurnWithRecovery(baseUrl, session.pilotSessionId, {
            text: args.content,
            ifBusy: "queue",
            reasoningEffort: effort,
            modelId,
            ...(args.attachments && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
          });
          effectiveModelId = pilot.modelId;
        } catch (error) {
          return { ok: false, id: null, error: pilotRequestErrorText(error), retryable: isPilotUnavailable(error) };
        }
      } else {
        storedContent = legacyPrompt(args.content, modelId, effort);
      }

      const now = new Date();
      const inserted = await db
        .insert(schema.outputEvents)
        .values({
          sessionId: args.session_id,
          kind: "user",
          content: storedContent,
          toolDetails: serializeUserAttachments(args.attachments),
          createdAt: now,
        })
        .returning({ id: schema.outputEvents.id });
      const event = inserted[0];
      if (!event) return { ok: false, id: null, error: "Direction was not sent" };
      await recordCompanionUserTurn(db, session.title, now);

      await db
        .update(schema.sessions)
        .set({
          status: session.pilotSessionId ? "running" : session.status,
          summary: null,
          modelId: effectiveModelId,
          reasoningEffort: effort,
          updatedAt: now,
          needsUserInput: false,
          finishedAt: null,
        })
        .where(eq(schema.sessions.id, args.session_id));
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.session_id]] });
      return { ok: true, id: event.id, error: null };
    },
  }),

  continueSession: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
      content: z.string().trim().min(1).max(20000),
      // "Resume & send" from a past session: an archived session is restored
      // as part of the same request, only once the new turn is accepted.
      resume: z.boolean().optional(),
      attachments: z.array(attachmentInputSchema).max(8).optional(),
    }).strict(),
    response: createSessionResponseSchema,
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args): Promise<z.infer<typeof createSessionResponseSchema>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.sessions.id,
          title: schema.sessions.title,
          status: schema.sessions.status,
          archived: schema.sessions.archived,
          archivedAt: schema.sessions.archivedAt,
          needsUserInput: schema.sessions.needsUserInput,
          summary: schema.sessions.summary,
          finishedAt: schema.sessions.finishedAt,
          updatedAt: schema.sessions.updatedAt,
          pilotSessionId: schema.sessions.pilotSessionId,
          modelId: schema.sessions.modelId,
          reasoningEffort: schema.sessions.reasoningEffort,
          workspaceRoot: schema.sessions.workspaceRoot,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) {
        return { ok: false, id: null, start_status: null, error: "Session not found" };
      }
      if (session.archived && !args.resume) {
        return {
          ok: false,
          id: null,
          start_status: null,
          error: "Restore this session before continuing it",
        };
      }
      const unarchive = session.archived ? { archived: false, archivedAt: null } : {};
      if (session.status === "queued" || session.status === "running") {
        return {
          ok: false,
          id: null,
          start_status: null,
          error: "This session is already active",
        };
      }

      const release = lockCompanionAssignment(session.id, session.title);
      if (!release) return { ok: false, id: null, start_status: null, error: "This session or agent is being assigned. Try again in a moment." };
      let reserved = false;
      let admitted = false;
      try {
        const claimed = await db.update(schema.sessions).set({
          archived: false, archivedAt: null,
          // A live pilot turn must also block cross-worker handoffs while
          // admission is pending. Legacy starts queue after saving their event.
          status: session.pilotSessionId ? "queued" : session.status,
        }).where(and(eq(schema.sessions.id, session.id), eq(schema.sessions.title, session.title),
          eq(schema.sessions.archived, session.archived), eq(schema.sessions.status, session.status),
          companionIsFreeCondition(session.id, session.title))).returning({ id: schema.sessions.id });
        if (!claimed.length) return { ok: false, id: null, start_status: null, error: companionBusyMessage(session.title) };
        reserved = true;
        const effort = session.reasoningEffort;
        const modelId = session.modelId;

        if (session.pilotSessionId) {
          let effectiveModelId: string;
          try {
            const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
            const pilot = await postPilotTurnWithRecovery(baseUrl, session.pilotSessionId, {
              text: args.content,
              ifBusy: "queue",
              reasoningEffort: effort,
              modelId,
              ...(args.attachments && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
            });
            admitted = true;
            effectiveModelId = pilot.modelId;
          } catch (error) {
            return {
              ok: false,
              id: null,
              start_status: null,
              error: pilotRequestErrorText(error),
              retryable: isPilotUnavailable(error),
            };
          }

          const now = new Date();
          const inserted = await db
            .insert(schema.outputEvents)
            .values({
              sessionId: args.session_id,
              kind: "user",
              content: args.content,
              toolDetails: serializeUserAttachments(args.attachments),
              createdAt: now,
            })
            .returning({ id: schema.outputEvents.id });
          if (!inserted[0]) {
            return {
              ok: false,
              id: null,
              start_status: null,
              error: "Continuation was not saved",
            };
          }
          await recordCompanionUserTurn(db, session.title, now);
          await db
            .update(schema.sessions)
            .set({
              status: "running",
              summary: null,
              modelId: effectiveModelId,
              reasoningEffort: effort,
              updatedAt: now,
              needsUserInput: false,
              finishedAt: null,
              ...unarchive,
            })
            .where(eq(schema.sessions.id, args.session_id));
          ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.session_id]] });
          return {
            ok: true,
            id: args.session_id,
            start_status: "waking",
            error: null,
          };
        }

        const storedContent = legacyPrompt(args.content, modelId, effort);
        const now = new Date();
        const inserted = await db
          .insert(schema.outputEvents)
          .values({
            sessionId: args.session_id,
            kind: "user",
            content: storedContent,
            createdAt: now,
          })
          .returning({ id: schema.outputEvents.id });
        const event = inserted[0];
        if (!event) {
          return {
            ok: false,
            id: null,
            start_status: null,
            error: "Continuation was not saved",
          };
        }
        await recordCompanionUserTurn(db, session.title, now);

        await db
          .update(schema.sessions)
          .set({
            status: "queued",
            summary: null,
            modelId,
            reasoningEffort: effort,
            updatedAt: now,
            needsUserInput: false,
            finishedAt: null,
            ...unarchive,
          })
          .where(eq(schema.sessions.id, args.session_id));

        let taskAccepted = false;
        try {
          const task = await ctx.agent.spawnTask(
            continuationTaskMessage(
              args.session_id,
              storedContent,
              session.workspaceRoot ?? defaultWorkspaceRoot(session.id),
            ),
            { dedupeKey: `muse-code-continuation:${args.session_id}:${event.id}` },
          );
          taskAccepted = task.ok;
        } catch {
          taskAccepted = false;
        }

        admitted = taskAccepted;
        if (!taskAccepted) {
          await db.delete(schema.outputEvents).where(eq(schema.outputEvents.id, event.id));
          await db
            .update(schema.sessions)
            .set({
              status: session.status,
              summary: session.summary,
              updatedAt: session.updatedAt,
              finishedAt: session.finishedAt,
              archived: session.archived,
              archivedAt: session.archivedAt,
              needsUserInput: session.needsUserInput,
            })
            .where(eq(schema.sessions.id, args.session_id));
          ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.session_id]] });
          return {
            ok: false,
            id: null,
            start_status: null,
            error: "Muse Code could not be started. Your direction was not submitted.",
          };
        }

        ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.session_id]] });
        return {
          ok: true,
          id: args.session_id,
          start_status: "waking",
          error: null,
        };
      } finally {
        try {
          // A rejected/offline pilot must restore the task state and release
          // its temporary claim. An admitted turn keeps ownership even if a
          // later write fails, so the companion cannot run two tasks at once.
          if (reserved && !admitted) {
            await db.update(schema.sessions).set({ status: session.status, archived: session.archived, archivedAt: session.archivedAt })
              .where(eq(schema.sessions.id, session.id));
            ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", session.id]] });
          }
        } finally {
          release();
        }
      }
    },
  }),

  getPendingUserInputs: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
    }),
    response: z.object({
      ok: z.boolean(),
      inputs: z.array(z.object({
        userInputId: z.string(),
        turnId: z.string().nullable().optional(),
        autoResolutionMs: z.number().nullable().optional(),
        questions: z.array(pilotUserInputQuestionSchema),
      })),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.sessions.id, pilotSessionId: schema.sessions.pilotSessionId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, inputs: [], error: "Session not found" };
      if (!session.pilotSessionId) return { ok: true, inputs: [], error: null };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const poll = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/user-inputs`,
          { method: "GET" },
          pilotUserInputsResponseSchema,
        );
        return { ok: true, inputs: poll.inputs, error: null };
      } catch (error) {
        return { ok: false, inputs: [], error: pilotRequestErrorText(error) };
      }
    },
  }),

  answerUserInput: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      userInputId: z.string().min(1).max(200),
      answers: z.array(userInputAnswerSchema).min(1).max(10),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.sessions.id, pilotSessionId: schema.sessions.pilotSessionId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, error: "Session not found" };
      if (!session.pilotSessionId) return { ok: false, error: "Agent connection unavailable" };
      let live: z.infer<typeof pilotUserInputsResponseSchema>;
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        live = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/user-inputs`,
          { method: "GET" },
          pilotUserInputsResponseSchema,
        );
      } catch (error) {
        return { ok: false, error: pilotRequestErrorText(error) };
      }
      const pending = live.inputs.find((input) => input.userInputId === args.userInputId);
      if (!pending) {
        return { ok: false, error: "That question is no longer pending — it was answered, cancelled, or timed out" };
      }
      const questions: UserInputQuestionShape[] = pending.questions.map((q) => ({
        id: q.id,
        selection: {
          mode: q.selection.mode,
          minSelections: q.selection.minSelections,
          maxSelections: q.selection.maxSelections,
        },
        options: (q.options ?? []).map((o) => ({ label: o.label })),
      }));
      const shaped = buildUserInputAnswers(
        questions,
        args.answers.map((a) => ({
          questionId: a.questionId,
          selectedLabels: a.selectedLabels,
          freeText: a.freeText,
          note: a.note,
        })),
      );
      if (!shaped.ok) return { ok: false, error: shaped.error };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/user-inputs/answer`,
          { method: "POST", body: JSON.stringify({ userInputId: args.userInputId, answers: shaped.answers }) },
          z.object({ ok: z.boolean(), userInputId: z.string() }),
        );
      } catch (error) {
        return { ok: false, error: pilotRequestErrorText(error) };
      }
      const echo = shaped.answers
        .map((answer) => {
          const question = pending.questions.find((q) => q.id === answer.questionId);
          const title = question?.header?.trim() || question?.question?.trim() || answer.questionId;
          const choice = answer.selectedLabel ?? answer.selectedLabels?.join(", ") ?? answer.freeText ?? "";
          return `You answered "${title}": ${choice}`;
        })
        .join("\n")
        .slice(0, 2000);
      const answeredAt = new Date();
      await db.insert(schema.outputEvents).values({
        sessionId: session.id,
        kind: "system",
        content: echo,
        createdAt: answeredAt,
      });
      await db.update(schema.sessions)
        .set({ needsUserInput: false, updatedAt: answeredAt })
        .where(eq(schema.sessions.id, session.id));
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", session.id], ["pending-user-inputs", session.id]] });
      return { ok: true, error: null };
    },
  }),

  cancelUserInput: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      userInputId: z.string().min(1).max(200),
      reason: z.string().max(500).optional(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.sessions.id, pilotSessionId: schema.sessions.pilotSessionId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, error: "Session not found" };
      if (!session.pilotSessionId) return { ok: false, error: "Agent connection unavailable" };
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/user-inputs/cancel`,
          {
            method: "POST",
            body: JSON.stringify({
              userInputId: args.userInputId,
              ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
            }),
          },
          z.object({ ok: z.boolean(), userInputId: z.string() }),
        );
      } catch (error) {
        return { ok: false, error: pilotRequestErrorText(error) };
      }
      await db.insert(schema.outputEvents).values({
        sessionId: session.id,
        kind: "system",
        content: "You skipped answering the companion's question.",
        createdAt: new Date(),
      });
      await db.update(schema.sessions)
        .set({ needsUserInput: false })
        .where(eq(schema.sessions.id, session.id));
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", session.id], ["pending-user-inputs", session.id]] });
      return { ok: true, error: null };
    },
  }),

  interruptTurn: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.sessions.id,
          status: schema.sessions.status,
          pilotSessionId: schema.sessions.pilotSessionId,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, error: "Session not found" };
      if (!session.pilotSessionId) return { ok: false, error: "Agent connection unavailable" };
      if (session.status !== "queued" && session.status !== "running") {
        return { ok: false, error: "There is no running turn to stop" };
      }
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/turns/interrupt`,
          { method: "POST", body: JSON.stringify({}) },
          z.object({ ok: z.boolean() }),
        );
      } catch (error) {
        return { ok: false, error: pilotRequestErrorText(error) };
      }
      return { ok: true, error: null };
    },
  }),

  compactContext: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
    }),
    response: z.object({ ok: z.boolean(), noop: z.boolean().optional(), error: z.string().nullable() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.sessions.id,
          status: schema.sessions.status,
          pilotSessionId: schema.sessions.pilotSessionId,
          outputRevision: schema.sessions.outputRevision,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session) return { ok: false, error: "Session not found" };
      if (!session.pilotSessionId) return { ok: false, error: "Companion connection unavailable" };
      if (session.status === "queued" || session.status === "running") {
        return { ok: false, error: "Stop the current turn before compacting context." };
      }
      let status = "accepted";
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const res = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/compact`,
          { method: "POST", body: JSON.stringify({}) },
          z.object({ ok: z.boolean(), status: z.string().optional(), reason: z.string().optional() }),
        );
        if (res.status) status = res.status;
      } catch (error) {
        return { ok: false, error: pilotRequestErrorText(error) };
      }
      if (status !== "noop") {
        await db.insert(schema.outputEvents).values({
          sessionId: session.id,
          kind: "system",
          content: "Conversation context was compacted.",
          createdAt: new Date(),
        });
        await db.update(schema.sessions)
          .set({
            outputRevision: session.outputRevision + 1,
          })
          .where(eq(schema.sessions.id, session.id));
        ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", session.id]] });
      }
      return { ok: true, noop: status === "noop", error: null };
    },
  }),

  syncPilotEvents: defineAction({
    request: z.object({
      session_id: z.string().min(1).max(200),
    }),
    response: syncPilotEventsResponseSchema,
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx, args): Promise<z.infer<typeof syncPilotEventsResponseSchema>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.sessions.id,
          title: schema.sessions.title,
          status: schema.sessions.status,
          pilotSessionId: schema.sessions.pilotSessionId,
          pilotSeq: schema.sessions.pilotSeq,
          pilotBackendId: schema.sessions.pilotBackendId,
          updatedAt: schema.sessions.updatedAt,
          startedAt: schema.sessions.startedAt,
          needsUserInput: schema.sessions.needsUserInput,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, args.session_id))
        .limit(1);
      const session = rows[0];
      if (!session || !session.pilotSessionId) {
        return { added: 0, status: session?.status ?? "stopped", pilot_available: null };
      }

      let poll: PilotPoll;
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        poll = await pilotRequest(
          baseUrl,
          `/sessions/${encodeURIComponent(session.pilotSessionId)}/poll?since=${session.pilotSeq}`,
          { method: "GET" },
          pilotPollResponseSchema,
        );
      } catch {
        return { added: 0, status: session.status, pilot_available: false };
      }

      // Follow backend-id changes: after a recovery reseeds a replacement
      // backend session, the stored watermark belongs to a dead backend.
      // Filtering the fresh stream against it would hide every new event
      // behind a silent spinner, so reset the baseline instead.
      const backendChanged = pilotBackendChanged(
        session.pilotBackendId,
        poll.backendSessionId,
        session.pilotSeq,
        poll.latestSeq,
      );
      const baseline = backendChanged ? -1 : session.pilotSeq;
      const backendId = poll.backendSessionId ?? session.pilotBackendId;
      const newEvents = poll.events
        .filter((event) => event.seq > baseline)
        .sort((a, b) => a.seq - b.seq);
      let added = 0;
      let outputChanges = 0;
      let nextStatus: SessionStatus = session.status;
      let terminalSummary: string | null | undefined;
      let terminalAt: Date | null | undefined;
      let nameUpdate: string | null = null;
      let needsUserInput = session.needsUserInput;
      let activityAt: Date | null = null;
      const recordActivity = (at: Date) => {
        if (at > session.updatedAt && (!activityAt || at > activityAt)) activityAt = at;
      };
      // The companion this session is assigned to, resolved once per sync.
      // Every non-archived session has one; undefined means the title matches
      // no companion, in which case statistics simply record nothing.
      let statsCompanionId: string | null | undefined;
      const resolveStatsCompanionId = async (): Promise<string | null> => {
        if (statsCompanionId === undefined) {
          const companion = await assignableCompanionByName(db, session.title).catch(() => undefined);
          statsCompanionId = companion?.id ?? null;
        }
        return statsCompanionId;
      };

      for (const event of newEvents) {
        if (event.type === "item") {
          if (event.item?.kind === "reasoning") {
            // MSP sends the full accumulated summary on each revision.
            // Never persist reasoning.text (private provider content).
            const itemId = event.item.itemId;
            if (!itemId) continue;
            const content = pilotReasoningSummary(event.item) ?? "";
            const itemAt = pilotItemTime(event.item.recordedAt, event.at) ?? new Date();
            const running = event.item.status === "inProgress";
            const existing = (await db.select({ id: schema.outputEvents.id, content: schema.outputEvents.content, finishedAt: schema.outputEvents.finishedAt })
              .from(schema.outputEvents)
              .where(and(eq(schema.outputEvents.sessionId, session.id), eq(schema.outputEvents.kind, "thinking"), eq(schema.outputEvents.itemId, itemId)))
              .limit(1))[0];
            if (existing) {
              if (existing.content !== content || (!running && !existing.finishedAt)) {
                await db.update(schema.outputEvents)
                  .set({ content, ...(!running ? { finishedAt: existing.finishedAt ?? itemAt } : {}) })
                  .where(eq(schema.outputEvents.id, existing.id));
                added += 1;
              }
            } else {
              await db.insert(schema.outputEvents).values({
                sessionId: session.id, kind: "thinking", content, itemId,
                createdAt: itemAt, startedAt: itemAt, finishedAt: running ? null : itemAt,
              });
              added += 1;
            }
            if (nextStatus === "queued") nextStatus = "running";
            continue;
          }
          // Agent-to-agent work (a workflow and its child agents, a subagent):
          // one live row per item, updated in place — it keeps changing after
          // its turn has ended, until the children finish.
          if (event.item?.kind === "workflow" || event.item?.kind === "subagent") {
            const itemAt = pilotItemTime(event.item.recordedAt, event.at) ?? new Date();
            const itemId = event.item.itemId ?? null;
            const existing = itemId
              ? (await db
                  .select({ id: schema.outputEvents.id, finishedAt: schema.outputEvents.finishedAt, content: schema.outputEvents.content })
                  .from(schema.outputEvents)
                  .where(and(eq(schema.outputEvents.sessionId, session.id), eq(schema.outputEvents.itemId, itemId)))
                  .limit(1))[0]
              : undefined;
            let previous: AgentsRow | null = null;
            try {
              previous = existing ? (JSON.parse(existing.content) as AgentsRow) : null;
            } catch {
              previous = null;
            }
            const agents = pilotAgentsRow(event.item, previous)!;
            const running = agents.status === "inProgress";
            const content = JSON.stringify(agents);
            if (existing) {
              await db
                .update(schema.outputEvents)
                .set({ content, ...(running ? {} : { finishedAt: existing.finishedAt ?? itemAt }) })
                .where(eq(schema.outputEvents.id, existing.id));
            } else {
              await db.insert(schema.outputEvents).values({
                sessionId: session.id,
                kind: "agents",
                content,
                createdAt: itemAt,
                itemId,
                startedAt: itemAt,
                finishedAt: running ? null : itemAt,
              });
            }
            if (!existing || existing.content !== content || (!running && !existing.finishedAt)) outputChanges += 1;
            added += 1;
            if (nextStatus === "queued") nextStatus = "running";
            continue;
          }
          const toolContent = pilotToolLabel(event.item);
          if (toolContent && event.item) {
            const toolDetails = JSON.stringify(toolDetailsFromItem(event.item));
            // One row per tool call: inserted when it starts (so the UI can
            // show it running with a live timer), updated when it finishes.
            const itemAt = pilotItemTime(event.item.recordedAt, event.at) ?? new Date();
            const running = event.item.status === "inProgress";
            const itemId = event.item.itemId ?? null;
            const existing = itemId
              ? (await db
                  .select({ id: schema.outputEvents.id, content: schema.outputEvents.content, toolDetails: schema.outputEvents.toolDetails, startedAt: schema.outputEvents.startedAt, finishedAt: schema.outputEvents.finishedAt })
                  .from(schema.outputEvents)
                  .where(and(eq(schema.outputEvents.sessionId, session.id), eq(schema.outputEvents.itemId, itemId)))
                  .limit(1))[0]
              : undefined;
            if (existing) {
              await db
                .update(schema.outputEvents)
                .set({
                  content: toolContent,
                  toolDetails,
                  ...(running || existing.finishedAt ? {} : { finishedAt: itemAt }),
                })
                .where(eq(schema.outputEvents.id, existing.id));
            } else {
              await db.insert(schema.outputEvents).values({
                sessionId: session.id,
                kind: "tool",
                content: toolContent,
                toolDetails,
                createdAt: itemAt,
                itemId,
                // First seen already finished: the start is unknown, so no duration.
                startedAt: running ? itemAt : null,
                finishedAt: running ? null : itemAt,
              });
            }
            if (!existing || existing.content !== toolContent || existing.toolDetails !== toolDetails || (!running && !existing.finishedAt)) outputChanges += 1;
            // Statistics: count each tool call once, when it first reaches
            // a terminal revision, and register any PR it created.
            if (!running && (!existing || !existing.finishedAt)) {
              await guardCompanionStatistics(async () => {
                const companionId = await resolveStatsCompanionId();
                if (!companionId) return;
                await bumpCompanionStatistics(db, companionId, { toolCalls: 1 }, itemAt);
                const created = createdPullRequestFromToolEvent({ kind: "tool", tool_details: parseToolDetails(toolDetails) });
                if (created) await recordTrackedPrCreation(db, companionId, created, itemAt);
              });
            }
            added += 1;
            if (nextStatus === "queued") nextStatus = "running";
            continue;
          }
          const content = pilotItemText(event.item);
          if (!content) continue;
          const itemAt = pilotItemTime(event.item?.recordedAt, event.at) ?? new Date();
          await db.insert(schema.outputEvents).values({
            sessionId: session.id,
            kind: "stdout",
            content,
            createdAt: itemAt,
          });
          if (event.item?.kind === "agentMessage") recordActivity(itemAt);
          outputChanges += 1;
          added += 1;
          if (nextStatus === "queued") nextStatus = "running";
          continue;
        }

        if (event.type === "turn_completed") {
          needsUserInput = false;
          // A user-pressed stop lands here as terminal "cancelled": file it
          // as stopped with a neutral note, never as failed or succeeded.
          if (event.cancelled === true || pilotTurnCancelled(event.outcome)) {
            const stoppedAt = event.at ? new Date(event.at) : new Date();
            await db.insert(schema.outputEvents).values({
              sessionId: session.id,
              kind: "system",
              content: "Turn stopped.",
              createdAt: stoppedAt,
            });
            nextStatus = "stopped";
            terminalSummary = null;
            terminalAt = stoppedAt;
            outputChanges += 1;
            added += 1;
            continue;
          }
          // The outcome can carry an async transport/model failure; render
          // it instead of celebrating a turn that never produced an answer.
          const outcomeError = pilotTurnOutcomeError(event.outcome);
          if (outcomeError) {
            const failedAt = event.at ? new Date(event.at) : new Date();
            await db.insert(schema.outputEvents).values({
              sessionId: session.id,
              kind: "system",
              content: outcomeError,
              systemIsError: true,
              createdAt: failedAt,
            });
            nextStatus = "failed";
            terminalSummary = outcomeError;
            terminalAt = failedAt;
            outputChanges += 1;
            added += 1;
            continue;
          }
          nextStatus = "succeeded";
          terminalSummary = null;
          terminalAt = event.at ? new Date(event.at) : new Date();
          added += 1;
          continue;
        }

        if (event.type === "turn_error") {
          needsUserInput = false;
          const errorText = pilotErrorText(event.error);
          const failedAt = event.at ? new Date(event.at) : new Date();
          await db.insert(schema.outputEvents).values({
            sessionId: session.id,
            kind: "system",
            content: errorText,
            systemIsError: true,
            createdAt: failedAt,
          });
          nextStatus = "failed";
          terminalSummary = errorText;
          terminalAt = failedAt;
          outputChanges += 1;
          added += 1;
          continue;
        }

        if (event.type === "recovery_failed") {
          needsUserInput = false;
          const content = pilotSystemText(event) ?? "Automatic recovery failed after the backend restarted.";
          const failedAt = event.at ? new Date(event.at) : new Date();
          await db.insert(schema.outputEvents).values({
            sessionId: session.id,
            kind: "system",
            content,
            systemIsError: true,
            createdAt: failedAt,
          });
          nextStatus = "failed";
          terminalSummary = content;
          terminalAt = failedAt;
          outputChanges += 1;
          added += 1;
          continue;
        }

        // A message between agents (or from/to the user's Muse assistant):
        // one transcript row on each side. An incoming one starts a turn.
        if (event.type === "agent_message" && event.direction && event.from && event.to && typeof event.text === "string") {
          const messageAt = event.at ? new Date(event.at) : new Date();
          await db.insert(schema.outputEvents).values({
            sessionId: session.id,
            kind: "message",
            content: JSON.stringify({
              direction: event.direction,
              from: { kind: event.from.kind, name: event.from.name, ...(event.from.sessionId ? { sessionId: event.from.sessionId } : {}), ...(event.from.color ? { color: event.from.color } : {}) },
              to: { kind: event.to.kind, name: event.to.name, ...(event.to.sessionId ? { sessionId: event.to.sessionId } : {}), ...(event.to.color ? { color: event.to.color } : {}) },
              text: event.text,
              queued: event.queued === true,
            }),
            createdAt: messageAt,
            itemId: event.messageId ?? null,
          });
          recordActivity(messageAt); // incoming prompt or outgoing agent reply
          outputChanges += 1;
          added += 1;
          if (event.direction === "in") {
            nextStatus = "running";
            terminalSummary = null;
            terminalAt = null;
          }
          continue;
        }

        // An agent asking the user a question is a reply needing attention;
        // clearing it is not a new prompt or reply.
        if (event.type === "user_input_requested") {
          needsUserInput = true;
          recordActivity(event.at ? new Date(event.at) : new Date());
        } else if (event.type === "user_input_settled" || event.type === "user_input_answered" || event.type === "user_input_cancelled") {
          needsUserInput = false;
        }

        // Muse's name for the agent changed (its own automatic name, /name, a
        // rename): the app shows the same name.
        if (event.type === "name_changed" && event.name) {
          nameUpdate = event.name;
          continue;
        }

        // PR monitor row: one upserted row per monitor. The pilot emits
        // only on start and material changes, so each event is meaningful.
        if (event.type === "pr_monitor" && event.monitor?.id) {
          const content = JSON.stringify(event.monitor);
          const itemAt = event.at ? new Date(event.at) : new Date();
          const running = event.monitor.status === "monitoring";
          const existing = (await db
            .select({ id: schema.outputEvents.id, content: schema.outputEvents.content, finishedAt: schema.outputEvents.finishedAt })
            .from(schema.outputEvents)
            .where(and(eq(schema.outputEvents.sessionId, session.id), eq(schema.outputEvents.itemId, event.monitor.id)))
            .limit(1))[0];
          if (existing) {
            if (existing.content !== content || (!running && !existing.finishedAt)) {
              await db
                .update(schema.outputEvents)
                .set({ content, ...(!running ? { finishedAt: existing.finishedAt ?? itemAt } : {}) })
                .where(eq(schema.outputEvents.id, existing.id));
              outputChanges += 1;
            }
          } else {
            await db.insert(schema.outputEvents).values({
              sessionId: session.id,
              kind: "pr_monitor",
              content,
              createdAt: itemAt,
              startedAt: itemAt,
              finishedAt: running ? null : itemAt,
              itemId: event.monitor.id,
            });
            outputChanges += 1;
          }
          // Statistics: fold the snapshot into the tracked PR (a no-op for
          // PRs created before tracking landed).
          await guardCompanionStatistics(async () => {
            await recordTrackedPrSnapshot(db, event.monitor!, itemAt);
          });
          added += 1;
          continue;
        }

        // Muse started a turn itself (workflow results, a finished background
        // task, cron): the session is running again until that turn ends.
        if (event.type === "host_turn_started") {
          needsUserInput = false;
          nextStatus = "running";
          terminalSummary = null;
          terminalAt = null;
        }

        // Recovery/host notices render as small transcript lines; the
        // session continues under the same visible id.
        const notice = pilotSystemText(event);
        if (notice) {
          await db.insert(schema.outputEvents).values({
            sessionId: session.id,
            kind: "system",
            content: notice,
            systemIsError: event.type === "user_input_error",
            createdAt: event.at ? new Date(event.at) : new Date(),
          });
          if (countsAsUnread({ kind: "system", content: notice })) outputChanges += 1;
          added += 1;
          if (nextStatus === "queued") nextStatus = "running";
        }
      }

      // Reconcile phantom "running": if the app thinks a turn is active but
      // the pilot reports no open turn for this session, the backend died
      // (or the turn_error broadcast was missed). Never leave the UI stuck
      // on "thinking" — fail visibly so the user can retry.
      if (nextStatus === "running" && poll.hasOpenTurn === false) {
        const msg = "The backend restarted and the turn did not resume. Send a new message to retry.";
        await db.insert(schema.outputEvents).values({
          sessionId: session.id,
          kind: "system",
          content: msg,
          systemIsError: true,
          createdAt: new Date(),
        });
        nextStatus = "failed";
        terminalSummary = msg;
        terminalAt = new Date();
        outputChanges += 1;
        added += 1;
      }

      // A turn that ended (completed, failed, stopped, lost to a restart)
      // can leave tool rows that never got a terminal revision: stop their
      // timers at the turn's end so they don't count up forever.
      if (terminalAt) {
        const finishedTools = await db
          .update(schema.outputEvents)
          .set({ finishedAt: terminalAt })
          .where(and(
            eq(schema.outputEvents.sessionId, session.id),
            eq(schema.outputEvents.kind, "tool"),
            isNotNull(schema.outputEvents.startedAt),
            isNull(schema.outputEvents.finishedAt),
          ))
          .returning({ id: schema.outputEvents.id });
        if (finishedTools.length > 0) outputChanges += 1;
      }

      // Statistics: add this session's runtime the first time it reaches a
      // terminal state. The marker row keeps a resumed session that ends
      // again from being counted twice.
      if (terminalAt) {
        await guardCompanionStatistics(async () => {
          const companionId = await resolveStatsCompanionId();
          if (!companionId) return;
          const inserted = await db.insert(schema.companionCountedSessions)
            .values({ sessionId: session.id, companionId, countedAt: new Date() })
            .onConflictDoNothing()
            .returning({ sessionId: schema.companionCountedSessions.sessionId });
          if (inserted.length > 0) {
            const runtimeMs = Math.max(0, terminalAt.getTime() - session.startedAt.getTime());
            await bumpCompanionStatistics(db, companionId, { runtimeMs }, terminalAt);
          }
        });
      }

      await db
        .update(schema.sessions)
        .set({
          pilotSeq: Math.max(baseline, poll.latestSeq),
          pilotBackendId: backendId,
          ...(nameUpdate ? { title: nameUpdate } : {}),
          ...(activityAt ? { updatedAt: activityAt } : {}),
          ...(outputChanges > 0 ? { outputRevision: sql`${schema.sessions.outputRevision} + ${outputChanges}` } : {}),
          needsUserInput,
          status: nextStatus,
          summary: terminalSummary,
          finishedAt: terminalAt,
        })
        .where(eq(schema.sessions.id, session.id));
      if (added > 0 || backendChanged) {
        const sessionMetaChanged = nextStatus !== session.status || nameUpdate !== null || needsUserInput !== session.needsUserInput;
        ctx.invalidateQueries(
          sessionMetaChanged
            ? { queryKeys: [["code-sessions"], ["code-session", session.id]] }
            : { queryKey: ["code-session", session.id] },
        );
      }
      return { added, status: nextStatus, pilot_available: true };
    },
  }),

  finishSession: defineAction({
    request: z.object({
      id: z.string().min(1).max(200),
      status: z.enum(["succeeded", "failed", "stopped"]),
      summary: z.string().max(20000).nullable().default(null),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const updated = await db
        .update(schema.sessions)
        .set({
          status: args.status,
          summary: args.summary,
          needsUserInput: false,
          finishedAt: now,
        })
        .where(eq(schema.sessions.id, args.id))
        .returning({ id: schema.sessions.id });
      if (updated.length === 0) return { ok: false, error: "Session not found" };
      ctx.invalidateQueries({ queryKeys: [["code-sessions"], ["code-session", args.id]] });
      return { ok: true, error: null };
    },
  }),

  getWireDebug: defineAction({
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      enabled: z.boolean(),
      entries: z.array(wireDebugEntrySchema),
      error: z.string().nullable(),
    }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const data = await pilotRequest(
          baseUrl,
          "/debug/wire",
          { method: "GET" },
          wireDebugGetResponseSchema,
        );
        return { ok: true, enabled: data.enabled, entries: data.entries, error: null };
      } catch (error) {
        return { ok: false, enabled: false, entries: [], error: pilotRequestErrorText(error) };
      }
    },
  }),

  getRelayDebug: defineAction({
    request: z.object({}),
    response: relayDebugResponseSchema.extend({ ok: z.boolean() }),
    privileged: [privileged.resolvePilotUrl],
    async handler(ctx) {
      const empty = (error: string) => ({ ok: false, enabled: true, status: "down" as const,
        entries: [], startedAt: null, lastSuccessAt: null, lastFailureAt: null, error });
      if (ctx.viewer && !ctx.viewer.isOwner) return empty("Only the space owner can view diagnostics.");
      try {
        const { baseUrl } = await ctx.executePrivileged(privileged.resolvePilotUrl, {});
        const data = await pilotRequest(baseUrl, "/debug/relay", { method: "GET" }, relayDebugResponseSchema);
        return { ok: true, ...data };
      } catch {
        return empty("Muse Code service unavailable. Try again when connected.");
      }
    },
  }),

  setWireDebug: defineAction({
    request: z.object({ enabled: z.boolean() }),
    response: z.object({ ok: z.boolean(), enabled: z.boolean(), error: z.string().nullable() }),
    async handler() {
      // Capture is always on (pilot records unconditionally); the UI toggle
      // only shows/hides the panel. Kept for backwards compat.
      return { ok: true, enabled: true, error: null };
    },
  }),
} satisfies ActionsModule;

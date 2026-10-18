import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { api, type ApiResponse } from "./api";
import { getWorkingLabel } from "./workingLabel";
import { shouldSnapToBottom, shouldFollowTranscript } from "./scrollSnap";
import { agentVisualStatus, transcriptAtBottom, type AgentVisualStatus } from "./agentStatus";
import { CompanionContact, CompanionWelcome, companions } from "./Companions";
import { CompanionMenu } from "./CompanionMenu";
import { CompanionAccessNotice } from "./CompanionAccess";
import { companionModelAccess, orderCompanionsByAccess, PAID_COMPANION_MODELS } from "../../server/src/companionModels";
import { displayModelLabel } from "./modelLabel";
import { MoreCompanionsButton } from "./MoreCompanionsButton";
import { TranscriptCompanion } from "./TranscriptCompanion";
import { availableCompanionDefinitions, companionAssignedElsewhere, companionForName, isDefaultCompanion, matchesCompanionQuery } from "./companionRoster";
import { companionArtwork } from "./companionArtwork";
import { CompanionAvatar, preloadCompanionStill } from "./CompanionAvatar";
import { isLifecycleMessage } from "../../server/src/transcriptVisibility";
import { pendingHasArrived } from "./pendingEcho";
import { matchesSessionQuery, sessionTaskTitle, formatRelativeTime, groupSessionsByAge, groupSessionsByProject, resolveSelectedId, isSessionActive, sortSessions, type SortMode } from "./sessionList";
import { newSessionIdentity } from "./sessionWorkspace";
import { SortMenu } from "./SortMenu";
import { AgentMentionMenu } from "./AgentMentionMenu";
import { RepoPicker } from "./RepoPicker";
import { completeMention, matchingAgents, mentionAtCursor, type MentionAgent } from "./agentMentions";
import { PaneDivider } from "./PaneDivider";
import { chatWidthBounds, clampChatShare, clampSidebarWidth, DEFAULT_CHAT_SHARE, DEFAULT_SIDEBAR_WIDTH, DIVIDER_WIDTH, loadPaneSizes, savePaneSizes, sidebarWidthBounds } from "./layoutSizing";
import { isHardwareKeyEvent, isVirtualKeyboardEnvironment, shouldSubmitOnEnter } from "./keyboardSubmit";
import { buildPromptHistory, INITIAL_PROMPT_HISTORY_STATE, navigatePromptHistory, type PromptHistoryState } from "./promptHistory";
import { COMPOSER_MIN_HEIGHT, resizeComposerTextarea } from "./composerSizing";
import { formatMessageTime } from "./messageTime";
import { reasoningDisplay } from "./reasoningDisplay";
import { redundantSendToolIds } from "./messageToolVisibility";
import { SessionMenu, type SessionMenuAction } from "./WireDebug";
import { ConfirmDeleteDialog, TextPromptDialog, type TextPromptSpec } from "./Dialogs";
import { AgentsEvent, agentStatusRunning, parseAgentsRow } from "./AgentsEvent";
import { PrMonitorEvent } from "./PrMonitorEvent";
import { parsePrMonitor } from "./prMonitor";
import { NewTerminalButton, OwnedArtifactMenu, SidePanel, type SidePanelState, type SideTab } from "./SidePanel";
import { agentNameHue, displayAgentName, messagePeerHue } from "./agentColor";
import { formatToolDuration, toolElapsedMs } from "./toolDuration";
import { contextUsageLabel } from "./contextUsage";
import { hasStoredOutputBeyondView, toolTranscriptLines, TOOL_PREVIEW_LINES } from "./toolTranscript";
import { filePreviewForTool, toolPresentation } from "./toolPresentation";
import { parseStructuredPatch, parseUnifiedDiff, PATCH_LIMIT_BYTES, type DiffDocument } from "./toolDiff";
import { formatJsonTranscript, tokenizeJson } from "./jsonHighlight";
import { ToolDiff } from "./RenderedToolDiff";
import { observeElementIntersection } from "./CodeFileLines";
import { ToolFileView } from "./RenderedToolFile";
import { ToolSearchView } from "./ToolSearchView";
import { searchPreviewForTool } from "./searchOutput";
import { parseAgentListOutput, type AgentListOutput } from "./agentListOutput";
import { decideSubmit, isConnectionLost, isNetworkFailure } from "./connectionState";
import { applyColorMode, COLOR_MODE_KEY, loadColorMode, type ColorMode } from "./colorMode";

type Session = ApiResponse<typeof api, "listSessions">["sessions"][number];
type Filter = "active" | "inactive";
type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

type SpeechRecognitionResultLike = {
  results: ArrayLike<{ 0: { transcript: string } }>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Past" },
];

const EFFORT_OPTIONS: Array<{ value: Effort; label: string }> = [
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

const CONTEXT_WINDOW_TOKENS = 128_000;
const NO_OWNED_FILES: readonly string[] = [];
const SHOW_REASONING_KEY = "muse-code-space:show-reasoning";
const EXPAND_TOOLS_KEY = "muse-code-space:expand-tools";
const RAW_TOOL_OUTPUT_KEY = "muse-code-space:raw-tool-output";
const WORKING_DETAILS_KEY = "muse-code-space:working-details";
const SORT_MODE_KEY = "muse-code-space:sort-mode";
// Home folder on the pilot's machine, from the server's getHostConfig
// (the VM is /home/hatch; a pilot on a Mac is /Users/<you>). Module-level so
// the path helpers below stay plain functions; App sets it once loaded.
let HOME_ROOT = "/home/hatch";
let WORKSPACE_ROOT = `${HOME_ROOT}/workspace`;
let HOME_PATH_PATTERN = homePathPattern(HOME_ROOT);

function homePathPattern(home: string): RegExp {
  return new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|\\s|$)`, "g");
}

function setHostHomeRoot(home: string) {
  if (!home.startsWith("/") || home === HOME_ROOT) return;
  HOME_ROOT = home;
  WORKSPACE_ROOT = `${home}/workspace`;
  HOME_PATH_PATTERN = homePathPattern(home);
}

type NewSessionDraft = {
  id: string;
  projectKey: string;
  workspaceRoot: string;
  // Repo picked above the first-message prompt (`owner/repo`); cloned into
  // workspaceRoot by the pilot on start. Null: blank generated workspace.
  repoSlug: string | null;
  companionId: string;
  companionName: string;
};

// The one prompt held while the connection is down; sent on reconnect.
type QueuedMessage = { kind: "message"; sessionId: string; content: string };
type QueuedDraft = { kind: "draft"; draft: NewSessionDraft; workspacePath: string; prompt: string };
type QueuedPrompt = QueuedMessage | QueuedDraft;
type SendResult = { ok: true } | { ok: false; error: string; network: boolean; pilotUnavailable?: boolean };

const QUEUE_FULL_MESSAGE = "One message is already queued. It sends when the connection is back.";

function QueuedEcho({ text, onCancel, sending = false }: { text: string; onCancel: () => void; sending?: boolean }) {
  return (
    <>
      <article className="output-event user pending-echo queued-echo" aria-label="Queued message">
        <div className="message-text">{displayOutput(text)}</div>
      </article>
      <div className="queued-note" role="status">
        <span>{sending ? "Sending…" : "Queued — sends when the connection is back."}</span>
        <button type="button" onClick={onCancel} disabled={sending}>Cancel</button>
      </div>
    </>
  );
}

function makeNewSessionDraft(companion: (typeof companions)[number], projectKey = ""): NewSessionDraft {
  return { ...newSessionIdentity(crypto.randomUUID(), Date.now()), projectKey, repoSlug: null, companionId: companion.id, companionName: companion.name };
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

function statusLabel(status: Session["status"], pilotSessionId?: string | null): string {
  if (status === "succeeded") return "Complete";
  if (status === "failed") return "Failed";
  if (status === "stopped") return "Stopped";
  if (status === "running") return "Running";
  return pilotSessionId === null ? "Connecting" : "Starting";
}

function isTurnLive(status: Session["status"]): boolean {
  return status === "queued" || status === "running";
}

function StatusMark({ visual, label }: { visual: AgentVisualStatus; label?: string }) {
  return (
    <span className={`status-dot ${visual}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {visual === "complete" && <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 7.5 4 3.7L13 4.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </span>
  );
}

function shortenHomePaths(content: string): string {
  return content.replace(HOME_PATH_PATTERN, "~");
}

function displayOutput(content: string): string {
  return shortenHomePaths(content.replace(/^Continuation completed\b/i, "Companion completed"));
}

function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}

function renderInlineText(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const codeParts = text.split(/(`[^`\n]+`)/g);
  let key = 0;
  for (const part of codeParts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      nodes.push(<code key={`${keyPrefix}-c${key++}`}>{part.slice(1, -1)}</code>);
      continue;
    }
    const pattern = /(\[.+?\]\(.+?\)|https?:\/\/[^\s)]+|\*\*.+?\*\*|~~.+?~~|\*[^*\n]+?\*|_[^_\n]+?_)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(part)) !== null) {
      if (match.index > last) nodes.push(part.slice(last, match.index));
      const token = match[0];
      const elementKey = `${keyPrefix}-i${key++}`;
      if (token.startsWith("[")) {
        const linkMatch = /^\[(.+?)\]\((.+?)\)$/.exec(token);
        if (linkMatch) {
          const label = linkMatch[1] ?? "";
          const url = (linkMatch[2] ?? "").trim();
          if (isSafeUrl(url)) {
            nodes.push(<a key={elementKey} href={url} target="_blank" rel="noreferrer">{label}</a>);
          } else {
            nodes.push(<span key={elementKey}>{label}</span>);
          }
        } else {
          nodes.push(token);
        }
      } else if (token.startsWith("http")) {
        nodes.push(<a key={elementKey} href={token} target="_blank" rel="noreferrer">{token}</a>);
      } else if (token.startsWith("**")) {
        nodes.push(<strong key={elementKey}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("~~")) {
        nodes.push(<s key={elementKey}>{token.slice(2, -2)}</s>);
      } else {
        nodes.push(<em key={elementKey}>{token.slice(1, -1)}</em>);
      }
      last = match.index + token.length;
    }
    if (last < part.length) nodes.push(part.slice(last));
  }
  return nodes;
}

function renderParagraphLines(lines: string[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(<br key={`${keyPrefix}-br${index}`} />);
    nodes.push(...renderInlineText(line, `${keyPrefix}-l${index}`));
  });
  return nodes;
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let key = 0;
  let paragraph: string[] = [];
  let listItems: Array<{ ordered: boolean; text: string }> = [];
  let quoteLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join("\n").trim();
    paragraph = [];
    if (!joined) return;
    const current = key++;
    nodes.push(<p key={current}>{renderParagraphLines(joined.split("\n"), `p${current}`)}</p>);
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const current = key++;
    const ordered = listItems[0]?.ordered ?? false;
    const items = listItems.map((item, index) => (
      <li key={`l${current}-${index}`}>{renderInlineText(item.text, `l${current}-${index}`)}</li>
    ));
    listItems = [];
    nodes.push(ordered ? <ol key={current}>{items}</ol> : <ul key={current}>{items}</ul>);
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    const current = key++;
    const joined = quoteLines.join("\n").trim();
    quoteLines = [];
    if (!joined) return;
    nodes.push(<blockquote key={current}>{renderParagraphLines(joined.split("\n"), `q${current}`)}</blockquote>);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    const fenceMatch = /^```(\w*)\s*$/.exec(trimmed);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i] ?? "").trim() !== "```") {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      const current = key++;
      nodes.push(
        <pre key={current}><code>{codeLines.join("\n").replace(/\n$/, "")}</code></pre>,
      );
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      nodes.push(<hr key={key++} />);
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = headingMatch[1]?.length ?? 0;
      const headingText = headingMatch[2] ?? "";
      const current = key++;
      const inline = renderInlineText(headingText, `h${current}`);
      if (level === 1) nodes.push(<h1 key={current}>{inline}</h1>);
      else if (level === 2) nodes.push(<h2 key={current}>{inline}</h2>);
      else if (level === 3) nodes.push(<h3 key={current}>{inline}</h3>);
      else nodes.push(<h4 key={current}>{inline}</h4>);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      quoteLines.push(trimmed.replace(/^>\s?/, ""));
      i += 1;
      continue;
    }

    const unorderedMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
    const orderedMatch = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(orderedMatch);
      if (listItems.length > 0 && (listItems[0]?.ordered ?? false) !== ordered) flushList();
      listItems.push({ ordered, text: (unorderedMatch?.[1] ?? orderedMatch?.[1] ?? "").trim() });
      i += 1;
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      flushList();
      flushQuote();
      i += 1;
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  flushList();
  flushQuote();

  if (nodes.length === 0) return <div className="message-text">{text}</div>;
  return <div className="markdown-body">{nodes}</div>;
});

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function WorkingIndicator({ label, elapsedSeconds, detailed }: { label: string; elapsedSeconds: number; detailed: boolean }) {
  const elapsed = formatElapsed(elapsedSeconds);
  return (
    <div className="working-indicator" role="status" aria-label={detailed ? `${label}, ${elapsed} elapsed` : label}>
      {detailed ? <>
        <span className="working-spinner" aria-hidden="true" />
        <span>{label} ({elapsed})</span>
      </> : <span className="working-dots" aria-hidden="true"><span /><span /><span /></span>}
    </div>
  );
}

// Keep the compact existing tool row; its inner button exposes a transcript.
// The first expansion is bounded, and fetching stored full output only occurs
// behind the second, explicit "Show all" action.
// Memoized: a finished tool row's inputs are stable across the transcript's
// 1s clock ticks and 1.5s refetches (react-query structural sharing keeps
// unchanged event objects referentially equal), so finished rows must not
// recompute presentations/previews on every App render. Only a running row
// ticks, and it does so with its own local clock.
const ToolEvent = memo(function ToolEvent({ sessionId, workspaceRoot, eventId, text, details, startedAt, finishedAt, expandedByDefault, showRawToolOutput, onOpenFile }: {
  sessionId: string;
  workspaceRoot: string;
  eventId: number;
  text: string;
  details: ApiResponse<typeof api, "getSession">["events"][number]["tool_details"];
  startedAt: string | null;
  finishedAt: string | null;
  expandedByDefault: boolean;
  showRawToolOutput: boolean;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const [showAll, setShowAll] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);
  const [patchDoc, setPatchDoc] = useState<DiffDocument | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [patchInView, setPatchInView] = useState(false);
  const patchPanelRef = useRef<HTMLDivElement>(null);
  const manuallyOpenedRef = useRef(false);
  const patchRequest = useRef(0);
  const outputRequest = useRef(0);
  const running = finishedAt === null && (details?.status === "inProgress" || startedAt !== null);
  // Only running rows need a clock; finished rows render a fixed duration.
  const [tickMs, setTickMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setTickMs(Date.now());
    const interval = window.setInterval(() => setTickMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [running]);
  const elapsed = toolElapsedMs(startedAt, finishedAt, tickMs);
  const displayDetails = fullOutput !== null && details ? { ...details, output: fullOutput } : details;
  const presentation = toolPresentation({ label: text, details: displayDetails, running, workspaceRoot });
  const filePreview = presentation.view === "file" && !showRawToolOutput ? filePreviewForTool(displayDetails) : null;
  const searchPreview = presentation.view === "search" && !showRawToolOutput ? searchPreviewForTool(displayDetails) : null;
  const agentList = presentation.view === "agent-list" && !showRawToolOutput ? parseAgentListOutput(fullOutput ?? details?.output ?? null) : null;
  const lines = toolTranscriptLines(details, running, fullOutput, showRawToolOutput);
  const jsonText = presentation.view === "json" ? formatJsonTranscript(details, fullOutput ?? details?.output ?? null) : null;
  const previewLines = jsonText?.split("\n") ?? lines;
  const needsStoredOutput = hasStoredOutputBeyondView(details, fullOutput);
  const hasMore = previewLines.length > TOOL_PREVIEW_LINES;
  const patchAvailable = details?.patchRef?.availability === "available" && details.patchRef.kind === "tool_patch" && details.patchRef.mediaType === "application/json";
  const textDiff = presentation.adapterId === "edit" && (!patchAvailable || patchError !== null) ? parseUnifiedDiff(fullOutput ?? details?.output ?? "") : null;
  const diffDoc = patchDoc ?? textDiff;
  const panelId = `tool-transcript-${eventId}`;

  // A preference change resets visible rows to the new default; individual
  // rows can still be opened or closed afterward. It never fetches full output.
  useEffect(() => {
    manuallyOpenedRef.current = false;
    setExpanded(expandedByDefault);
    setShowAll(false);
  }, [expandedByDefault]);

  useEffect(() => {
    outputRequest.current += 1;
    setFullOutput(null);
    setShowAll(false);
    setFullError(null);
    setLoadingFull(false);
  }, [details?.outputRef?.id]);
  useEffect(() => {
    patchRequest.current += 1;
    setPatchDoc(null);
    setPatchError(null);
    setLoadingPatch(false);
    setPatchInView(false);
  }, [details?.patchRef?.id]);

  const loadPatch = async () => {
    const request = ++patchRequest.current;
    setLoadingPatch(true);
    setPatchError(null);
    try {
      let offset = 0;
      const pages: string[] = [];
      for (;;) {
        const page = await api.readToolOutputPage({ session_id: sessionId, event_id: eventId, offset_bytes: offset, source: "patch" });
        if (request !== patchRequest.current) return;
        if (!page.ok) throw new Error(page.error ?? "Applied patch is unavailable.");
        if (page.encoding !== "utf8" || page.media_type !== "application/json") throw new Error("Patch is not UTF-8 JSON.");
        if (page.offset_bytes !== offset || (page.byte_len === 0 && !page.eof)) throw new Error("Patch paging stopped unexpectedly.");
        pages.push(page.content);
        offset += page.byte_len;
        if (offset > PATCH_LIMIT_BYTES) throw new Error("Patch exceeds the 4 MiB preview limit.");
        if (page.eof) break;
      }
      const doc = parseStructuredPatch(pages.join(""));
      if (!doc) throw new Error("Patch format could not be validated; use the raw output instead.");
      if (request === patchRequest.current) setPatchDoc(doc);
    } catch (error) {
      if (request === patchRequest.current) setPatchError(error instanceof Error ? error.message : "Patch could not be loaded.");
    } finally {
      if (request === patchRequest.current) setLoadingPatch(false);
    }
  };

  useEffect(() => {
    if (!showRawToolOutput) return;
    patchRequest.current += 1; // ignore a response from a no-longer-visible diff
    setLoadingPatch(false);
  }, [showRawToolOutput]);
  useEffect(() => {
    if (!expanded || !patchAvailable || showRawToolOutput) return;
    const panel = patchPanelRef.current;
    if (!panel) return;
    if (typeof IntersectionObserver === "undefined") { setPatchInView(true); return; }
    // Shared IntersectionObserver (instead of a new IntersectionObserver( per row).
    let timer: number | null = null;
    let stop: (() => void) | undefined;
    stop = observeElementIntersection(panel, panel.closest(".terminal-body"), "160px", (intersecting) => {
      if (intersecting) {
        if (timer === null) {
          timer = window.setTimeout(() => {
            timer = null;
            setPatchInView(true);
            stop?.();
          }, 120);
        }
      } else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      stop?.();
    };
  }, [expanded, patchAvailable, showRawToolOutput, details?.patchRef?.id]);
  useEffect(() => {
    if (expanded && (manuallyOpenedRef.current || patchInView) && !showRawToolOutput && patchAvailable && !patchDoc && !patchError && !loadingPatch) void loadPatch();
  }, [expanded, patchInView, showRawToolOutput, patchAvailable, patchDoc, patchError, loadingPatch, details?.patchRef?.id]);

  const showEverything = async () => {
    if (!needsStoredOutput) { setShowAll(true); return; }
    const request = ++outputRequest.current;
    setLoadingFull(true);
    setFullError(null);
    try {
      const pages: string[] = [];
      let offset = 0;
      for (;;) {
        const page = await api.readToolOutputPage({ session_id: sessionId, event_id: eventId, offset_bytes: offset, source: "output" });
        if (request !== outputRequest.current) return;
        if (!page.ok) throw new Error(page.error ?? "Full output is unavailable.");
        if (page.encoding !== "utf8") throw new Error("This tool output is binary, not displayable text.");
        if (page.offset_bytes !== offset || (page.byte_len === 0 && !page.eof)) throw new Error("Tool output paging stopped unexpectedly.");
        pages.push(page.content);
        offset += page.byte_len;
        if (offset > 64 * 1024 * 1024) throw new Error("Tool output exceeds the 64 MiB display limit.");
        if (page.eof) break;
      }
      if (request === outputRequest.current) { setFullOutput(pages.join("")); setShowAll(true); }
    } catch (error) {
      if (request === outputRequest.current) setFullError(error instanceof Error ? error.message : "Full output could not be loaded.");
    } finally {
      if (request === outputRequest.current) setLoadingFull(false);
    }
  };

  return (
    <div className="tool-box">
      <button
        type="button"
        className="tool-row tool-trigger"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={() => {
          if (expanded) setShowAll(false);
          else manuallyOpenedRef.current = true;
          setExpanded(!expanded);
        }}
      >
        <span className="message-text tool-text" title={text}>
          <strong className={`tool-name${presentation.emphasizeName ? " tool-name-error" : ""}`}>{presentation.name}</strong>
          {presentation.detail && <span className="tool-detail"> · {presentation.detail}</span>}
        </span>
        {presentation.adapterId === "edit" && !running && !details?.failureReason && details?.status === "completed" && details.patchSummary && (
          <span className="tool-diff-counts" aria-label={`${details.patchSummary.added} additions, ${details.patchSummary.removed} deletions`}>
            <span className="add">+{details.patchSummary.added}</span>{" "}
            <span className="remove">−{details.patchSummary.removed}</span>
          </span>
        )}
        {running ? (
          <span className="working-spinner tool-run-spinner" aria-hidden="true" />
        ) : presentation.metric ? (
          <span className="tool-file-metric" title="File length">{presentation.metric}</span>
        ) : presentation.showDuration && elapsed !== null ? (
          <span className="tool-duration" title="Run time">{formatToolDuration(elapsed, false)}</span>
        ) : null}
      </button>
      {expanded && (
        <div ref={patchPanelRef} id={panelId} className={`tool-transcript${!showRawToolOutput && (diffDoc || filePreview || searchPreview) ? " has-code-view" : ""}`}>
          {filePreview && <ToolFileView preview={filePreview} workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} />}
          {searchPreview && <ToolSearchView preview={searchPreview} />}
          {agentList && <AgentListToolView list={agentList} />}
          {presentation.adapterId === "edit" && !showRawToolOutput && diffDoc && (
            <>
              {(!patchDoc || details?.failureReason || /^(failed|rejected|cancelled|canceled)$/i.test(details?.status ?? "")) && (
                <div className="tool-diff-caption">{patchDoc ? "Recorded changes (edit failed)" : "Reported diff (unverified)"}</div>
              )}
              <ToolDiff doc={diffDoc} />
            </>
          )}
          {presentation.adapterId === "edit" && !showRawToolOutput && !diffDoc && patchAvailable && (
            <>
              <div className="tool-diff-caption" role="status">{loadingPatch ? "Loading diff…" : patchError ? "Diff unavailable" : "Preparing diff…"}</div>
              {patchError && <p className="tool-output-error" role="alert">{patchError} <button type="button" className="tool-more" onClick={() => setPatchError(null)}>Retry diff</button></p>}
            </>
          )}
          {(presentation.adapterId !== "edit" || showRawToolOutput || (!diffDoc && !patchAvailable)) && (showRawToolOutput || (!filePreview && !searchPreview && !agentList)) && (
            presentation.view === "command" && !showRawToolOutput && presentation.command !== null ? (
              <pre className="tool-command">{presentation.command}</pre>
            ) : presentation.adapterId === "github-monitor-pr" && !showRawToolOutput ? (
              <pre>{fullOutput ?? details?.output ?? (running ? "(waiting for output…)" : "")}</pre>
            ) : (
              <>
                <pre>{presentation.view === "json" && !showRawToolOutput && jsonText
                  ? tokenizeJson((showAll ? previewLines : previewLines.slice(0, TOOL_PREVIEW_LINES)).join("\n")).map((token, index) => <span key={index} className={`json-token-${token.kind}`}>{token.text}</span>)
                  : (showAll ? lines : lines.slice(0, TOOL_PREVIEW_LINES)).join("\n")}</pre>
                {fullError && <p className="tool-output-error" role="alert">{fullError}</p>}
                {(needsStoredOutput || hasMore) && (
                  <button type="button" className="tool-more" disabled={loadingFull} onClick={() => showAll ? setShowAll(false) : void showEverything()}>
                    {loadingFull ? "Loading full output…" : showAll ? "Show fewer" : needsStoredOutput ? "Show all output" : `Show all ${previewLines.length} lines`}
                  </button>
                )}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
});

// A message between agents, or from/to the user's Muse assistant. Incoming
// messages from Muse are unmistakable (Muse logo + "your assistant");
// other agents show as a name chip in that agent's hue.
type AgentMessage = {
  direction: "in" | "out";
  from: { kind: string; name: string; color?: string; sessionId?: string | null };
  to: { kind: string; name: string; color?: string; sessionId?: string | null };
  text: string;
  queued?: boolean;
};

// The assistant's theme color (default Muse #d0e4fc), as a CSS variable.
function assistantColorStyle(color: string | undefined): CSSProperties {
  return { "--assistant-color": /^#[0-9a-f]{6}$/i.test(color ?? "") ? color : "#d0e4fc" } as CSSProperties;
}

function AssistantMessageAvatar({ source }: { source: string | null }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return <span className="agent-message-peer-icon agent-message-assistant-avatar" aria-hidden="true">
    {source && source !== failedSource
      ? <img src={source} width={44} height={44} alt="" onError={() => setFailedSource(source)} />
      : <MuseIcon markOnly />}
  </span>;
}

const MessageEvent = memo(function MessageEvent({ content, agents, assistantAvatar }: { content: string; agents: readonly Session[]; assistantAvatar: string | null }) {
  let message: AgentMessage | null = null;
  try {
    message = JSON.parse(content) as AgentMessage;
  } catch {
    message = null;
  }
  if (!message) return <article className="output-event message"><div className="message-text">{content}</div></article>;
  const peer = message.direction === "in" ? message.from : message.to;
  const isMuse = peer.kind === "muse";
  const peerArtwork = companionArtwork[companionForName(peer.name)?.id ?? ""];
  const showPeerIcon = message.direction === "in" && (isMuse || !!peerArtwork);
  const style = isMuse
    ? assistantColorStyle(peer.color)
    : { "--agent-hue": messagePeerHue(peer, agents) } as CSSProperties;
  return (
    <article className={`output-event message${isMuse && message.direction === "in" ? " muse-incoming" : ""}`} style={style}>
      <div className={`agent-message ${message.direction}${isMuse ? " muse" : ""}${showPeerIcon ? " with-peer-icon" : ""}`}>
        {showPeerIcon && (isMuse ? <AssistantMessageAvatar source={assistantAvatar} />
          : peerArtwork && <img className="agent-message-peer-icon" src={peerArtwork.still} width={44} height={44} alt="" loading="lazy" />)}
        <div className="agent-message-head">
          <span className="agent-message-direction">{message.direction === "in" ? "From" : "To"}</span>
          {isMuse ? (
            <span className="agent-message-muse"><MuseIcon markOnly /> {displayAgentName(peer.name || "Muse")} <span className="agent-message-role">your Muse assistant</span></span>
          ) : (
            <span className="agent-message-identity">
              {displayAgentName(peer.name)}
            </span>
          )}
          {message.queued && <span className="agent-message-note">queued</span>}
        </div>
        <div className="message-text">{message.text}</div>
      </div>
    </article>
  );
}, (prev, next) => {
  if (prev.content !== next.content || prev.assistantAvatar !== next.assistantAvatar) return false;
  if (prev.agents === next.agents) return true;
  try {
    const message = JSON.parse(next.content) as AgentMessage;
    const peer = message.direction === "in" ? message.from : message.to;
    if (peer.kind === "muse") return true;
    return messagePeerHue(peer, prev.agents) === messagePeerHue(peer, next.agents);
  } catch {
    return true;
  }
});

function AgentListToolView({ list }: { list: AgentListOutput }) {
  return (
    <div className="agent-list-tool-view">
      <div className="agent-list-tool-intro">
        You are <span className="agent-message-peer" style={agentColorStyle(list.self)}>{displayAgentName(list.self)}</span>. You can message:
      </div>
      <div className="agent-list-tool-entries" role="list" aria-label="Agents you can message">
      {list.agents.map((agent, index) => (
        <div className="agent-list-tool-row" role="listitem" key={`${agent.name}-${index}`}>
          <span className="agent-list-tool-bullet" aria-hidden="true">•</span>
          {agent.assistant ? (
            <span className="agent-message-muse" style={assistantColorStyle(undefined)}>
              <MuseIcon markOnly /> {displayAgentName(agent.name)} <span className="agent-message-role">your Muse assistant</span>
            </span>
          ) : (
            <span className="agent-message-peer" style={agentColorStyle(agent.name)}>{displayAgentName(agent.name)}</span>
          )}
          {agent.busy && <span className="agent-message-note">working</span>}
        </div>
      ))}
      </div>
    </div>
  );
}

// Color sidebar rows by the companion name.
function agentColorStyle(name: string): CSSProperties {
  return { "--agent-hue": agentNameHue(name) } as CSSProperties;
}

const ContextRing = memo(function ContextRing({ value, max }: { value: number; max: number }) {
  const radius = 8;
  const progress = max > 0 ? Math.min(1, Math.max(0, Math.round((value / max) * 1000) / 1000)) : 0;

  return (
    <svg className="context-ring" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <circle className="context-ring-track" cx="12" cy="12" r={radius} />
      <circle
        className="context-ring-progress"
        cx="12"
        cy="12"
        r={radius}
        pathLength="1"
        strokeDasharray="1"
        strokeDashoffset={1 - progress}
      />
    </svg>
  );
});

function MicrophoneIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 18V6M7 11l5-5 5 5" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 12H6M11 7l-5 5 5 5" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="4" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14v7h16v-7" />
      <path d="M12 13V3M8 7l4-4 4 4" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16l-6.5 7.5V19l-3 2v-8.5L4 5z" />
    </svg>
  );
}

function MuseIcon({ markOnly = false }: { markOnly?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox={markOnly ? "5 4 19 16" : "0 0 24 24"} fill="none">
      {!markOnly && <path fill="#0082FB" d="M5.21566 12.2946C5.21566 11.8137 5.03842 11.4863 4.6187 10.821C4.16268 10.0982 2.76322 8.00886 2.30627 7.32052C1.84933 6.63248 1.53546 6.29985 0.977897 6.29985C0.35448 6.30016 0 6.75834 0 7.24052C0 7.7227 0.286784 8.10179 0.607724 8.58028C1.08146 9.28661 2.68633 11.6646 3.18239 12.3899C2.70886 13.0637 1.2199 15.3465 0.587415 16.2838C0.265245 16.7616 0.000307708 17.0776 0.000307708 17.5435C0.000307708 18.0094 0.346172 18.4753 0.969589 18.4753C1.52716 18.4753 1.84963 18.1512 2.30658 17.4632C2.76353 16.7752 4.04729 14.7391 4.5067 14.0326C4.97072 13.2307 5.21566 12.755 5.21566 12.2946Z" />}
      <path fill="currentColor" d="M20.4257 9.80188C20.4586 8.7849 19.8844 8.40765 19.2939 8.40765C18.6213 8.40765 18.1458 8.86706 17.6864 9.58864C17.1462 10.4107 15.8154 12.7717 15.1032 14.0463C15.1791 13.2078 15.2945 11.9481 15.3571 11.3438C15.5048 9.94958 15.6196 8.62089 15.6196 7.86639C15.6196 6.91496 15.2094 6.32447 14.4715 6.32447C13.8973 6.32447 13.4545 6.60325 13.0117 7.32513C12.6674 7.86639 11.5027 9.86742 10.3873 12.1146C10.2982 12.3058 9.77366 13.3178 9.54375 13.7604C9.64787 13.0767 9.87707 11.5401 10.0211 10.3367C10.2257 8.76767 10.3894 7.59038 10.3894 6.7211C10.3894 5.85183 9.87157 5.38965 9.11615 5.38965C8.51089 5.38965 8.01701 5.70628 7.44991 6.29831C6.94803 6.82265 6.37077 7.57899 5.87413 8.29011C5.38211 8.94614 5.28056 9.27231 5.28056 9.64095C5.28056 9.89942 5.3898 10.1388 5.56704 10.3096C5.71689 10.4536 5.93198 10.5687 6.18092 10.5687C6.59694 10.5687 6.90465 10.3745 7.26559 9.86619C7.60101 9.41602 8.08193 8.66187 8.39719 8.15669C8.1684 9.58196 7.65514 12.7857 7.56622 13.3941C7.30375 15.0508 7.15635 16.2567 7.15635 17.077C7.15635 17.8974 7.50068 18.4789 8.23887 18.4789C8.97706 18.4789 9.50171 17.9377 9.94481 17.1995C10.5516 16.1662 11.4209 14.411 11.9295 13.3614C12.4253 12.345 13.2398 10.6446 13.608 9.87466C13.3904 11.5818 12.7855 16.4113 12.7991 17.2324C12.8154 17.9869 13.1108 18.4789 13.8161 18.4789C14.5214 18.4789 14.8331 18.118 15.4891 17.0684C16.1741 16.0044 17.6799 13.28 18.4014 11.9635C18.3308 12.6067 18.2304 13.5722 18.1462 14.5754C18.0643 15.4446 17.9985 16.4124 18.0151 16.9373C18.0314 17.4623 18.1628 17.8888 18.4416 18.1839C18.704 18.4626 19.0813 18.6103 19.5404 18.6103C20.0601 18.6103 20.4097 18.4626 20.7543 18.1839C21.0331 17.9706 21.3229 17.6469 21.7282 17.1352C22.1581 16.593 22.8713 15.5489 23.231 14.9197C23.5907 14.2904 24 13.5901 24 13.0217C24 12.4534 23.6624 12.1109 23.1507 12.1109C22.5547 12.1109 22.2307 12.5743 21.9027 13.1156C21.5475 13.7029 20.8536 14.8291 20.0511 16.0097C20.1505 14.5349 20.3634 11.306 20.4257 9.80188Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

// Right-pointing chevron with a 90° corner; CSS turns it down when the group
// is expanded (aria-expanded on the header button).
function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" />
    </svg>
  );
}

type PendingUserInput = ApiResponse<typeof api, "getPendingUserInputs">["inputs"][number];

function UserInputCard({
  input,
  busy,
  error,
  onAnswer,
  onCancel,
}: {
  input: PendingUserInput;
  busy: boolean;
  error: string | null;
  onAnswer: (userInputId: string, selections: Array<{ questionId: string; selectedLabels?: string[]; freeText?: string }>) => void;
  onCancel: (userInputId: string) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});

  const toggleOption = (questionId: string, label: string, multiple: boolean) => {
    setFree((current) => ({ ...current, [questionId]: "" }));
    setPicked((current) => {
      const currentPicked = current[questionId] ?? [];
      if (multiple) {
        return {
          ...current,
          [questionId]: currentPicked.includes(label)
            ? currentPicked.filter((item) => item !== label)
            : [...currentPicked, label],
        };
      }
      return { ...current, [questionId]: [label] };
    });
  };

  const submit = () => {
    onAnswer(
      input.userInputId,
      input.questions.map((question) => ({
        questionId: question.id,
        selectedLabels: picked[question.id] ?? [],
        freeText: free[question.id] ?? "",
      })),
    );
  };

  return (
    <div className="user-input-card" role="group" aria-label="Companion question">
      <p className="eyebrow">Input needed</p>
      {input.questions.map((question) => {
        const multiple = question.selection.mode === "multiple";
        return (
          <div key={question.id} className="user-input-question-block">
            {question.header && <p className="user-input-header">{question.header}</p>}
            {question.question && <p className="user-input-question">{question.question}</p>}
            {(question.options ?? []).length > 0 && (
              <div className="user-input-options" role={multiple ? "group" : "radiogroup"} aria-label={question.header || question.question || question.id}>
                {(question.options ?? []).map((option) => (
                  <label key={option.label} className="user-input-option">
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={`user-input-${input.userInputId}-${question.id}`}
                      checked={(picked[question.id] ?? []).includes(option.label)}
                      onChange={() => toggleOption(question.id, option.label, multiple)}
                      disabled={busy}
                    />
                    <span>
                      <span className="user-input-option-label">{option.label}</span>
                      {option.description && <span className="user-input-option-desc">{option.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <input
              className="user-input-free"
              aria-label={question.header ? `${question.header} — write your own answer` : "Write your own answer"}
              placeholder="Or write your own answer…"
              value={free[question.id] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setFree((current) => ({ ...current, [question.id]: value }));
                if (value.trim()) setPicked((current) => ({ ...current, [question.id]: [] }));
              }}
              maxLength={500}
              disabled={busy}
            />
          </div>
        );
      })}
      {error && (
        <p className="form-error" role="alert">{error}</p>
      )}
      <div className="user-input-actions">
        <button
          type="button"
          className="user-input-submit"
          onClick={submit}
          disabled={busy}
        >
          {busy ? "Sending…" : "Send answer"}
        </button>
        <button
          type="button"
          className="user-input-skip"
          onClick={() => onCancel(input.userInputId)}
          disabled={busy}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

type TranscriptEvent = ApiResponse<typeof api, "getSession">["events"][number];

const TranscriptEventRow = memo(function TranscriptEventRow({
  event,
  detailSessionId,
  detailWorkspaceRoot,
  nowMs,
  expandTools,
  showRawToolOutput,
  openFileTabForDetail,
}: {
  event: TranscriptEvent;
  detailSessionId: string;
  detailWorkspaceRoot: string;
  nowMs: number;
  expandTools: boolean;
  showRawToolOutput: boolean;
  openFileTabForDetail: (path: string) => void;
}) {
  const reasoning = event.kind === "thinking" ? reasoningDisplay(event.content) : null;
  const content = displayOutput(reasoning?.summary ?? event.content);
  if (event.kind === "thinking" && !content.trim()) return null;
  const time = event.kind === "stdout" ? formatMessageTime(event.created_at, nowMs) : "";
  return (
    <article className={`output-event ${event.kind}${event.system_is_error ? " system-error" : ""}`}>
      {event.kind === "user" ? (
        <div className="message-text">
          {content}
        </div>
      ) : event.kind === "agents" ? (
        <AgentsEvent sessionId={detailSessionId} content={event.content} startedAt={event.started_at} finishedAt={event.finished_at} nowMs={nowMs} />
      ) : event.kind === "pr_monitor" ? (
        <PrMonitorEvent content={event.content} />
      ) : event.kind === "tool" ? (
        <ToolEvent sessionId={detailSessionId} workspaceRoot={detailWorkspaceRoot} eventId={event.id} text={content} details={event.tool_details} startedAt={event.started_at} finishedAt={event.finished_at} expandedByDefault={expandTools} showRawToolOutput={showRawToolOutput} onOpenFile={openFileTabForDetail} />
      ) : event.kind === "thinking" ? (
        <>
          <Markdown text={content} />
          {reasoning?.truncated && <div className="message-time" role="note" aria-label="Reasoning summary truncated" title="Reasoning summary truncated">...</div>}
        </>
      ) : event.kind === "stdout" ? (
        <>
          <Markdown text={content} />
          {time !== "" && (
            <div className="message-time">{time}</div>
          )}
        </>
      ) : (
        <div className="message-text">{content}</div>
      )}
    </article>
  );
}, (prev, next) =>
  prev.event === next.event &&
  prev.detailSessionId === next.detailSessionId &&
  prev.detailWorkspaceRoot === next.detailWorkspaceRoot &&
  prev.expandTools === next.expandTools &&
  prev.showRawToolOutput === next.showRawToolOutput &&
  prev.openFileTabForDetail === next.openFileTabForDetail &&
  (prev.event.kind !== "stdout" || prev.nowMs === next.nowMs || formatMessageTime(prev.event.created_at, prev.nowMs) === formatMessageTime(next.event.created_at, next.nowMs)) &&
  (prev.event.kind !== "agents" || prev.event.finished_at !== null || prev.nowMs === next.nowMs),
);

const SessionRow = memo(function SessionRow({
  session,
  selected,
  past,
  archiveBusy,
  deleteBusy,
  onDeleteClick,
  nowMs,
  onSelect,
  onArchiveClick,
  onRestoreClick,
  renaming,
  renameValue,
  renameBusy,
  onRenameClick,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: {
  session: Session;
  selected: boolean;
  /** Shown in the Past list: no rename, and delete replaces archive/restore. */
  past: boolean;
  archiveBusy: boolean;
  deleteBusy: boolean;
  /** Opens the permanent-delete confirmation dialog. */
  onDeleteClick: () => void;
  nowMs: number;
  onSelect: () => void;
  onArchiveClick: () => void;
  onRestoreClick: () => void;
  renaming: boolean;
  renameValue: string;
  renameBusy: boolean;
  onRenameClick: () => void;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
}) {
  // Active sessions can't be archived; archived ones offer restore instead.
  const actionable = session.archived || !isTurnLive(session.status);
  const displayTitle = displayAgentName(session.title);
  const summary = sessionTaskTitle(session);
  const rosterArtwork = companionArtwork[companionForName(session.title)?.id ?? ""];
  const taskState = session.needs_you ? "Needs you" : session.status === "failed" ? "Needs attention"
    : session.status === "queued" ? "Waiting to start" : session.status === "running" ? "Working" : session.status === "succeeded" ? "Finished"
    : session.status === "stopped" ? "Stopped" : "Ready";
  const visual = agentVisualStatus(session);
  return (
    <div className={`session-row${selected ? " selected" : ""}${summary ? " has-summary" : ""}${visual === "unread" ? " unread" : ""}`} style={agentColorStyle(session.title)}>
      {renaming ? (
        <form
          className="session-rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            onRenameSubmit();
          }}
        >
          <input
            className="session-rename-input"
            aria-label={`Rename task for ${displayTitle}`}
            value={renameValue}
            onChange={(event) => onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onRenameCancel();
            }}
            maxLength={240}
            autoFocus
            disabled={renameBusy}
          />
        </form>
      ) : (
        <button
          type="button"
          className="session-row-select"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Open ${displayTitle}${summary ? `, ${summary}` : ""}, ${visual === "unread" ? "unread output, " : ""}${statusLabel(session.status, session.pilot_session_id)}`}
          title={summary ? `${displayTitle} — ${summary}` : displayTitle}
        >
          {rosterArtwork && <CompanionAvatar className="companion-task-avatar" artwork={rosterArtwork} animate={!session.archived} />}
          <StatusMark visual={visual} />
          <span className="session-name-block">
            <span className="session-title">{displayTitle}</span>
            {summary && <span className="session-summary" title={summary}>{summary}</span>}
            <span className="companion-task-state">{taskState}</span>
          </span>
          <time className="session-time" dateTime={session.updated_at}>{formatRelativeTime(session.updated_at, nowMs)}</time>
        </button>
      )}
      {/* Hover-only on pointer devices (theme.css); touch devices reach the
          same actions from the transcript's session menu. */}
      {!renaming && (
      <div className="session-row-actions">
        {past ? (
          // Past sessions: delete only (permanent, confirmed in a dialog).
          <button
            type="button"
            className="session-row-archive session-row-delete"
            onClick={onDeleteClick}
            disabled={deleteBusy || !actionable}
            aria-label={`Delete task: ${sessionTaskTitle(session)}`}
            title="Delete task permanently…"
          >
            <TrashIcon />
          </button>
        ) : (
          <>
        <button
          type="button"
          className="session-row-archive"
          onClick={onRenameClick}
          disabled={renameBusy}
          aria-label={`Rename task for ${displayTitle}`}
          title="Rename task"
        >
          <PencilIcon />
        </button>
      {actionable && (
        <button
          type="button"
          className="session-row-archive"
          onClick={session.archived ? onRestoreClick : onArchiveClick}
          disabled={archiveBusy}
          aria-label={session.archived ? `Restore task for ${displayTitle}` : `Archive task for ${displayTitle}`}
          title={session.archived ? "Restore task" : "Archive task"}
        >
          {session.archived ? <RestoreIcon /> : <ArchiveIcon />}
        </button>
      )}
          </>
        )}
      </div>
      )}
    </div>
  );
});

export function App() {
  const [selectedCompanionId, setSelectedCompanionId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("active");
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    try {
      const saved = window.localStorage.getItem(SORT_MODE_KEY);
      return saved === "updated" || saved === "created" ? saved : "priority";
    } catch { return "priority"; }
  });
  const [sessionFilterInput, setSessionQuery] = useState("");
  const [availableExpanded, setAvailableExpanded] = useState(false);
  const [moreAvailableExpanded, setMoreAvailableExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Latest selection for async work (queued sends) that outlives a render.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia("(max-width: 779px)").matches);
  const [mobileListOpen, setMobileListOpen] = useState(() => window.matchMedia("(max-width: 779px)").matches);
  // Narrow screens get a third full-screen view for the side panel
  // (tab strip + active tab), reached from the conversation and left
  // via its back button — same pattern as list <-> conversation.
  const [mobileSideOpen, setMobileSideOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [paneSizes, setPaneSizes] = useState(() => loadPaneSizes(window.innerWidth));
  const layoutRef = useRef<HTMLDivElement>(null);
  const detailSplitRef = useRef<HTMLDivElement>(null);
  const [detailSplitWidth, setDetailSplitWidth] = useState(0);
  const [direction, setDirection] = useState("");
  const [composerFocused, setComposerFocused] = useState(false);
  const [caretPosition, setCaretPosition] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pendingDirection, setPendingDirection] = useState<string | null>(null);
  // When the pending prompt was sent: "Sending (…)" counts from here, not
  // from the previous prompt still last in the transcript.
  const [pendingSentAtMs, setPendingSentAtMs] = useState(0);
  const [pendingEchoAnchor, setPendingEchoAnchor] = useState(0);
  const [sendingDirection, setSendingDirection] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [retryingStart, setRetryingStart] = useState(false);
  const [startRetryError, setStartRetryError] = useState<string | null>(null);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [takeoverStatus, setTakeoverStatus] = useState<string | null>(null);
  const firstMessageSendingRef = useRef(false);
  const [draft, setDraft] = useState<NewSessionDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [startingDraft, setStartingDraft] = useState<QueuedDraft | null>(null);
  const [queuedPrompt, setQueuedPrompt] = useState<QueuedPrompt | null>(null);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine !== false);
  const [sendFailedAt, setSendFailedAt] = useState(0);
  const [pilotSync, setPilotSync] = useState<Record<string, boolean>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [inputBusyId, setInputBusyId] = useState<string | null>(null);
  const [inputError, setInputError] = useState<{ userInputId: string; error: string } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  // The one open text dialog (rename, working directory).
  const [textPrompt, setTextPrompt] = useState<TextPromptSpec | null>(null);
  // Side panel tabs per session (today: terminals). Rebuilt from the pilot
  // the first time a session is opened (`loaded`), so tabs survive reloads.
  const [sidePanels, setSidePanels] = useState<Record<string, SidePanelState & { loaded: boolean }>>({});
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // A view preference, never a Muse turn/start option. Summary events are
  // stored regardless of visibility, and can be toggled mid-turn.
  const [showReasoning, setShowReasoning] = useState(() => {
    try { return window.localStorage.getItem(SHOW_REASONING_KEY) !== "false"; } catch { return true; }
  });
  const [expandTools, setExpandTools] = useState(() => {
    try { return window.localStorage.getItem(EXPAND_TOOLS_KEY) === "true"; } catch { return false; }
  });
  const [showRawToolOutput, setShowRawToolOutput] = useState(() => {
    try { return window.localStorage.getItem(RAW_TOOL_OUTPUT_KEY) === "true"; } catch { return false; }
  });
  const [showWorkingDetails, setShowWorkingDetails] = useState(() => {
    try { return window.localStorage.getItem(WORKING_DETAILS_KEY) === "true"; } catch { return false; }
  });
  const [colorMode, setColorMode] = useState<ColorMode>(loadColorMode);
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const scrollControlsRef = useRef<HTMLDivElement>(null);
  const scrollToBottomButtonRef = useRef<HTMLButtonElement>(null);
  const snappedSessionRef = useRef<string | null>(null);
  const followTranscriptRef = useRef(true);
  const showScrollToBottomRef = useRef(false);
  const setShowScrollToBottom = useCallback((show: boolean) => {
    showScrollToBottomRef.current = show;
    scrollControlsRef.current?.classList.toggle("visible", show);
    if (scrollToBottomButtonRef.current) scrollToBottomButtonRef.current.tabIndex = show ? 0 : -1;
  }, []);
  const syncingSessionsRef = useRef(new Set<string>());
  const backgroundCursorRef = useRef(0);
  const backgroundTargetsRef = useRef<Array<{ id: string; status: Session["status"] }>>([]);
  const requestedSeenRef = useRef(new Map<string, number>());
  const takeoverFormRef = useRef<HTMLFormElement>(null);
  const draftFormRef = useRef<HTMLFormElement>(null);
  const takeoverInputRef = useRef<HTMLTextAreaElement>(null);
  const draftInputRef = useRef<HTMLTextAreaElement>(null);
  const suppressMentionKeyUpRef = useRef(false);
  const promptHistoryStateRef = useRef<PromptHistoryState>(INITIAL_PROMPT_HISTORY_STATE);
  const sentPromptsRef = useRef<string[]>([]);
  // Flips once a key only a physical keyboard can produce is seen, so a
  // Bluetooth keyboard on a touch device gets desktop Enter-to-submit.
  const hardwareKeyboardSeenRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isHardwareKeyEvent(event.key)) hardwareKeyboardSeenRef.current = true;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // No viewport tracking: the visual-viewport height heuristic misreports
  // on real devices (stale or under-threshold readings with the software
  // keyboard open), which let a virtual Return submit. On a touch-primary
  // device Enter is a newline until a hardware-only key proves a physical
  // keyboard — only the send button submits before that.

  useEffect(() => {
    // A saved desktop width must not make a newly narrowed window overflow.
    const onResize = () => {
      const width = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
      setViewportWidth(width);
      if (width < 780) return;
      setPaneSizes((current) => {
        const sidebarWidth = clampSidebarWidth(current.sidebarWidth, width);
        const chatShare = clampChatShare(current.chatShare, width - sidebarWidth - DIVIDER_WIDTH);
        return sidebarWidth === current.sidebarWidth && chatShare === current.chatShare
          ? current : { sidebarWidth, chatShare };
      });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    const element = layoutRef.current;
    if (!isNarrow || mobileListOpen || !element) return;
    const viewport = window.visualViewport;
    const spaceRoot = document.querySelector<HTMLElement>("[data-generated-space-root]");
    const measure = () => {
      if (!viewport || viewport.scale !== 1) return;
      if (spaceRoot && spaceRoot.scrollTop !== 0) spaceRoot.scrollTop = 0;
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      const height = Math.max(0, Math.floor(viewport.height + viewport.offsetTop - element.getBoundingClientRect().top));
      element.style.height = `${height}px`;
      element.style.maxHeight = `${height}px`;
      if (followTranscriptRef.current && terminalBodyRef.current) {
        terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight;
      }
    };
    measure();
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      element.style.removeProperty("height");
      element.style.removeProperty("max-height");
    };
  }, [isNarrow, mobileListOpen]);

  useEffect(() => { savePaneSizes(paneSizes); }, [paneSizes]);
  useEffect(() => {
    try { window.localStorage.setItem(SHOW_REASONING_KEY, String(showReasoning)); } catch { /* webview storage can be disabled */ }
  }, [showReasoning]);
  useEffect(() => {
    try { window.localStorage.setItem(EXPAND_TOOLS_KEY, String(expandTools)); } catch { /* webview storage can be disabled */ }
  }, [expandTools]);
  useEffect(() => {
    try { window.localStorage.setItem(RAW_TOOL_OUTPUT_KEY, String(showRawToolOutput)); } catch { /* webview storage can be disabled */ }
  }, [showRawToolOutput]);
  useEffect(() => {
    try { window.localStorage.setItem(WORKING_DETAILS_KEY, String(showWorkingDetails)); } catch { /* webview storage can be disabled */ }
  }, [showWorkingDetails]);
  useEffect(() => {
    try { window.localStorage.setItem(SORT_MODE_KEY, sortMode); } catch { /* webview storage can be disabled */ }
  }, [sortMode]);
  useEffect(() => {
    applyColorMode(colorMode);
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    if (colorMode === "system") {
      const updateSystemMode = () => applyColorMode("system");
      systemTheme.addEventListener("change", updateSystemMode);
      return () => systemTheme.removeEventListener("change", updateSystemMode);
    }
  }, [colorMode]);
  useEffect(() => {
    try { window.localStorage.setItem(COLOR_MODE_KEY, colorMode); } catch { /* webview storage can be disabled */ }
  }, [colorMode]);

  const queryClient = useQueryClient();
  const assistantIdentityQuery = useQuery({
    queryKey: ["assistant-identity"],
    queryFn: () => api.getAssistantIdentity({}),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const activeMention = composerFocused && caretPosition !== null ? mentionAtCursor(direction, caretPosition) : null;
  const mentionAgentsQuery = useQuery({
    queryKey: ["messageable-agents"],
    queryFn: () => api.listAgents({}),
    enabled: activeMention !== null,
    staleTime: 5000,
    refetchInterval: activeMention !== null ? 15_000 : false,
    retry: false,
  });
  const sessionsQuery = useQuery({
    queryKey: ["code-sessions"],
    queryFn: async () => {
      const isInitialLoad = !queryClient.getQueryData(["code-sessions"]);
      const data = await api.listSessions({ limit: 100 });
      if (isInitialLoad) {
        const activeSessions = data.sessions.filter((item) => !item.archived);
        const urls = new Set<string>();
        for (const item of activeSessions) {
          const url = companionArtwork[companionForName(item.title)?.id ?? ""]?.still;
          if (url) urls.add(url);
        }
        if (activeSessions.length === 0) {
          for (const companion of companions) {
            if (isDefaultCompanion(companion)) urls.add(companion.artwork.still);
          }
          if (companions[0]?.artwork.cardStill) urls.add(companions[0].artwork.cardStill);
        }
        if (urls.size > 0) {
          await Promise.all([...urls].map((url) => preloadCompanionStill(url)));
        }
      }
      return data;
    },
    refetchInterval: 3000,
  });
  // Durable first prompts survive service restarts in app.db. On every open
  // (and every few seconds while open), ask the worker to start one pending
  // agent. A DB lease and the pilot's workspaceName key dedupe concurrent
  // views and lost HTTP replies.
  const hasPendingAgents = sessionsQuery.data?.sessions.some((item) => item.status === "queued" && item.pilot_session_id === null) ?? false;
  useQuery({
    queryKey: ["recover-pending-agents"],
    queryFn: async () => {
      const result = await api.recoverPendingAgents({});
      if (result.started || result.failed) await sessionsQuery.refetch();
      return result;
    },
    enabled: hasPendingAgents,
    notifyOnChangeProps: [],
    refetchInterval: 5000,
    retry: false,
  });
  const hostConfigQuery = useQuery({
    queryKey: ["host-config"],
    queryFn: () => api.getHostConfig({}),
    staleTime: Infinity,
  });
  // Before anything below builds or shortens a workspace path this render.
  if (hostConfigQuery.data) setHostHomeRoot(hostConfigQuery.data.home_root);
  const modelsQuery = useQuery({
    queryKey: ["companion-model-access"],
    queryFn: () => api.listModels({}),
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: 30_000,
    staleTime: 5000,
    retry: false,
  });
  const accessibleModels = modelsQuery.data?.access_checked ? modelsQuery.data.models : undefined;
  const projectsQuery = useQuery({
    queryKey: ["code-projects"],
    queryFn: () => api.listProjects({}),
    refetchInterval: 15_000,
  });
  const projects = projectsQuery.data?.projects ?? [];
  // Repos for the first-message repo picker. Fetched only while a new
  // companion draft is on screen; the server answers an empty list (never
  // an error) when GitHub isn't set up, and pasting still works.
  const reposQuery = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => api.listRepos({}),
    enabled: draft !== null || selectedCompanionId !== null || selectedId !== null,
    staleTime: 60_000,
    retry: false,
  });
  const cloningSessionId = startingDraft?.draft.repoSlug
    ? startingDraft.draft.id
    : null;
  const cloneProgressQuery = useQuery({
    queryKey: ["repo-clone-progress", cloningSessionId],
    queryFn: () => api.getRepoCloneProgress({ session_id: cloningSessionId! }),
    enabled: cloningSessionId !== null,
    refetchInterval: 400,
    retry: false,
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const sessionQuery = sessions.length > 1 ? sessionFilterInput : "";
  const selectedCompanion = companions.find((companion) => companion.id === selectedCompanionId) ?? null;
  const selectedModelAccess = selectedCompanion ? companionModelAccess(selectedCompanion, accessibleModels) : null;
  const selectedModelBlocked = selectedModelAccess !== null && selectedModelAccess.status !== "ready";
  const availableCompanions = useMemo(
    () => orderCompanionsByAccess(availableCompanionDefinitions(sessions), accessibleModels),
    [sessions, accessibleModels],
  );
  const matchingAvailableCompanions = useMemo(
    () => availableCompanions.filter((companion) => matchesCompanionQuery(companion, sessionQuery)),
    [availableCompanions, sessionQuery],
  );
  const visibleAvailableCompanions = useMemo(
    () => moreAvailableExpanded || sessionQuery.trim()
      ? matchingAvailableCompanions : matchingAvailableCompanions.filter(isDefaultCompanion),
    [moreAvailableExpanded, sessionQuery, matchingAvailableCompanions],
  );
  const hasActiveTasks = sessions.some((session) => !session.archived);
  const availableOpen = !hasActiveTasks || availableExpanded;
  useEffect(() => { setAvailableExpanded(false); }, [hasActiveTasks]);
  backgroundTargetsRef.current = sessions.filter((item) => !item.archived && item.pilot_session_id && (isTurnLive(item.status) || isSessionActive(item, nowMs)))
    .map((item) => ({ id: item.id, status: item.status }));
  const refetchSessionsRef = useRef(sessionsQuery.refetch);
  refetchSessionsRef.current = sessionsQuery.refetch;
  // Keep the UI visible during outages. The companion's status bubble shows
  // "Connecting…" until polling can reach the backend again.
  const connectionLost = isConnectionLost({
    browserOnline,
    listFailed: sessionsQuery.isError,
    sendFailedAt,
    listUpdatedAt: sendFailedAt > 0 ? sessionsQuery.dataUpdatedAt : 0,
  });
  // The app can still serve cached DB-backed sessions while its pilot is
  // down. Don't treat a successful session-list fetch as pilot connectivity.
  const pilotUnavailable = selectedId !== null && pilotSync[selectedId] === false;
  const promptConnectionLost = connectionLost || pilotUnavailable;
  const queuedSessionId = queuedPrompt?.kind === "message" ? queuedPrompt.sessionId : null;
  // A queued follow-up waits for its own session's poll, even after navigating
  // to another companion. A successful app list says nothing about the pilot.
  const queuedPilotUnavailable = queuedSessionId !== null && pilotSync[queuedSessionId] !== true;
  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);


  useEffect(() => () => {
    voiceRecognitionRef.current?.stop();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 779px)");
    const update = () => setIsNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isNarrow) setMobileListOpen(false);
  }, [isNarrow]);

  // The side-panel full-screen view exists only at narrow widths and
  // only for the conversation it was opened from.
  useEffect(() => {
    if (!isNarrow) setMobileSideOpen(false);
  }, [isNarrow]);
  const draftSelected = draft !== null && selectedId === draft.id;
  const mentionSender = draftSelected ? null : sessions.find((session) => session.id === selectedId) ?? null;
  const availablePeerAgents: MentionAgent[] = mentionAgentsQuery.data?.ok
    ? mentionAgentsQuery.data.agents.filter((agent) => !sessions.some((session) => session.archived && (
      session.id === agent.session_id || session.pilot_session_id === agent.session_id || session.title.toLowerCase() === agent.name.toLowerCase()
    )))
    : sessions.filter((session) => session.pilot_session_id && !session.archived)
      .map((session) => ({ name: session.title, session_id: session.id, busy: isTurnLive(session.status) }));
  const mentionAgents: MentionAgent[] = [
    ...availablePeerAgents,
    { name: mentionAgentsQuery.data?.assistant_name?.trim() || "Jolly", session_id: "muse", busy: false, assistant: true },
  ];
  const mentionMatches = activeMention ? matchingAgents(mentionAgents, activeMention.query, {
    id: mentionSender?.id ?? null,
    pilotId: mentionSender?.pilot_session_id ?? null,
    name: mentionSender?.title ?? null,
  }) : [];
  const selectedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionMatches.length - 1));
  const updateCaretPosition = (target: HTMLTextAreaElement) => {
    const next = target.value.includes("@") ? target.selectionStart : null;
    setCaretPosition((current) => (current === next ? current : next));
  };
  const chooseMention = (agent: MentionAgent) => {
    const input = (draftSelected ? draftInputRef : takeoverInputRef).current;
    const completed = completeMention(direction, input?.selectionStart ?? caretPosition ?? direction.length, agent.name);
    if (!completed) return;
    setDirection(completed.text);
    setCaretPosition(null); // dismiss this completed mention until typing resumes
    setMentionIndex(0);
    requestAnimationFrame(() => {
      if (input && document.activeElement !== input) input.focus();
      input?.setSelectionRange(completed.cursor, completed.cursor);
    });
  };
  const handleMentionKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!activeMention || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      suppressMentionKeyUpRef.current = true;
      setCaretPosition(null);
      return true;
    }
    if (mentionMatches.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + mentionMatches.length) % mentionMatches.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      suppressMentionKeyUpRef.current = true;
      chooseMention(mentionMatches[selectedMentionIndex]!);
      return true;
    }
    return false;
  };
  const handleHistoryKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const input = event.currentTarget;
    const history = draftSelected || selectedCompanion !== null
      ? buildPromptHistory([], sentPromptsRef.current)
      : buildPromptHistory(
          transcriptEvents,
          [
            ...(transcriptEvents.some((item) => item.kind === "user") || !detailSession?.prompt ? [] : [detailSession.prompt]),
            ...(pendingDirection ? [pendingDirection] : []),
          ],
        );
    const step = navigatePromptHistory({
      state: promptHistoryStateRef.current,
      key: event.key,
      currentText: direction,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      history,
    });
    if (!step) return false;
    event.preventDefault();
    suppressMentionKeyUpRef.current = true;
    promptHistoryStateRef.current = step.state;
    setDirection(step.value);
    setCaretPosition(step.value.includes("@") ? step.caret : null);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      if (document.activeElement !== input) input.focus();
      input.setSelectionRange(step.caret, step.caret);
    });
    return true;
  };

  useEffect(() => {
    if (sessions.length === 0 && selectedId !== null && selectedId !== draft?.id) {
      setSelectedId(null);
    }
  }, [selectedId, sessions.length, draft?.id]);

  useEffect(() => {
    setDirection("");
    setCaretPosition(null);
    promptHistoryStateRef.current = INITIAL_PROMPT_HISTORY_STATE;
    snappedSessionRef.current = null;
    followTranscriptRef.current = true;
    setShowScrollToBottom(false);
    setPendingDirection(null);
    setPendingEchoAnchor(0);
    setTakeoverError(null);
    setTakeoverStatus(null);
    setArchiveError(null);
    setVoiceError(null);
    setRenamingId(null);
    setRenameError(null);
    setInputBusyId(null);
    setInputError(null);
    setInterrupting(false);
    voiceRecognitionRef.current?.stop();
  }, [selectedId]);

  const selectedSession = sessions.find((item) => item.id === selectedId) ?? null;
  const detailQuery = useQuery({
    queryKey: ["code-session", selectedId],
    queryFn: async () => {
      const id = selectedId ?? "";
      const cached = queryClient.getQueryData<ApiResponse<typeof api, "getSession">>(["code-session", id]);
      let afterId: number | undefined;
      let immutablePrefix: TranscriptEvent[] = [];
      if (cached?.session?.id === id && cached.events.length > 0) {
        let cutoff = cached.events.length;
        for (let i = 0; i < cached.events.length; i++) {
          const ev = cached.events[i]!;
          if (
            ((ev.kind === "tool" || ev.kind === "thinking" || ev.kind === "agents") && ev.finished_at === null) ||
            (ev.kind === "pr_monitor" && parsePrMonitor(ev.content)?.status === "monitoring")
          ) {
            cutoff = i;
            break;
          }
        }
        if (cutoff > 0 && cached.events[cutoff - 1]!.id > 0) {
          afterId = cached.events[cutoff - 1]!.id;
          immutablePrefix = cached.events.slice(0, cutoff);
        }
      }
      const stillUrl = afterId === undefined
        ? companionArtwork[companionForName(selectedSession?.title ?? "")?.id ?? ""]?.still
        : undefined;
      const [rawData] = await Promise.all([
        api.getSession({
          id,
          event_limit: 1000,
          ...(afterId !== undefined ? { after_id: afterId } : {}),
        }),
        preloadCompanionStill(stillUrl),
      ]);
      const mergedEvents = afterId !== undefined && rawData.session
        ? rawData.events.length === 0 && immutablePrefix.length === cached?.events.length
          ? cached.events
          : immutablePrefix.concat(rawData.events).slice(-1000)
        : rawData.events;
      const data = afterId !== undefined && rawData.session
        ? {
            session: {
              ...rawData.session,
              output_count: mergedEvents.length,
              latest_output: rawData.session.latest_output ?? cached?.session?.latest_output ?? null,
            },
            events: mergedEvents,
          }
        : rawData;
      if (data.session) {
        const body = terminalBodyRef.current;
        const atBottom = selectedIdRef.current === id && !document.hidden && (body === null || followTranscriptRef.current || transcriptAtBottom(body));
        const syncedSession = atBottom && data.session.seen_output_revision < data.session.output_revision
          ? { ...data.session, seen_output_revision: data.session.output_revision }
          : data.session;
        queryClient.setQueryData<typeof sessionsQuery.data>(["code-sessions"], (old) => {
          if (!old) return old;
          let changed = false;
          const nextSessions = old.sessions.map((item) => {
            if (item.id !== id) return item;
            if (
              item.status === syncedSession.status &&
              item.title === syncedSession.title &&
              item.summary === syncedSession.summary &&
              item.session_summary === syncedSession.session_summary &&
              item.needs_you === syncedSession.needs_you &&
              item.archived === syncedSession.archived &&
              item.output_revision === syncedSession.output_revision &&
              agentVisualStatus(item) === agentVisualStatus(syncedSession)
            ) {
              return item;
            }
            changed = true;
            return syncedSession;
          });
          return changed ? { ...old, sessions: nextSessions } : old;
        });
        if (syncedSession !== data.session) {
          const revision = data.session.output_revision;
          if (revision > (requestedSeenRef.current.get(id) ?? 0)) {
            requestedSeenRef.current.set(id, revision);
            void api.markAgentSeen({ id, output_revision: revision }).then((res) => {
              if (!res.ok && requestedSeenRef.current.get(id) === revision) requestedSeenRef.current.delete(id);
            }).catch(() => {
              if (requestedSeenRef.current.get(id) === revision) requestedSeenRef.current.delete(id);
            });
          }
          return { ...data, session: syncedSession };
        }
      }
      return data;
    },
    enabled: selectedId !== null && selectedId !== draft?.id,
    refetchInterval: selectedSession && isTurnLive(selectedSession.status) ? 5000 : false,
  });
  const detailLoadedSession = detailQuery.data?.session ?? null;
  useEffect(() => {
    if (!selectedSession || !detailLoadedSession || detailLoadedSession.id !== selectedSession.id) return;
    if (
      selectedSession.output_revision > detailLoadedSession.output_revision ||
      selectedSession.status !== detailLoadedSession.status ||
      selectedSession.summary !== detailLoadedSession.summary
    ) {
      void queryClient.invalidateQueries({ queryKey: ["code-session", selectedSession.id] }, { cancelRefetch: false });
    }
  }, [
    selectedSession?.id,
    selectedSession?.output_revision,
    selectedSession?.status,
    selectedSession?.summary,
    detailLoadedSession?.id,
    detailLoadedSession?.output_revision,
    detailLoadedSession?.status,
    detailLoadedSession?.summary,
    queryClient,
  ]);
  // Read the whole durable write history, not just the transcript's last
  // 1000 displayed events. No file button appears until ownership is known.
  // The key must NOT include output_revision: it bumps on every streamed
  // event, and rekeying reset data to undefined, unmounting the button
  // until the refetch landed — the visible flicker during tool use (plus
  // a full server-side history scan per event). Poll while live instead,
  // keep showing the previous files during a refetch, and refresh once
  // more when the turn ends so late writes are not missed.
  const ownedArtifactsQuery = useQuery({
    queryKey: ["owned-artifacts", selectedId],
    queryFn: () => api.listOwnedArtifacts({ session_id: selectedId ?? "" }),
    enabled: selectedSession !== null && selectedId !== draft?.id,
    staleTime: 4000,
    placeholderData: keepPreviousData,
    refetchInterval: selectedSession && isTurnLive(selectedSession.status) ? 5000 : false,
  });
  const ownedFiles = ownedArtifactsQuery.data?.ok ? ownedArtifactsQuery.data.files : NO_OWNED_FILES;
  const ownedWasLiveRef = useRef(false);
  const selectedTurnLive = selectedSession !== null && isTurnLive(selectedSession.status);
  useEffect(() => {
    if (ownedWasLiveRef.current && !selectedTurnLive && selectedId) {
      void queryClient.invalidateQueries({ queryKey: ["owned-artifacts", selectedId] });
    }
    ownedWasLiveRef.current = selectedTurnLive;
  }, [selectedTurnLive, selectedId, queryClient]);

  // Agent questions for the user (`request_user_input` transport): polled
  // live so the answer UI appears even before the transcript marker syncs.
  const shouldPollPendingInputs = selectedSession !== null && !selectedSession.archived &&
    (isTurnLive(selectedSession.status) || selectedSession.needs_you);
  const pendingInputsQuery = useQuery({
    queryKey: ["pending-user-inputs", selectedId],
    queryFn: () => api.getPendingUserInputs({ id: selectedId ?? "" }),
    enabled: shouldPollPendingInputs,
    refetchInterval: shouldPollPendingInputs ? 3000 : false,
  });
  const pendingInputs = pendingInputsQuery.data?.ok ? pendingInputsQuery.data.inputs : [];

  const minuteClockMs = Math.floor(nowMs / 60_000) * 60_000;
  const visibleSessions = useMemo(() => {
    // A quiet task still owns its companion until it is archived.
    const base =
      filter === "inactive"
        ? sessions.filter((item) => item.archived)
        : sessions.filter((item) => !item.archived);
    return base.filter((item) => matchesSessionQuery(item, sessionQuery));
  }, [filter, sessions, sessionQuery]);
  const sidebarTimeSignature = useMemo(() => {
    const ageSig = filter === "inactive"
      ? groupSessionsByAge(visibleSessions, minuteClockMs).map((g) => `${g.key}:${g.sessions.length}`).join(",")
      : "";
    return `${ageSig}|${visibleSessions.map((s) => `${s.id}:${formatRelativeTime(s.updated_at, minuteClockMs)}`).join("|")}`;
  }, [filter, visibleSessions, minuteClockMs]);
  const sidebarClockMs = useMemo(() => minuteClockMs, [sidebarTimeSignature]);

  const filterLabel = FILTERS.find((item) => item.value === filter)?.label ?? filter;

  // Active groups by project; Past groups by age (Yesterday, Earlier this week, Earlier).
  const sessionGroups = useMemo(() => {
    const nowMs = sidebarClockMs;
    const groups = filter === "inactive"
      ? groupSessionsByAge(visibleSessions, nowMs)
      : projects.length > 0 ? groupSessionsByProject(visibleSessions, projects)
      : [{ key: "", projectId: null, name: "On a task", sessions: visibleSessions }];
    return groups.map((group) => ({ ...group, sessions: sortSessions(group.sessions, sortMode) }));
  }, [filter, visibleSessions, projects, sidebarClockMs, sortMode]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectCompanion = (id: string, reveal = true) => {
    if ((creating || queuedPrompt?.kind === "draft") && draft?.companionId !== id) return;
    const companion = companions.find((item) => item.id === id);
    if (!companion || !availableCompanions.some((item) => item.id === id)) return;
    const next = draft?.companionId === id ? draft : draft && selectedId === draft.id
      ? { ...draft, companionId: id, companionName: companion.name } : makeNewSessionDraft(companion);
    setDraft(next);
    setSelectedId(next.id);
    setSelectedCompanionId(id);
    setCreateError(null);
    if (reveal) setMobileListOpen(false);
  };

  // Filter switches and refetches keep the selection (see resolveSelectedId).
  // The first load opens the first session; explicit archive/delete actions
  // can clear a selection without opening the next task. An empty workspace
  // returns to picking a companion, just like its initial state.
  const initialPickDoneRef = useRef(false);
  // Layout effect on purpose: the initial pick must land before the
  // browser paints the just-loaded list, or one frame of the wrong UI
  // (companion roster / "select a task") flashes on every entry.
  useLayoutEffect(() => {
    if (!sessionsQuery.data) return; // never judge a selection against a list that hasn't loaded
    const autoPickFirst = !initialPickDoneRef.current;
    initialPickDoneRef.current = true;
    if (selectedCompanionId !== null) return;
    if (sessions.length === 0 && draft === null) {
      selectCompanion("pip", false);
      return;
    }
    setSelectedId((current) =>
      resolveSelectedId(
        current,
        sessions.map((item) => item.id),
        sessionGroups.flatMap((group) => group.sessions.map((item) => item.id)),
        { draftId: draft?.id ?? null, defer: isNarrow && mobileListOpen, autoPickFirst },
      ),
    );
  }, [isNarrow, mobileListOpen, sessions, sessionGroups, draft, sessionsQuery.data, selectedCompanionId]);

  const detail = detailQuery.data;
  const detailSession = detail?.session ?? selectedSession;
  useEffect(() => {
    if (startingDraft && !creating && (selectedId !== startingDraft.draft.id ||
      (selectedCompanionId === null && detail?.session?.id === startingDraft.draft.id))) {
      setStartingDraft(null);
    }
  }, [startingDraft, creating, selectedId, selectedCompanionId, detail?.session?.id]);
  // The session list can have a fresher companion name just after a handoff.
  const detailAgentName = displayAgentName(selectedSession?.title ?? detailSession?.title ?? "");
  const storedPreference = selectedSession ?? (detailSession?.id === selectedId ? detailSession : null);
  const companionEffort = EFFORT_OPTIONS.find((option) => option.value === selectedCompanion?.effort)?.value;
  const effort = storedPreference?.reasoning_effort ?? companionEffort ?? "high";
  const detailModelId = storedPreference?.model_id ?? "";
  const detailModelAccess = companionModelAccess({ model: { preferredId: detailModelId,
    ifUnavailable: Object.hasOwn(PAID_COMPANION_MODELS, detailModelId) ? "upgrade-required" : "use-catalog-default" } }, accessibleModels);
  const detailModelBlocked = detailModelAccess.status !== "ready";

  const transcriptEvents = useMemo(
    () => detail?.events.filter((event) => event.kind !== "result" && !isLifecycleMessage(event)) ?? [],
    [detail?.events],
  );
  const redundantMessageTools = useMemo(() => redundantSendToolIds(transcriptEvents), [transcriptEvents]);
  const visibleTranscriptEvents = useMemo(() => {
    const events = showReasoning ? transcriptEvents : transcriptEvents.filter((event) => event.kind !== "thinking");
    // The durable To box is the canonical message record. Retain failed or
    // unmatched tools, and show every tool in the raw debugging mode.
    return showRawToolOutput ? events : events.filter((event) => !redundantMessageTools.has(event.id));
  }, [transcriptEvents, showReasoning, showRawToolOutput, redundantMessageTools]);
  const detailEventsCharCount = useMemo(
    () => detail?.events.reduce((sum, event) => sum + event.content.length, 0) ?? 0,
    [detail?.events],
  );
  const estimatedContextTokens = Math.ceil(
    (
      (detailSession?.prompt.length ?? 0) +
      detailEventsCharCount +
      direction.length
    ) / 4,
  );
  const sessionActive = detailSession && detailSession.id !== draft?.id ? !detailSession.archived && isTurnLive(detailSession.status) : false;
  const awaitingPilot = detailSession?.status === "queued" && detailSession.pilot_session_id === null;
  const failedPilotStart = detailSession?.status === "failed" && detailSession.pilot_session_id === null;
  // A workflow's child agents keep running after the turn that launched them
  // ended: keep syncing and ticking while any agents row is still running
  // (bounded, so a row orphaned by a lost backend doesn't poll forever).
  const agentsRunning = useMemo(() => transcriptEvents.some((event) => {
    if (event.kind === "pr_monitor") return parsePrMonitor(event.content)?.status === "monitoring";
    if (event.kind !== "agents" || event.finished_at) return false;
    const row = parseAgentsRow(event.content);
    const started = event.started_at ? Date.parse(event.started_at) : NaN;
    return !!row && agentStatusRunning(row.status) && Number.isFinite(started) && Date.now() - started < 12 * 60 * 60 * 1000;
  }), [transcriptEvents]);
  const liveWork = !detailSession?.archived && (sessionActive || agentsRunning);
  const latestUserEvent = useMemo(() => {
    for (let i = transcriptEvents.length - 1; i >= 0; i--) {
      if (transcriptEvents[i]!.kind === "user") return transcriptEvents[i];
    }
    return undefined;
  }, [transcriptEvents]);
  const workingEvents = useMemo(
    () => transcriptEvents.filter((event) => !redundantMessageTools.has(event.id)),
    [transcriptEvents, redundantMessageTools],
  );
  const promptStartedAt = latestUserEvent?.created_at ?? detailSession?.started_at ?? new Date(nowMs).toISOString();
  const promptStartedMs = new Date(promptStartedAt).getTime();
  const workingLabel = useMemo(() => (
    awaitingPilot ? "Connecting" : getWorkingLabel({
      status: detailSession?.status,
      promptStartedMs,
      events: workingEvents,
      nowMs,
      workspaceRoot: detailSession?.workspace_root,
    })
  ), [awaitingPilot, detailSession?.status, promptStartedMs, workingEvents, nowMs, detailSession?.workspace_root]);
  const runElapsedSeconds = Number.isFinite(promptStartedMs) ? (nowMs - promptStartedMs) / 1000 : 0;
  const sendingElapsedSeconds = pendingSentAtMs > 0 ? Math.max(0, nowMs - pendingSentAtMs) / 1000 : 0;
  // Dimmed echo of the just-submitted prompt until the real event arrives.
  // Quiet tasks remain assigned; only explicitly archived tasks are in Past.
  const sessionPast = detailSession?.archived ?? false;
  const companionBusyElsewhere = !!detailSession && sessionPast && companionAssignedElsewhere(sessions, detailSession.title, detailSession.id);
  const queuedMessageHere =
    queuedPrompt?.kind === "message" && queuedPrompt.sessionId === detailSession?.id ? queuedPrompt.content : null;
  const queuedDraftHere =
    draftSelected && queuedPrompt?.kind === "draft" && queuedPrompt.draft.id === draft?.id ? queuedPrompt.prompt : null;
  const pendingEcho =
    pendingDirection !== null && !pendingHasArrived(transcriptEvents, pendingDirection, pendingEchoAnchor)
      ? pendingDirection
      : null;
  // Waking belongs to the first turn of a task. Sending or admitting another
  // prompt is ordinary work, even while its new user event is still pending.
  const taskStarting = sessionActive && !sendingDirection && pendingEcho === null && (
    awaitingPilot || (workingLabel === "Starting" && transcriptEvents.filter((event) => event.kind === "user").length <= 1)
  );

  useEffect(() => {
    const targets = [...new Set([selectedId, queuedSessionId].filter((id): id is string => id !== null && id !== draft?.id))];
    if (targets.length === 0) return;
    let cancelled = false;

    const sync = async (id: string) => {
      if (syncingSessionsRef.current.has(id)) return;
      syncingSessionsRef.current.add(id);
      try {
        const result = await api.syncPilotEvents({ session_id: id });
        // Recovery can finish a lost turn. Refresh status before releasing a
        // queued prompt so it uses continueSession rather than stale sendInput.
        if (!cancelled && (result.added > 0 || id === queuedSessionId && result.pilot_available === true)) {
          if (id === selectedIdRef.current && id !== queuedSessionId) {
            await queryClient.invalidateQueries({ queryKey: ["code-session", id] }, { cancelRefetch: false });
          } else {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["code-sessions"] }, { cancelRefetch: false }),
              queryClient.invalidateQueries({ queryKey: ["code-session", id] }, { cancelRefetch: false }),
            ]);
          }
        }
        if (!cancelled && result.pilot_available !== null) {
          setPilotSync((current) => current[id] === result.pilot_available ? current : { ...current, [id]: result.pilot_available! });
        }
      } catch {
        // The ordinary query refresh remains available while the app reconnects.
      } finally {
        syncingSessionsRef.current.delete(id);
      }
    };

    const syncAll = () => { for (const id of targets) void sync(id); };
    syncAll();
    const interval = window.setInterval(syncAll, liveWork ? 1000 : 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedId, queuedSessionId, liveWork]);

  // Keep other recent agents' status and output fresh while this UI is open.
  // Otherwise a reply from an unselected agent would never become unread
  // until it was selected. Rotate a bounded batch to avoid flooding the pilot.
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const syncOthers = async () => {
      if (running) return;
      const targets = backgroundTargetsRef.current.filter((item) => item.id !== selectedIdRef.current);
      if (targets.length === 0) return;
      running = true;
      const start = backgroundCursorRef.current % targets.length;
      const batch = Array.from({ length: Math.min(6, targets.length) }, (_, index) => targets[(start + index) % targets.length]!);
      backgroundCursorRef.current += batch.length;
      let changed = false;
      try {
        await Promise.all(batch.map(async (item) => {
          if (syncingSessionsRef.current.has(item.id)) return;
          syncingSessionsRef.current.add(item.id);
          try {
            const result = await api.syncPilotEvents({ session_id: item.id });
            if (result.added > 0 || result.status !== item.status) changed = true;
          } catch { /* Reconnect on the next tick. */ }
          finally { syncingSessionsRef.current.delete(item.id); }
        }));
        if (changed && !cancelled) await queryClient.invalidateQueries({ queryKey: ["code-sessions"] }, { cancelRefetch: false });
      } finally { running = false; }
    };
    void syncOthers();
    const interval = window.setInterval(() => void syncOthers(), 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [queryClient]);

  // Tick every second while a turn runs or a sent prompt is still pending
  // (continuing a finished session isn't "active" until its status flips).
  const promptPending = pendingDirection !== null;
  useEffect(() => {
    if (!liveWork && !promptPending && !startingDraft) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [liveWork, promptPending, detailSession?.id, startingDraft]);

  useEffect(() => {
    // Active/inactive is time-based, so keep the clock fresh enough for
    // sessions to age out of the active filter without any other activity.
    const interval = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const detailSessionId = detailSession?.id ?? null;
  useEffect(() => {
    setMobileSideOpen(false);
  }, [detailSessionId]);
  const hasSidePanel = !!detailSessionId && (sidePanels[detailSessionId]?.tabs.length ?? 0) > 0;
  useEffect(() => {
    const element = detailSplitRef.current;
    if (!element || !hasSidePanel) { setDetailSplitWidth(0); return; }
    const measure = () => setDetailSplitWidth((old) => {
      const width = element.getBoundingClientRect().width;
      return width === old ? old : width;
    });
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [detailSessionId, hasSidePanel, draftSelected, selectedCompanionId]);
  const sidebarBounds = sidebarWidthBounds(viewportWidth);
  const splitWidth = detailSplitWidth || Math.max(1, viewportWidth - paneSizes.sidebarWidth - DIVIDER_WIDTH);
  const chatBounds = chatWidthBounds(splitWidth);
  const chatWidth = paneSizes.chatShare * Math.max(0, splitWidth - DIVIDER_WIDTH);

  // First time a session is opened (or after a reload): its terminal tabs
  // come from the pilot, which keeps the shells.
  const sidePanelLoaded = detailSessionId ? sidePanels[detailSessionId]?.loaded === true : true;
  useEffect(() => {
    if (!detailSessionId || sidePanelLoaded) return;
    let cancelled = false;
    void api.listSessionTerminals({ session_id: detailSessionId }).then((res) => {
      if (cancelled || !res.ok) return;
      setSidePanels((current) => {
        const existing = current[detailSessionId];
        if (existing?.loaded) return current;
        const fromPilot: SideTab[] = res.terminals.map((t) => ({ key: t.terminal_id, kind: "terminal", terminalId: t.terminal_id, number: t.number }));
        // Keep tabs opened locally before the list arrived.
        const local = (existing?.tabs ?? []).filter((tab) => tab.kind !== "terminal" || !fromPilot.some((p) => p.kind === "terminal" && p.terminalId !== null && p.terminalId === tab.terminalId));
        const tabs = [...fromPilot, ...local];
        return { ...current, [detailSessionId]: { tabs, activeKey: existing?.activeKey ?? tabs[0]?.key ?? null, loaded: true } };
      });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [detailSessionId, sidePanelLoaded]);
  const markVisibleRead = () => {
    const currentSession = detail?.session;
    const body = terminalBodyRef.current;
    if (!currentSession || currentSession.id !== selectedId || !body || document.hidden) return;
    const id = currentSession.id;
    const revision = currentSession.output_revision;
    if (revision <= Math.max(currentSession.seen_output_revision, requestedSeenRef.current.get(id) ?? 0)) return;
    if (!transcriptAtBottom(body)) return;
    requestedSeenRef.current.set(id, revision);
    void api.markAgentSeen({ id, output_revision: revision }).then((result) => {
      if (!result.ok) {
        if (requestedSeenRef.current.get(id) === revision) requestedSeenRef.current.delete(id);
        return;
      }
      const seen = result.seen_output_revision;
      if (seen < revision) requestedSeenRef.current.set(id, seen);
      queryClient.setQueryData<typeof sessionsQuery.data>(["code-sessions"], (old) =>
        old
          ? {
              ...old,
              sessions: old.sessions.map((item) =>
                item.id === id && item.seen_output_revision < seen
                  ? { ...item, seen_output_revision: seen }
                  : item,
              ),
            }
          : old,
      );
      queryClient.setQueryData<typeof detailQuery.data>(["code-session", id], (old) =>
        old?.session && old.session.seen_output_revision < seen
          ? { ...old, session: { ...old.session, seen_output_revision: seen } }
          : old,
      );
    }).catch(() => {
      if (requestedSeenRef.current.get(id) === revision) requestedSeenRef.current.delete(id);
    });
  };

  useLayoutEffect(() => {
    // Opening a session always lands at the bottom once its transcript loads,
    // active or not. Guarded per session so later refetches don't fight the
    // user's own scrolling; the live-follow effect below owns active sessions.
    // The guard is cleared on selection change, so coming back snaps again.
    if (selectedCompanionId !== null) { snappedSessionRef.current = null; return; }
    if (detailSessionId === null) return;
    if (!shouldSnapToBottom(snappedSessionRef.current, detailSessionId, transcriptEvents.length)) return;
    snappedSessionRef.current = detailSessionId;
    const terminalBody = terminalBodyRef.current;
    if (terminalBody) {
      followTranscriptRef.current = true;
      terminalBody.scrollTop = terminalBody.scrollHeight;
      markVisibleRead();
    }
  }, [detailSessionId, transcriptEvents.length, selectedCompanionId]);

  useLayoutEffect(() => {
    // Follow before paint, including the final response after a turn becomes
    // idle and updates to existing reasoning/tool rows. Only scrolling away
    // from the bottom pauses following; submitting a new prompt resumes it.
    if (!shouldFollowTranscript(followTranscriptRef.current, transcriptEvents.length, pendingEcho !== null)) return;
    const terminalBody = terminalBodyRef.current;
    if (terminalBody) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
      markVisibleRead();
    }
  }, [detailSessionId, transcriptEvents, pendingEcho, showReasoning, showRawToolOutput]);

  const hasOutputStream = visibleTranscriptEvents.length > 0;
  useLayoutEffect(() => {
    const body = terminalBodyRef.current;
    if (!body) { setShowScrollToBottom(false); return; }
    // Formatting and images can settle after React renders. The viewport
    // also resizes when the composer grows, the keyboard opens, or panes move.
    // Keep the bottom pinned through those changes without moving a reader
    // who deliberately scrolled up.
    const measure = () => {
      if (followTranscriptRef.current) {
        body.scrollTop = body.scrollHeight;
        setShowScrollToBottom(false);
      } else {
        setShowScrollToBottom(!transcriptAtBottom(body));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body, { box: "border-box" });
    if (transcriptContentRef.current) observer.observe(transcriptContentRef.current, { box: "border-box" });
    return () => observer.disconnect();
  }, [detailSessionId, detailQuery.isPending, hasOutputStream, pendingEcho !== null, queuedMessageHere !== null, selectedCompanionId]);

  useEffect(() => {
    // An offline prompt is visible before any real transcript event arrives.
    // Snap once when it is queued (or when returning to its agent), even if
    // the agent is idle or the session list can no longer be polled. Do not
    // keep snapping while the user reads older output during an outage.
    if (queuedMessageHere === null && queuedDraftHere === null) return;
    const frame = requestAnimationFrame(() => {
      const body = terminalBodyRef.current;
      if (body) {
        body.scrollTop = body.scrollHeight;
        markVisibleRead();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [queuedMessageHere, queuedDraftHere, detailSession?.id, draft?.id]);

  useEffect(() => {
    // A short transcript may already fit without scrolling. Tool rows also
    // update in place, so their revision can change without a new row.
    const frame = requestAnimationFrame(markVisibleRead);
    return () => cancelAnimationFrame(frame);
  }, [detailSessionId, detail?.session?.output_revision, detail?.session?.seen_output_revision]);
  useEffect(() => {
    document.addEventListener("visibilitychange", markVisibleRead);
    return () => document.removeEventListener("visibilitychange", markVisibleRead);
  }, [detailSessionId, detail?.session?.output_revision, detail?.session?.seen_output_revision]);

  const prevComposerMeasureRef = useRef<{
    input: HTMLTextAreaElement | null;
    direction: string;
    viewportWidth: number;
    sidebarWidth: number;
    chatShare: number;
    hasSidePanel: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    // The first-prompt draft has its own textarea; sizing only the existing
    // agent's composer left draft messages clipped after the first line.
    const input = draftSelected ? draftInputRef.current : takeoverInputRef.current;
    if (!input) return;
    const prev = prevComposerMeasureRef.current;
    const sameGeometry =
      prev !== null &&
      prev.input === input &&
      prev.viewportWidth === viewportWidth &&
      prev.sidebarWidth === paneSizes.sidebarWidth &&
      prev.chatShare === paneSizes.chatShare &&
      prev.hasSidePanel === hasSidePanel;
    const prevDirection = sameGeometry ? prev.direction : "";
    prevComposerMeasureRef.current = {
      input,
      direction,
      viewportWidth,
      sidebarWidth: paneSizes.sidebarWidth,
      chatShare: paneSizes.chatShare,
      hasSidePanel,
    };
    const currentHeight = input.style.height || `${COMPOSER_MIN_HEIGHT}px`;
    const atMinHeight = currentHeight === `${COMPOSER_MIN_HEIGHT}px`;
    const onlyAppendedSingleLine =
      sameGeometry &&
      direction.length >= prevDirection.length &&
      !direction.slice(prevDirection.length).includes("\n");
    // While fixed at a pixel height with overflow-y: hidden, <textarea> is an
    // isolated Blink relayout boundary: reading scrollHeight/clientHeight only
    // lays out the 2 nodes inside the textarea (~0.05ms). Setting height="auto"
    // inside resizeComposerTextarea destroys that boundary and shifts the flex
    // container by 12px twice, forcing two 60ms full-document layouts across
    // all 44,500 transcript objects per keystroke.
    if (sameGeometry && currentHeight !== "") {
      if (atMinHeight && (direction.length === 0 || input.scrollHeight <= COMPOSER_MIN_HEIGHT)) return;
      if (onlyAppendedSingleLine && input.scrollHeight <= input.clientHeight) return;
    }
    // Growing the composer shrinks the transcript viewport. If the reader
    // was following the bottom, re-pin after the resize layout settles —
    // otherwise the last lines slide under the composer and a spurious
    // "Scroll to bottom" appears even though the user never scrolled.
    const body = terminalBodyRef.current;
    const wasFollowing = body !== null && followTranscriptRef.current && transcriptAtBottom(body);
    resizeComposerTextarea(input);
    if (!body || !wasFollowing || input.style.height === currentHeight) return;
    const frame = requestAnimationFrame(() => {
      // Layout-induced scroll events from the shrink itself may have
      // cleared the follow flag in between; the pre-resize snapshot is
      // the authority here, not the flag's current value.
      followTranscriptRef.current = true;
      body.scrollTop = body.scrollHeight;
      setShowScrollToBottom(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [direction, selectedId, draftSelected, viewportWidth, paneSizes.sidebarWidth, paneSizes.chatShare, hasSidePanel, selectedCompanionId]);

  useEffect(() => {
    // Swap the echo for the real event once it shows up in the transcript.
    // Anchored past older events so a repeated prompt is not cleared by an
    // identical message from earlier in the conversation.
    if (pendingDirection === null) return;
    if (pendingHasArrived(transcriptEvents, pendingDirection, pendingEchoAnchor)) {
      setPendingDirection(null);
    }
  }, [pendingDirection, pendingEchoAnchor, transcriptEvents]);

  const toggleVoiceInput = () => {
    if (listening) {
      voiceRecognitionRef.current?.stop();
      return;
    }

    const speechWindow = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceError("Voice input isn’t available in this browser.");
      return;
    }

    const recognition = new Recognition();
    voiceRecognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim() ?? "";
      if (transcript) {
        setPendingDirection(null);
        setDirection((current) => current ? `${current} ${transcript}` : transcript);
      }
      setVoiceError(null);
    };
    recognition.onerror = () => {
      setVoiceError("Voice input couldn’t start. Check microphone access and try again.");
      setListening(false);
    };
    recognition.onend = () => {
      setListening(false);
      voiceRecognitionRef.current = null;
    };
    setVoiceError(null);
    setListening(true);
    recognition.start();
  };

  // Sends one message to a session. Continue vs. live input is decided from
  // the session's current status, so a queued message sent later is right.
  const deliverMessage = async (message: QueuedMessage, refreshSession = false): Promise<SendResult> => {
    try {
      const session = refreshSession
        ? (await api.getSession({ id: message.sessionId, event_limit: 1 })).session
        : detailSession?.id === message.sessionId
          ? detailSession
          : sessions.find((item) => item.id === message.sessionId);
      const continuing = session ? !isTurnLive(session.status) : true;
      const resuming = session ? !isSessionActive(session, Date.now()) : false;
      const args = {
        session_id: message.sessionId,
        content: message.content,
      };
      const response = continuing
        ? await api.continueSession({ ...args, resume: true })
        : await api.sendInput(args);
      if (!response.ok) {
        return { ok: false, error: response.error ?? "Direction could not be sent.", network: response.retryable === true, pilotUnavailable: response.retryable === true };
      }
      if (resuming) {
        // Show it as active right away (unarchived, running, just updated) and
        // switch to the Active list in the same render, so auto-selection
        // never sees the session missing from the visible list.
        const now = new Date().toISOString();
        queryClient.setQueryData<typeof sessionsQuery.data>(["code-sessions"], (old) =>
          old
            ? {
                ...old,
                sessions: old.sessions.map((item) =>
                  item.id === message.sessionId
                    ? { ...item, archived: false, archived_at: null, status: "running" as const, updated_at: now }
                    : item,
                ),
              }
            : old,
        );
        if (selectedIdRef.current === message.sessionId) setFilter("active");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["code-sessions"] }, { cancelRefetch: false }),
        queryClient.invalidateQueries({ queryKey: ["code-session", message.sessionId] }, { cancelRefetch: false }),
      ]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: "Direction could not be sent. Try again.", network: isNetworkFailure(error) };
    }
  };

  const submitTakeover = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = direction.trim();
    // Archived sessions included: sending is how they're resumed.
    if (!detailSession || handoffBusy || content.length === 0) return;
    if (detailModelBlocked) {
      setTakeoverError("Check model access or pick another companion before sending a message.");
      return;
    }
    if (companionBusyElsewhere) {
      setTakeoverError("Pick another companion before resuming this task.");
      return;
    }
    const message: QueuedMessage = { kind: "message", sessionId: detailSession.id, content };
    const decision = decideSubmit(promptConnectionLost, queuedPrompt !== null);
    if (decision === "queue-full") {
      setTakeoverError(QUEUE_FULL_MESSAGE);
      return;
    }
    followTranscriptRef.current = true;
    sentPromptsRef.current.push(content);
    promptHistoryStateRef.current = INITIAL_PROMPT_HISTORY_STATE;
    setDirection("");
    setTakeoverError(null);
    setTakeoverStatus(null);
    if (decision === "queue") {
      setQueuedPrompt(message);
      return;
    }
    // Echo immediately in the transcript (dimmed); cleared below on failure,
    // or when the prompt lands in the transcript for real on success.
    // Anchor past current events so an identical older message cannot
    // clear this echo before the real event arrives.
    setPendingEchoAnchor(transcriptEvents.length);
    setPendingDirection(content);
    setPendingSentAtMs(Date.now());
    setSendingDirection(true);
    const result = await deliverMessage(message);
    setSendingDirection(false);
    if (result.ok) return;
    setPendingDirection(null);
    if (result.network && queuedPrompt === null) {
      // The request never got an answer: hold it and resend on reconnect.
      if (result.pilotUnavailable) setPilotSync((current) => ({ ...current, [message.sessionId]: false }));
      else setSendFailedAt(Date.now());
      setQueuedPrompt(message);
      return;
    }
    setTakeoverError(result.error);
    // Never lose what was typed.
    setDirection((current) => current || content);
  };

  const handOffCompanion = async (companionId: string) => {
    if (!detailSession || handoffBusy || liveWork || sendingDirection || pendingDirection !== null || queuedPrompt !== null || connectionLost) return;
    const replacement = companions.find((item) => item.id === companionId);
    if (!replacement || companionModelAccess(replacement, accessibleModels).status !== "ready") return;
    const id = detailSession.id;
    setHandoffBusy(true);
    setTakeoverError(null);
    setTakeoverStatus(null);
    try {
      const result = await api.assignAgent({ id, agent_id: companionId });
      if (!result.ok) {
        if (selectedIdRef.current === id) setTakeoverError(result.error ?? "Could not hand over this task.");
        return;
      }
      await Promise.all([sessionsQuery.refetch(), queryClient.invalidateQueries({ queryKey: ["code-session", id] })]);
    } catch {
      if (selectedIdRef.current === id) setTakeoverError("Could not reach the app. Refresh to check who has this task.");
    } finally {
      setHandoffBusy(false);
    }
  };

  const retryFailedStart = async () => {
    if (!detailSession || retryingStart) return;
    setRetryingStart(true);
    setStartRetryError(null);
    try {
      const result = await api.retryAgentStart({ id: detailSession.id });
      if (!result.ok) {
        setStartRetryError(result.error ?? "Companion could not be retried.");
        return;
      }
      await Promise.all([sessionsQuery.refetch(), detailQuery.refetch()]);
    } catch {
      setStartRetryError("Could not reach the app. Try again.");
    } finally {
      setRetryingStart(false);
    }
  };

  const interruptTurn = async () => {
    if (!detailSession || interrupting) return;
    setInterrupting(true);
    setTakeoverError(null);
    try {
      const response = await api.interruptTurn({ session_id: detailSession.id });
      if (!response.ok) {
        setTakeoverError(response.error ?? "Turn could not be stopped.");
      }
    } catch {
      setTakeoverError("Turn could not be stopped. Try again.");
    } finally {
      setInterrupting(false);
    }
  };

  // Creates the session for a draft. `fromComposer` is false for a queued
  // send on reconnect: then the composer may hold newer text to keep.
  const createFromDraft = async (queued: QueuedDraft, fromComposer: boolean): Promise<SendResult> => {
    // Show the conversation before waiting for pilot admission or refetches.
    // Keep the draft intact so a rejected start returns to the card unchanged.
    setStartingDraft(queued);
    setPendingSentAtMs(Date.now());
    try {
      const response = await api.createSession({
        session_id: queued.draft.id,
        title: queued.draft.companionName,
        prompt: queued.prompt,
        workspaceRoot: queued.workspacePath,
        project_id: queued.draft.projectKey === "" ? null : queued.draft.projectKey,
        repo: queued.draft.repoSlug,
      });
      if (!response.ok || !response.id) {
        setStartingDraft(null);
        return { ok: false, error: response.error ?? "Companion could not be created.", network: response.retryable === true, pilotUnavailable: response.retryable === true };
      }
      const createdId = response.id;
      const nowIso = new Date().toISOString();
      const companion = companions.find((item) => item.id === queued.draft.companionId);
      const initialStatus = response.start_status === "waking" ? ("running" as const) : ("queued" as const);
      const seeded: Session = {
        id: createdId,
        title: queued.draft.companionName,
        prompt: queued.prompt,
        workspace_root: queued.workspacePath,
        repo_slug: queued.draft.repoSlug,
        pilot_session_id: response.start_status === "waking" ? createdId : null,
        model_id: companion?.model.preferredId ?? "",
        reasoning_effort: (companion?.effort ?? "medium") as Session["reasoning_effort"],
        status: initialStatus,
        summary: null,
        session_summary: null,
        started_at: nowIso,
        updated_at: nowIso,
        finished_at: null,
        archived: false,
        archived_at: null,
        restored_at: null,
        needs_you: false,
        output_revision: 0,
        seen_output_revision: 0,
        output_count: 1,
        latest_output: null,
        project_id: queued.draft.projectKey === "" ? null : queued.draft.projectKey,
      };
      // Seed the new session in both the list and detail caches immediately so
      // selecting it transitions directly from startingDraft into the live
      // conversation without flashing a "Loading output…" screen.
      queryClient.setQueryData<typeof sessionsQuery.data>(["code-sessions"], (old) => {
        if (!old) return old;
        if (old.sessions.some((item) => item.id === createdId)) {
          return { ...old, sessions: old.sessions.map((item) => (item.id === createdId ? seeded : item)) };
        }
        return { ...old, sessions: [seeded, ...old.sessions] };
      });
      queryClient.setQueryData<ApiResponse<typeof api, "getSession">>(["code-session", createdId], (old) =>
        old && old.events.length > 1
          ? old
          : {
              session: seeded,
              events: [
                {
                  id: 0,
                  kind: "user",
                  content: queued.prompt,
                  created_at: nowIso,
                  system_is_error: false,
                  started_at: null,
                  finished_at: null,
                  tool_details: null,
                },
              ],
            },
      );
      queryClient.setQueryData(["owned-artifacts", createdId], { ok: true, files: [] });
      setSidePanels((current) => ({
        ...current,
        [createdId]: current[createdId] ?? { tabs: [], activeKey: null, loaded: true },
      }));
      void queryClient.invalidateQueries({ queryKey: ["code-sessions"] }, { cancelRefetch: false });
      const viewing = selectedIdRef.current === queued.draft.id;
      setDraft((current) => (current?.id === queued.draft.id ? null : current));
      if (viewing) {
        if (fromComposer) setDirection("");
        setFilter("active");
        setMobileListOpen(false);
        setSelectedCompanionId(null);
        setSelectedId(createdId);
      }
      setStartingDraft(null);
      return { ok: true };
    } catch (error) {
      setStartingDraft(null);
      return { ok: false, error: "Companion could not be created. Try again.", network: isNetworkFailure(error) };
    }
  };

  const submitDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || creating || firstMessageSendingRef.current || selectedModelBlocked) return;
    if (!availableCompanions.some((companion) => companion.id === draft.companionId)) {
      setCreateError("This companion is already on a task. Pick another companion.");
      return;
    }
    const prompt = direction.trim();
    if (!prompt) return;
    const workspace = resolveWorkspaceRoot(draft.workspaceRoot);
    if (!workspace.ok) {
      setCreateError(workspace.error);
      return;
    }
    const queued: QueuedDraft = { kind: "draft", draft, workspacePath: workspace.path, prompt };
    const decision = decideSubmit(promptConnectionLost, queuedPrompt !== null);
    if (decision === "queue-full") {
      setCreateError(QUEUE_FULL_MESSAGE);
      return;
    }
    setCreateError(null);
    sentPromptsRef.current.push(prompt);
    promptHistoryStateRef.current = INITIAL_PROMPT_HISTORY_STATE;
    if (decision === "queue") {
      setQueuedPrompt(queued);
      setDirection("");
      return;
    }
    firstMessageSendingRef.current = true;
    setCreating(true);
    const result = await createFromDraft(queued, true);
    firstMessageSendingRef.current = false;
    setCreating(false);
    if (result.ok) return;
    if (result.network && queuedPrompt === null) {
      setSendFailedAt(Date.now());
      setQueuedPrompt(queued);
      setDirection("");
      return;
    }
    setCreateError(result.error);
  };

  // Keep the queue until delivery succeeds. A pilot rejection must not
  // discard it or immediately retry just because the app DB is reachable.
  const flushingRef = useRef(false);
  useEffect(() => {
    if (connectionLost || queuedPilotUnavailable || queuedPrompt === null || flushingRef.current) return;
    const queued = queuedPrompt;
    flushingRef.current = true;
    void (async () => {
      try {
        if (queued.kind === "message") {
          const viewing = selectedIdRef.current === queued.sessionId;
          if (viewing) {
            setPendingEchoAnchor(transcriptEvents.length);
            setPendingDirection(queued.content);
            setPendingSentAtMs(Date.now());
            setSendingDirection(true);
          }
          const result = await deliverMessage(queued, true);
          if (viewing) setSendingDirection(false);
          if (result.ok) {
            setQueuedPrompt((current) => current === queued ? null : current);
            return;
          }
          if (viewing) setPendingDirection(null);
          if (result.network) {
            if (result.pilotUnavailable) setPilotSync((current) => ({ ...current, [queued.sessionId]: false }));
            else setSendFailedAt(Date.now());
            return;
          }
          setQueuedPrompt((current) => current === queued ? null : current);
          if (selectedIdRef.current === queued.sessionId) {
            setTakeoverError(result.error);
            setDirection((current) => current || queued.content);
          }
        } else {
          setCreating(true);
          const result = await createFromDraft(queued, false);
          setCreating(false);
          if (result.ok) {
            setQueuedPrompt((current) => current === queued ? null : current);
            return;
          }
          if (result.network) {
            setSendFailedAt(Date.now());
            return;
          }
          setQueuedPrompt((current) => current === queued ? null : current);
          if (selectedIdRef.current === queued.draft.id) {
            setCreateError(result.error);
            setDirection((current) => current || queued.prompt);
          }
        }
      } finally {
        flushingRef.current = false;
      }
    })();
  }, [connectionLost, queuedPilotUnavailable, queuedPrompt]);

  // A queued first message belongs to its draft: discarding the draft drops it.
  useEffect(() => {
    if (queuedPrompt?.kind === "draft" && draft?.id !== queuedPrompt.draft.id) setQueuedPrompt(null);
  }, [draft?.id, queuedPrompt]);

  const cancelQueuedPrompt = () => {
    if (!queuedPrompt || flushingRef.current) return;
    const text = queuedPrompt.kind === "message" ? queuedPrompt.content : queuedPrompt.prompt;
    setQueuedPrompt(null);
    setDirection((current) => current || text);
  };

  // Both UI rename controls edit the same optional session summary as Muse.
  const updateSessionSummary = async (sessionId: string, value: string): Promise<string | null> => {
    const summary = value.replace(/\s+/g, " ").trim() || null;
    if (summary && summary.length > 240) return "Keep the task summary to 240 characters or less.";
    setRenameBusy(true);
    try {
      const response = await api.setSessionSummary({ id: sessionId, summary });
      if (!response.ok) return response.error ?? "Task could not be renamed.";
      await Promise.all([sessionsQuery.refetch(), detailQuery.refetch()]);
      return null;
    } catch {
      return "Task could not be renamed. Try again.";
    } finally {
      setRenameBusy(false);
    }
  };

  const submitRename = async (sessionId: string) => {
    setRenameError(null);
    const failure = await updateSessionSummary(sessionId, renameValue);
    if (failure) setRenameError(failure);
    else setRenamingId(null);
  };

  const submitUserInputAnswer = async (
    userInputId: string,
    selections: Array<{ questionId: string; selectedLabels?: string[]; freeText?: string }>,
  ) => {
    if (!detailSession) return;
    setInputBusyId(userInputId);
    setInputError(null);
    try {
      const response = await api.answerUserInput({
        id: detailSession.id,
        userInputId,
        answers: selections,
      });
      if (!response.ok) {
        setInputError({ userInputId, error: response.error ?? "Answer could not be sent." });
        return;
      }
      await Promise.all([pendingInputsQuery.refetch(), sessionsQuery.refetch(), detailQuery.refetch()]);
    } catch {
      setInputError({ userInputId, error: "Answer could not be sent. Try again." });
    } finally {
      setInputBusyId(null);
    }
  };

  const skipUserInput = async (userInputId: string) => {
    if (!detailSession) return;
    setInputBusyId(userInputId);
    setInputError(null);
    try {
      const response = await api.cancelUserInput({ id: detailSession.id, userInputId });
      if (!response.ok) {
        setInputError({ userInputId, error: response.error ?? "Answer could not be skipped." });
        return;
      }
      await Promise.all([pendingInputsQuery.refetch(), sessionsQuery.refetch(), detailQuery.refetch()]);
    } catch {
      setInputError({ userInputId, error: "Answer could not be skipped. Try again." });
    } finally {
      setInputBusyId(null);
    }
  };

  const changeArchiveState = async (sessionId: string, archived: boolean) => {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const response = await api.setSessionArchived({ id: sessionId, archived });
      if (!response.ok) {
        setArchiveError(response.error ?? "Task could not be updated.");
        return;
      }
      if (archived) {
        forgetSidePanel(sessionId); // archiving ended its shells
        // Stay on this list so other agents can be archived in sequence.
        // Only close the transcript if this is the agent the user is viewing.
        setSelectedId((current) => current === sessionId ? null : current);
      } else {
        setFilter("active"); // a restored agent returns to the Active list
      }
      await sessionsQuery.refetch();
    } catch {
      setArchiveError("Task could not be updated. Try again.");
    } finally {
      setArchiveBusy(false);
    }
  };

  const askToDelete = (session: Session) => {
    setDeleteError(null);
    const title = sessionTaskTitle(session);
    setDeleteTarget({ id: session.id, title: title.length > 200 ? `${title.slice(0, 200)}…` : title });
  };

  const deleteSessionPermanently = async (sessionId: string) => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const response = await api.deleteSession({ id: sessionId });
      if (!response.ok) {
        // Shown in the dialog, which stays open so the user can retry or cancel.
        setDeleteError(response.error ?? "Task could not be deleted.");
        return;
      }
      setDeleteTarget(null);
      forgetSidePanel(sessionId); // deleting ended its shells
      const refreshed = await sessionsQuery.refetch();
      if (refreshed.data && !refreshed.data.sessions.some((session) => session.archived)) {
        setFilter("active");
        setSessionQuery("");
        if (refreshed.data.sessions.length === 0) {
          setMoreAvailableExpanded(false);
          setMobileListOpen(true);
        }
      }
      // If it was open, the selection is cleared (not moved to another session).
    } catch {
      setDeleteError("Task could not be deleted. Try again.");
    } finally {
      setDeleteBusy(false);
    }
  };

  // View preferences remain available before an agent exists (including
  // drafts); the session-specific menu adds rename/archive/restore/delete.
  const viewMenuActions: SessionMenuAction[] = [
    {
      key: "reasoning",
      label: "Show reasoning",
      description: "Display available reasoning summaries",
      checked: showReasoning,
      onActivate: () => setShowReasoning((visible) => !visible),
    },
    {
      key: "expand-tools",
      label: "Expand tools by default",
      description: "Show tool previews automatically",
      checked: expandTools,
      onActivate: () => setExpandTools((value) => !value),
    },
    {
      key: "working-details",
      label: "Show activity details",
      description: "Show activity and elapsed time below the transcript",
      checked: showWorkingDetails,
      onActivate: () => setShowWorkingDetails((value) => !value),
    },
  ];
  // The sidebar's rename/archive buttons are hover-only; the transcript's
  // session menu carries the same actions so touch devices can reach them.
  const sessionMenuActions = (session: Session): SessionMenuAction[] => {
    const live = isTurnLive(session.status);
    // Past sessions mirror their sidebar row: restore (if archived) + delete.
    if (session.archived) {
      const actions: SessionMenuAction[] = [];
      if (session.archived) {
        actions.push({
          key: "restore",
          label: "Restore task",
          description: companionAssignedElsewhere(sessions, session.title, session.id) ? "Pick an available companion in the prompt first" : "Move it back to Active",
          disabled: archiveBusy || companionAssignedElsewhere(sessions, session.title, session.id),
          onActivate: () => void changeArchiveState(session.id, false),
        });
      }
      actions.push({
        key: "delete",
        label: "Delete task",
        description: live ? "Available once the companion stops running" : "Permanently delete this task and its transcript",
        disabled: live || deleteBusy,
        onActivate: () => askToDelete(session),
      });
      return [...viewMenuActions, ...actions];
    }
    return [
      ...viewMenuActions,
      {
        key: "rename",
        label: "Change task summary",
        description: "Edit the short description of this task",
        disabled: renameBusy,
        onActivate: () => setTextPrompt({
          title: "Change task summary",
          label: "Task summary",
          initialValue: sessionTaskTitle(session).slice(0, 240),
          confirmLabel: "Save",
          maxLength: 240,
          allowEmpty: true,
          onSubmit: (value) => (value.trim() === session.session_summary ? null : updateSessionSummary(session.id, value)),
        }),
      },
      session.archived
        ? {
            key: "restore",
            label: "Restore task",
            description: "Move it back to Active",
            disabled: archiveBusy,
            onActivate: () => void changeArchiveState(session.id, false),
          }
        : {
            key: "archive",
            label: "Archive task",
            description: live ? "Available once the companion stops running" : "Move it to Past; you can restore it",
            disabled: live || archiveBusy,
            onActivate: () => void changeArchiveState(session.id, true),
          },
    ];
  };

  const updateSidePanel = (sessionId: string, update: (state: SidePanelState & { loaded: boolean }) => SidePanelState & { loaded: boolean }) => {
    setSidePanels((current) => ({
      ...current,
      [sessionId]: update(current[sessionId] ?? { tabs: [], activeKey: null, loaded: false }),
    }));
  };

  // The header's terminal button: always a new terminal, as a new tab.
  const openTerminalTab = (sessionId: string) => {
    const tab: SideTab = { key: crypto.randomUUID(), kind: "terminal", terminalId: null, number: null };
    updateSidePanel(sessionId, (state) => ({ ...state, tabs: [...state.tabs, tab], activeKey: tab.key }));
    if (isNarrow) setMobileSideOpen(true);
  };
  const openFileTab = useCallback((sessionId: string, path: string) => {
    updateSidePanel(sessionId, (state) => {
      const existing = state.tabs.find((tab) => tab.kind === "file" && tab.path === path);
      if (existing) return { ...state, activeKey: existing.key };
      const tab: SideTab = { key: crypto.randomUUID(), kind: "file", path };
      return { ...state, tabs: [...state.tabs, tab], activeKey: tab.key };
    });
    if (isNarrow) setMobileSideOpen(true);
  }, [isNarrow]);
  // Stable per-detail-session file opener so memoized tool rows keep an
  // identical onOpenFile prop across renders.
  const detailSessionIdForFiles = detailSession?.id ?? null;
  const openFileTabForDetail = useCallback((path: string) => {
    if (detailSessionIdForFiles) openFileTab(detailSessionIdForFiles, path);
  }, [openFileTab, detailSessionIdForFiles]);
  const detailWorkspaceRoot = detailSession?.workspace_root ?? "";
  const assistantAvatarUrl = assistantIdentityQuery.data?.avatar_data_url ?? null;
  const sessionsPeerKey = useMemo(
    () => sessions.map((item) => `${item.id}:${item.pilot_session_id ?? ""}:${item.title}`).join("|"),
    [sessions],
  );
  const sessionsForMessages = useMemo(() => sessions, [sessionsPeerKey]);
  // Only running workflow rows need a 1s clock; stdout message timestamps
  // only change across 24h/48h age boundaries.
  const stdoutTimeSignature = useMemo(() => {
    let sig = "";
    for (const event of visibleTranscriptEvents) {
      if (event.kind === "stdout") sig += `${event.id}:${formatMessageTime(event.created_at, minuteClockMs)}|`;
    }
    return sig;
  }, [visibleTranscriptEvents, minuteClockMs]);
  const transcriptClockMs = useMemo(
    () => (agentsRunning ? nowMs : minuteClockMs),
    [agentsRunning ? nowMs : stdoutTimeSignature],
  );
  const renderedRowCacheRef = useRef<{
    contextKey: unknown[];
    rows: Map<
      number,
      {
        content: string;
        finishedAt: string | null;
        toolDetails: TranscriptEvent["tool_details"];
        rowTime: string;
        rowClockMs: number;
        element: ReactNode;
      }
    >;
  } | null>(null);
  const renderedTranscriptEvents = useMemo(() => {
    if (!detailSessionIdForFiles) return [];
    const nowMs = transcriptClockMs;
    const sessions = sessionsForMessages;
    const contextKey = [
      detailSessionIdForFiles,
      detailWorkspaceRoot,
      sessions,
      assistantAvatarUrl,
      expandTools,
      showRawToolOutput,
      openFileTabForDetail,
    ];
    let cache = renderedRowCacheRef.current;
    if (
      !cache ||
      cache.contextKey.length !== contextKey.length ||
      cache.contextKey.some((val, idx) => !Object.is(val, contextKey[idx]))
    ) {
      cache = { contextKey, rows: new Map() };
      renderedRowCacheRef.current = cache;
    }
    const { rows } = cache;
    return visibleTranscriptEvents.map((event) => {
      const rowTime = event.kind === "stdout" ? formatMessageTime(event.created_at, nowMs) : "";
      const runningAgents = event.kind === "agents" && !event.finished_at;
      const cached = rows.get(event.id);
      if (
        cached !== undefined &&
        cached.content === event.content &&
        cached.finishedAt === event.finished_at &&
        cached.toolDetails?.status === event.tool_details?.status &&
        cached.toolDetails?.output === event.tool_details?.output &&
        cached.toolDetails?.failureReason === event.tool_details?.failureReason &&
        cached.rowTime === rowTime &&
        (!runningAgents || cached.rowClockMs === nowMs)
      ) {
        return cached.element;
      }
      const rowClockMs = runningAgents || event.kind === "stdout" ? nowMs : 0;
      const element = event.kind === "message" ? (
        <MessageEvent key={event.id} content={event.content} agents={sessions}
          assistantAvatar={assistantAvatarUrl} />
      ) : (
        <TranscriptEventRow
          key={event.id}
          event={event}
          detailSessionId={detailSessionIdForFiles}
          detailWorkspaceRoot={detailWorkspaceRoot}
          nowMs={rowClockMs}
          expandTools={expandTools}
          showRawToolOutput={showRawToolOutput}
          openFileTabForDetail={openFileTabForDetail}
        />
      );
      rows.set(event.id, {
        content: event.content,
        finishedAt: event.finished_at,
        toolDetails: event.tool_details,
        rowTime,
        rowClockMs,
        element,
      });
      return element;
    });
  }, [
    detailSessionIdForFiles,
    detailWorkspaceRoot,
    visibleTranscriptEvents,
    transcriptClockMs,
    sessionsForMessages,
    assistantAvatarUrl,
    expandTools,
    showRawToolOutput,
    openFileTabForDetail,
  ]);
  // Closing a tab ends what it shows: for a terminal, its shell.
  const closeSideTab = (sessionId: string, tab: SideTab) => {
    if (tab.kind === "terminal" && tab.terminalId) void api.closeTerminal({ terminal_id: tab.terminalId }).catch(() => undefined);
    updateSidePanel(sessionId, (state) => {
      const index = state.tabs.findIndex((item) => item.key === tab.key);
      const tabs = state.tabs.filter((item) => item.key !== tab.key);
      const activeKey = state.activeKey === tab.key ? (tabs[index] ?? tabs[index - 1])?.key ?? null : state.activeKey;
      return { ...state, tabs, activeKey };
    });
  };

  const forgetSidePanel = (sessionId: string) => {
    setSidePanels((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  };


  const firstMessageComposer = (startingDraft?.draft.id === selectedId || selectedCompanion !== null) ? (
    <form ref={draftFormRef} className="terminal-prompt companion-first-prompt" onSubmit={submitDraft}>
      {queuedPrompt?.kind === "draft" && queuedPrompt.draft.id === draft?.id && <QueuedEcho text={queuedPrompt.prompt} onCancel={cancelQueuedPrompt} sending={flushingRef.current} />}
      <RepoPicker
        repos={reposQuery.data?.repos ?? []}
        githubEnabled={reposQuery.data?.github_enabled ?? true}
        loading={reposQuery.isFetching}
        selected={startingDraft?.draft.id === selectedId ? startingDraft.draft.repoSlug : draft?.repoSlug ?? null}
        disabled={creating || startingDraft?.draft.id === selectedId || queuedPrompt?.kind === "draft"}
        mode={startingDraft?.draft.id === selectedId ? "manage" : "pick"}
        cloneProgress={startingDraft?.draft.id === selectedId ? (cloneProgressQuery.data ?? null) : null}
        workspacePath={startingDraft?.draft.id === selectedId ? shortenHomePaths(startingDraft.workspacePath) : null}
        phase={queuedPrompt?.kind === "draft" && queuedPrompt.draft.id === draft?.id ? "queued" : creating || startingDraft?.draft.id === selectedId ? "starting" : "idle"}
        onChoose={(slug) => setDraft((current) => (current ? { ...current, repoSlug: slug } : current))}
      />
      <div className={`terminal-composer${activeMention ? " menu-open" : ""}`}>
        <label className="sr-only" htmlFor="draft-input">
          First message
        </label>
        <textarea
          ref={draftInputRef}
          id="draft-input"
          className="composer-input"
          value={startingDraft?.draft.id === selectedId ? "" : direction}
          disabled={creating || startingDraft?.draft.id === selectedId || queuedPrompt?.kind === "draft"}
          aria-autocomplete="list"
          aria-controls={activeMention ? "agent-mention-options" : undefined}
          aria-activedescendant={activeMention && mentionMatches.length > 0 ? `agent-mention-option-${selectedMentionIndex}` : undefined}
          onFocus={(event) => { setComposerFocused(true); updateCaretPosition(event.currentTarget); }}
          onBlur={() => setComposerFocused(false)}
          onClick={(event) => updateCaretPosition(event.currentTarget)}
          onKeyUp={(event) => {
            if (suppressMentionKeyUpRef.current) { suppressMentionKeyUpRef.current = false; return; }
            updateCaretPosition(event.currentTarget);
          }}
          onChange={(event) => {
            promptHistoryStateRef.current = INITIAL_PROMPT_HISTORY_STATE;
            setDirection(event.target.value);
            updateCaretPosition(event.target);
            setMentionIndex(0);
            setCreateError(null);
          }}
          onKeyDown={(event) => {
            if (handleMentionKeyDown(event)) return;
            if (handleHistoryKeyDown(event)) return;
            if (event.key !== "Enter") return;
            if (!shouldSubmitOnEnter({
              isComposing: event.nativeEvent.isComposing,
              shiftKey: event.shiftKey,
              virtualKeyboard: isVirtualKeyboardEnvironment(),
              hardwareKeyboardSeen: hardwareKeyboardSeenRef.current,
            })) return;
            event.preventDefault();
            if (!creating && direction.trim().length > 0) {
              draftFormRef.current?.requestSubmit();
            }
          }}
          placeholder={`What would you like ${selectedCompanion?.name ?? "your companion"} to do?`}
          rows={1}
          maxLength={19960}
        />
        {activeMention && (
          <AgentMentionMenu agents={mentionMatches} activeIndex={selectedMentionIndex} onChoose={chooseMention}
            inputRef={draftInputRef} mentionStart={activeMention.start} value={direction} />
        )}
        <div className="composer-toolbar">
          <div className="composer-tools" aria-label="Message tools">
            <CompanionMenu name={selectedCompanion?.name ?? "Companion"} effort={effort} icon={<MuseIcon />}
              picking browsing models={accessibleModels}
              options={companions.filter((item) => item.id !== selectedCompanionId && availableCompanions.some((available) => available.id === item.id))}
              disabled={creating || startingDraft?.draft.id === selectedId || queuedPrompt?.kind === "draft"}
              onChoose={(id) => selectCompanion(id)} />
          </div>
          <div className="composer-actions">
            <span
              className="composer-budget"
              title={contextUsageLabel(estimatedContextTokens, CONTEXT_WINDOW_TOKENS)}
              aria-label={contextUsageLabel(estimatedContextTokens, CONTEXT_WINDOW_TOKENS)}
            >
              <ContextRing value={estimatedContextTokens} max={CONTEXT_WINDOW_TOKENS} />
            </span>
            <button
              type="button"
              className={`composer-icon voice-button ${listening ? "listening" : ""}`}
              onClick={toggleVoiceInput}
              title={listening ? "Stop voice input" : "Start voice input"}
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              aria-pressed={listening}
            >
              <MicrophoneIcon />
            </button>
            <button
              type="submit"
              className="composer-send"
              aria-label={creating ? "Sending message" : connectionLost ? "Queue first message" : "Send first message"}
              title={connectionLost ? "Offline — the message sends when the connection is back" : undefined}
              disabled={selectedModelBlocked || creating || startingDraft?.draft.id === selectedId || direction.trim().length === 0 || queuedPrompt?.kind === "draft" || (connectionLost && queuedPrompt !== null)}
            >
              {creating ? <span className="send-spinner" aria-hidden="true" /> : <SendIcon />}
            </button>
          </div>
        </div>
      </div>
      {(createError || voiceError) && (
        <div className="takeover-feedback" aria-live="polite">
          {createError && <span className="takeover-error" role="alert">{createError}</span>}
          {voiceError && <span className="takeover-error" role="alert">{voiceError}</span>}
        </div>
      )}
    </form>
  ) : null;

  const sidebarLoaded = sessionsQuery.data !== undefined;
  const draftCompanionId = draft?.companionId ?? null;
  const draftBusy = creating || queuedPrompt?.kind === "draft";
  const sidebarElement = useMemo(() => {
    const nowMs = sidebarClockMs;
    return (
            <aside id="agent-sidebar" className="session-rail" aria-label="Code companions">
              <header className="command-bar">
                <span className="command-bar-eyebrow">THE CODING TEAM</span>
                <h1>Code Companions</h1>
                <p className="command-bar-description">Specialized code helpers that work for you and your assistant</p>
              </header>
              {sessions.length > 0 && <div className="list-controls">
                <div className="filter-bar" role="group" aria-label="Show companions">
                  {FILTERS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={filter === item.value ? "active" : ""}
                      onClick={() => setFilter(item.value)}
                      aria-pressed={filter === item.value}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <SortMenu value={sortMode} onChange={setSortMode} />
              </div>}
              {archiveError && <div className="archive-error" role="alert">{archiveError}</div>}
              {renameError && <div className="archive-error" role="alert">{renameError}</div>}
              {sessions.length > 1 && <div className="session-filter">
                <FilterIcon />
                <input
                  type="search"
                  aria-label="Filter"
                  placeholder="Filter"
                  value={sessionQuery}
                  onChange={(event) => {
                    setSessionQuery(event.target.value);
                    if (event.target.value.trim()) setAvailableExpanded(true);
                  }}
                  maxLength={200}
                />
                {sessionQuery.trim() !== "" && (
                  <button
                    type="button"
                    className="session-filter-clear"
                    onClick={() => setSessionQuery("")}
                    aria-label="Clear filter"
                  >
                    ×
                  </button>
                )}
              </div>}
              <div className="session-list">
                {!sessionsQuery.data ? (
                  <p className="filter-empty">{connectionLost ? "Waiting for the connection…" : "Loading companions…"}</p>
                ) : visibleSessions.length === 0 ? (
                  filter === "active" && sessionQuery.trim() === "" ? null : <p className="filter-empty">
                    {sessionQuery.trim() !== "" ? "No matching conversations." : `No ${filterLabel.toLowerCase()} conversations.`}
                  </p>
                ) : (
                  sessionGroups.map((group) => (
                    <section key={group.key === "" ? "none" : group.key} className="session-group" aria-label={group.name}>
                      <div className="session-group-header-row">
                        <button
                          type="button"
                          className="session-group-header"
                          onClick={() => toggleGroup(group.key)}
                          aria-expanded={!collapsedGroups.has(group.key)}
                        >
                          <span className="session-group-chevron" aria-hidden="true">
                            <ChevronIcon />
                          </span>
                          <span className="session-group-name">{group.name}</span>
                          {/* The flat task list needs no group count. */}
                          {group.key !== "" && <span className="session-group-count">{group.sessions.length}</span>}
                        </button>
                      </div>
                      {!collapsedGroups.has(group.key) && (
                        <div className="session-group-list companion-task-list">
                          {group.sessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              selected={selectedCompanionId === null && session.id === selectedId}
                              past={filter === "inactive"}
                              archiveBusy={archiveBusy}
                              deleteBusy={deleteBusy}
                              onDeleteClick={() => askToDelete(session)}
                              nowMs={nowMs}
                              onSelect={() => {
                                setSelectedCompanionId(null);
                                setSelectedId(session.id);
                                setMobileListOpen(false);
                              }}
                              onArchiveClick={() => {
                                // No confirmation: archiving is undone with Restore.
                                void changeArchiveState(session.id, true);
                              }}
                              onRestoreClick={() => {
                                void changeArchiveState(session.id, false);
                              }}
                              renaming={renamingId === session.id}
                              renameValue={renameValue}
                              renameBusy={renameBusy}
                              onRenameClick={() => {
                                setRenamingId(session.id);
                                setRenameValue(sessionTaskTitle(session).slice(0, 240));
                                setRenameError(null);
                              }}
                              onRenameChange={(value) => {
                                setRenameValue(value);
                                setRenameError(null);
                              }}
                              onRenameSubmit={() => {
                                void submitRename(session.id);
                              }}
                              onRenameCancel={() => {
                                setRenamingId(null);
                                setRenameError(null);
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  ))
                )}
              </div>
              {/* Availability is derived from the session list, so before it
                  first loads every companion would wrongly appear available.
                  Gate the roster on that first load (the session list above
                  already shows "Loading companions…") so the app never
                  paints a state it is about to replace. */}
              {filter === "active" && sessionsQuery.data && <section className="available-companions" aria-label="Available companions">
                {hasActiveTasks && <button type="button" className="session-group-header available-companions-toggle"
                  aria-expanded={availableOpen} aria-controls="available-companion-list"
                  onClick={() => setAvailableExpanded((value) => !value)}>
                  <span className="session-group-chevron" aria-hidden="true"><ChevronIcon /></span>
                  <span className="session-group-name">Available</span>
                </button>}
                <nav id="available-companion-list" className="companion-contact-list" hidden={!availableOpen} aria-label="Choose an available companion">
                  {visibleAvailableCompanions.map((definition) => {
                    const companion = companions.find((item) => item.id === definition.id)!;
                    return <CompanionContact key={companion.id} companion={companion} selected={selectedCompanionId === companion.id} models={accessibleModels}
                      disabled={(creating || queuedPrompt?.kind === "draft") && draft?.companionId !== companion.id}
                      onSelect={() => {
                        selectCompanion(companion.id);
                        requestAnimationFrame(() => document.getElementById("companion-welcome-heading")?.focus());
                      }} />;
                  })}
                  {!sessionQuery.trim() && matchingAvailableCompanions.some((companion) => !isDefaultCompanion(companion)) && (
                    <MoreCompanionsButton expanded={moreAvailableExpanded} controls="available-companion-list"
                      onToggle={() => setMoreAvailableExpanded((value) => !value)} />
                  )}
                  {matchingAvailableCompanions.length === 0 && <p className="filter-empty">
                    {sessionQuery.trim() ? "No matching available companions." : "Everyone is on a task."}
                  </p>}
                </nav>
              </section>}
            </aside>
    );
  }, [
    sidebarClockMs,
    sessions,
    sidebarLoaded,
    connectionLost,
    filter,
    filterLabel,
    sortMode,
    archiveError,
    renameError,
    sessionQuery,
    visibleSessions,
    sessionGroups,
    collapsedGroups,
    selectedCompanionId,
    selectedId,
    archiveBusy,
    deleteBusy,
    renamingId,
    renameValue,
    renameBusy,
    hasActiveTasks,
    availableOpen,
    visibleAvailableCompanions,
    matchingAvailableCompanions,
    accessibleModels,
    draftBusy,
    draftCompanionId,
    moreAvailableExpanded,
  ]);
  const detailMenuSession = selectedSession ?? detailSession;
  const detailCompanionActive = liveWork || sendingDirection || pendingEcho !== null;
  const detailCompanionActivity = agentsRunning && !sessionActive ? "Running helpers" : workingLabel;
  const detailCompanionVisible = !isNarrow || !mobileListOpen;
  const detailFloatingToolbar = useMemo(() => {
    if (!detailSession || !detailMenuSession) return null;
    return (
                    <div className="chat-floating-toolbar" role="group" aria-label="Chat controls">
                      <button type="button" className="mobile-back-button" aria-label="Back to companions"
                        onClick={() => { setMobileListOpen(true); setSelectedId(null); }}><BackIcon /></button>
                      <TranscriptCompanion key={detailSession.id} name={detailAgentName}
                        connecting={connectionLost || pilotUnavailable}
                        archived={sessionPast}
                        active={detailCompanionActive}
                        starting={taskStarting}
                        activity={detailCompanionActivity}
                        visible={detailCompanionVisible} />
                      <div className="chat-floating-actions">
                        <OwnedArtifactMenu paths={ownedFiles} onOpen={openFileTabForDetail} />
                        <NewTerminalButton onOpen={() => openTerminalTab(detailSession.id)} />
                        <SessionMenu actions={sessionMenuActions(selectedSession ?? detailSession)} colorMode={colorMode}
                          onColorModeChange={(mode) => { applyColorMode(mode); setColorMode(mode); }}
                          showRawToolOutput={showRawToolOutput}
                          onToggleRawToolOutput={() => setShowRawToolOutput((value) => !value)} />
                      </div>
                    </div>
    );
  }, [
    detailSession,
    detailMenuSession,
    detailAgentName,
    connectionLost,
    pilotUnavailable,
    sessionPast,
    detailCompanionActive,
    taskStarting,
    detailCompanionActivity,
    detailCompanionVisible,
    ownedFiles,
    openFileTabForDetail,
    colorMode,
    showRawToolOutput,
    showReasoning,
    expandTools,
    showWorkingDetails,
    archiveBusy,
    deleteBusy,
    renameBusy,
    sessionsForMessages,
    isNarrow,
  ]);
  const takeoverDisabledReason = liveWork || sendingDirection || pendingDirection !== null
    ? "Stop the current turn before handing over this task." : queuedPrompt !== null
    ? "Send or cancel the queued message before handing over this task." : connectionLost ? "Connect before handing over this task." : undefined;
  const takeoverComposerTools = useMemo(() => (
                            <div className="composer-tools" aria-label="Message tools">
                              <CompanionMenu name={detailAgentName} effort={effort} icon={<MuseIcon />}
                                picking={sessionPast} models={accessibleModels}
                                options={companions.filter((item) => availableCompanions.some((available) => available.id === item.id))}
                                busy={handoffBusy}
                                disabledReason={takeoverDisabledReason}
                                onChoose={(id) => { void handOffCompanion(id); }} />
                            </div>
  ), [
    detailAgentName,
    effort,
    sessionPast,
    accessibleModels,
    availableCompanions,
    handoffBusy,
    takeoverDisabledReason,
    detailSession?.id,
  ]);
  const detailSidePanelState = detailSessionIdForFiles ? sidePanels[detailSessionIdForFiles] : undefined;
  const detailSidePanel = useMemo(() => {
    if (!hasSidePanel || !detailSessionIdForFiles || !detailSidePanelState) return null;
    return (
      <SidePanel
        key={detailSessionIdForFiles}
        sessionId={detailSessionIdForFiles}
        state={detailSidePanelState}
        onBack={() => setMobileSideOpen(false)}
        onSelect={(key) => updateSidePanel(detailSessionIdForFiles, (state) => ({ ...state, activeKey: key }))}
        onClose={(tab) => closeSideTab(detailSessionIdForFiles, tab)}
        onTerminalOpened={(key, terminalId, number) =>
          updateSidePanel(detailSessionIdForFiles, (state) => ({
            ...state,
            tabs: state.tabs.map((tab) => (tab.kind === "terminal" && tab.key === key ? { ...tab, terminalId, number } : tab)),
          }))
        }
      />
    );
  }, [hasSidePanel, detailSessionIdForFiles, detailSidePanelState]);

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="workspace">
        <div
          ref={layoutRef}
          className={`console-layout ${mobileListOpen ? "mobile-list-view" : isNarrow && hasSidePanel && mobileSideOpen ? "mobile-side-view" : "mobile-detail-view"}`}
          style={{ "--sidebar-width": `${paneSizes.sidebarWidth}px` } as CSSProperties}
        >
            {sidebarElement}
            <PaneDivider
              label="Resize companion sidebar and chat"
              controls="agent-sidebar agent-detail"
              value={paneSizes.sidebarWidth}
              min={sidebarBounds.min}
              max={sidebarBounds.max}
              defaultValue={DEFAULT_SIDEBAR_WIDTH}
              onChange={(width) => setPaneSizes((current) => ({
                ...current,
                sidebarWidth: clampSidebarWidth(width, layoutRef.current?.getBoundingClientRect().width || window.innerWidth),
              }))}
              valueFromPointer={(clientX) => clientX - (layoutRef.current?.getBoundingClientRect().left ?? 0)}
            />

            <section id="agent-detail" className="detail-pane" aria-label="Companion output">
              {startingDraft?.draft.id === selectedId ? (
                <div className="detail-split">
                  <div id="agent-chat" className="transcript" aria-live="polite">
                    <div className="chat-floating-toolbar" role="group" aria-label="Chat controls">
                      <button type="button" className="mobile-back-button" aria-label="Back to companions"
                        onClick={() => setMobileListOpen(true)}><BackIcon /></button>
                      <TranscriptCompanion name={startingDraft.draft.companionName} active starting activity="Starting"
                        connecting={connectionLost || pilotUnavailable}
                        visible={!isNarrow || !mobileListOpen} />
                      <div className="chat-floating-actions">
                        <SessionMenu actions={viewMenuActions} colorMode={colorMode}
                          onColorModeChange={(mode) => { applyColorMode(mode); setColorMode(mode); }}
                          showRawToolOutput={showRawToolOutput}
                          onToggleRawToolOutput={() => setShowRawToolOutput((value) => !value)} />
                      </div>
                    </div>
                    <div className="terminal-body">
                      <div className="output-stream">
                        <article className="output-event user pending-echo" aria-label="Sending">
                          <div className="message-text">{displayOutput(startingDraft.prompt)}</div>
                        </article>
                        <WorkingIndicator label="Starting" elapsedSeconds={sendingElapsedSeconds} detailed={showWorkingDetails} />
                      </div>
                    </div>
                    {firstMessageComposer}
                  </div>
                </div>
              ) : selectedCompanion ? <CompanionWelcome companion={selectedCompanion} visible={!isNarrow || !mobileListOpen} models={accessibleModels}
                availableIds={availableCompanions.map((companion) => companion.id)} onBrowse={selectCompanion}
                browsingDisabled={creating || queuedPrompt?.kind === "draft"}
                composer={firstMessageComposer}
                onBack={() => {
                  setMobileListOpen(true);
                  requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".companion-contact[aria-current]")?.focus());
                }}
                actions={<SessionMenu actions={viewMenuActions} colorMode={colorMode}
                  onColorModeChange={(mode) => { applyColorMode(mode); setColorMode(mode); }}
                  showRawToolOutput={showRawToolOutput} onToggleRawToolOutput={() => setShowRawToolOutput((value) => !value)} />} /> : <>
              {!draftSelected && (selectedId === null || !detailSession || detailQuery.isPending || !sessionsQuery.data || sessions.length === 0) && (
                <div className="chat-floating-toolbar" role="group" aria-label="Chat controls">
                  <button type="button" className="mobile-back-button" aria-label="Back to companions"
                    onClick={() => setMobileListOpen(true)}><BackIcon /></button>
                  <div className="chat-floating-actions">
                    <SessionMenu actions={viewMenuActions} colorMode={colorMode}
                      onColorModeChange={(mode) => { applyColorMode(mode); setColorMode(mode); }}
                      showRawToolOutput={showRawToolOutput}
                      onToggleRawToolOutput={() => setShowRawToolOutput((value) => !value)} />
                  </div>
                </div>
              )}
              {!sessionsQuery.data ? (
                <div className="detail-loading boot-loader" role="status" aria-live="polite">
                  <div className="boot-loader-box">
                    <span>Loading companions…</span>
                    <div className="boot-progress-track" aria-hidden="true">
                      <div className="boot-progress-fill detail-loading-progress-fill" />
                    </div>
                  </div>
                </div>
              ) : sessions.length === 0 ? (
                <p className="detail-loading">Pick a companion and tell them what you’d like to do.</p>
              ) : selectedId === null ? (
                <p className="detail-loading">Select a task to see its conversation.</p>
              ) : detailQuery.isPending || !detailSession ? (
                <p className="detail-loading">Loading conversation…</p>
              ) : (
                <>
                  {/* Side panel (terminal tabs) right of the transcript, stacked when narrow. */}
                  <div
                    ref={detailSplitRef}
                    className={`detail-split${hasSidePanel ? " with-side-panel" : ""}`}
                    style={{ "--chat-width": `${paneSizes.chatShare * 100}%` } as CSSProperties}
                  >
                  <div
                    id="agent-chat"
                    className="transcript"
                    aria-live={isTurnLive(detailSession.status) ? "polite" : "off"}
                  >
                    {detailFloatingToolbar}
                    <div
                      ref={terminalBodyRef}
                      className="terminal-body"
                      onScroll={(event) => {
                        followTranscriptRef.current = transcriptAtBottom(event.currentTarget);
                        setShowScrollToBottom(!followTranscriptRef.current);
                        if (followTranscriptRef.current) markVisibleRead();
                      }}
                    >
                      {(renameError || archiveError) && (
                        <div className="archive-error detail-action-error" role="alert">{renameError ?? archiveError}</div>
                      )}
                      {detailQuery.isError && !detail ? (
                        <div className="transcript-empty">
                          {!connectionLost && "Output couldn’t load. Refresh to try again."}
                        </div>
                      ) : visibleTranscriptEvents.length === 0 && pendingEcho === null && queuedMessageHere === null ? (
                        <div className="transcript-empty">
                          {!connectionLost && !pilotUnavailable && (sessionActive ? (
                            <WorkingIndicator label={workingLabel} elapsedSeconds={runElapsedSeconds} detailed={showWorkingDetails} />
                          ) : "No output yet.")}
                        </div>
                      ) : (
                        <div ref={transcriptContentRef} className="output-stream">
                          {renderedTranscriptEvents}
                          {pendingEcho !== null && (
                            <article className="output-event user pending-echo" aria-label="Sending">
                              <div className="message-text">{displayOutput(pendingEcho)}</div>
                            </article>
                          )}
                          {pendingEcho !== null && (
                            <WorkingIndicator label="Sending" elapsedSeconds={sendingElapsedSeconds} detailed={showWorkingDetails} />
                          )}
                          {sessionActive && pendingEcho === null && !pilotUnavailable && <WorkingIndicator label={workingLabel} elapsedSeconds={runElapsedSeconds} detailed={showWorkingDetails} />}
                          {queuedMessageHere !== null && pendingEcho === null && (
                            <QueuedEcho text={queuedMessageHere} onCancel={cancelQueuedPrompt} sending={flushingRef.current} />
                          )}
                        </div>
                      )}
                    </div>

                    <div ref={scrollControlsRef} className={`transcript-scroll-controls${showScrollToBottomRef.current ? " visible" : ""}`}>
                      <button ref={scrollToBottomButtonRef} type="button" className="scroll-to-bottom" aria-label="Scroll to bottom of conversation"
                        tabIndex={showScrollToBottomRef.current ? 0 : -1}
                        onClick={() => {
                          const body = terminalBodyRef.current;
                          if (!body) return;
                          followTranscriptRef.current = true;
                          body.scrollTop = body.scrollHeight;
                          setShowScrollToBottom(false);
                          markVisibleRead();
                        }}>
                        Scroll to bottom <ChevronIcon />
                      </button>
                    </div>

                    {pendingInputs.map((input) => (
                      <UserInputCard
                        key={input.userInputId}
                        input={input}
                        busy={inputBusyId === input.userInputId}
                        error={inputError?.userInputId === input.userInputId ? inputError.error : null}
                        onAnswer={submitUserInputAnswer}
                        onCancel={skipUserInput}
                      />
                    ))}
                    {awaitingPilot || failedPilotStart ? (
                      <div className="pilot-start-panel" role="status">
                        <span>{awaitingPilot
                          ? "Your first message is saved. Connecting…"
                          : "The companion could not start. Check the error above, then retry."}</span>
                        {failedPilotStart && (
                          <button type="button" onClick={() => void retryFailedStart()} disabled={retryingStart}>
                            {retryingStart ? "Retrying…" : "Retry start"}
                          </button>
                        )}
                        {startRetryError && <span role="alert">{startRetryError}</span>}
                      </div>
                    ) : (
                    /* Shown for past sessions too: sending resumes them ("Resume & send"). */
                      <form ref={takeoverFormRef} className="terminal-prompt" onSubmit={submitTakeover}>
                        {detailSession.repo_slug && (
                          <RepoPicker
                            repos={reposQuery.data?.repos ?? []}
                            githubEnabled={reposQuery.data?.github_enabled ?? true}
                            loading={reposQuery.isFetching}
                            selected={detailSession.repo_slug}
                            mode="manage"
                            cloneProgress={detailSession.status === "queued" && detailSession.pilot_session_id === null ? (cloneProgressQuery.data ?? null) : null}
                            workspacePath={detailSession.workspace_root ? shortenHomePaths(detailSession.workspace_root) : null}
                            phase={detailSession.status === "queued" && detailSession.pilot_session_id === null ? "starting" : "idle"}
                          />
                        )}
                        {companionBusyElsewhere && <p className="task-resume-notice" role="status">
                          {detailAgentName} is on another task. Pick another companion below to resume.
                        </p>}
                        {/* While connecting the catalog check has not completed, so an
                            "unavailable" verdict would be a guess; the header already
                            says the companion is connecting. */}
                        {!promptConnectionLost && accessibleModels !== undefined && <CompanionAccessNotice access={detailModelAccess} modelName={displayModelLabel(detailModelId)} />}
                        <div className={`terminal-composer${activeMention ? " menu-open" : ""}`}>
                          <label className="sr-only" htmlFor="takeover-input">
                            Message Muse Code
                          </label>
                          <textarea
                            ref={takeoverInputRef}
                            id="takeover-input"
                            disabled={handoffBusy}
                            className="composer-input"
                            value={direction}
                            aria-autocomplete="list"
                            aria-controls={activeMention ? "agent-mention-options" : undefined}
                            aria-activedescendant={activeMention && mentionMatches.length > 0 ? `agent-mention-option-${selectedMentionIndex}` : undefined}
                            onFocus={(event) => { setComposerFocused(true); updateCaretPosition(event.currentTarget); }}
                            onBlur={() => setComposerFocused(false)}
                            onClick={(event) => updateCaretPosition(event.currentTarget)}
                            onKeyUp={(event) => {
                              if (suppressMentionKeyUpRef.current) { suppressMentionKeyUpRef.current = false; return; }
                              updateCaretPosition(event.currentTarget);
                            }}
                            onChange={(event) => {
                              promptHistoryStateRef.current = INITIAL_PROMPT_HISTORY_STATE;
                              setDirection(event.target.value);
                              updateCaretPosition(event.target);
                              setMentionIndex(0);
                              setPendingDirection(null);
                              setTakeoverError(null);
                              setTakeoverStatus(null);
                            }}
                            onKeyDown={(event) => {
                              if (handleMentionKeyDown(event)) return;
                              if (handleHistoryKeyDown(event)) return;
                              if (event.key !== "Enter") return;
                              if (!shouldSubmitOnEnter({
                                isComposing: event.nativeEvent.isComposing,
                                shiftKey: event.shiftKey,
                                virtualKeyboard: isVirtualKeyboardEnvironment(),
                                hardwareKeyboardSeen: hardwareKeyboardSeenRef.current,
                              })) return;
                              event.preventDefault();
                              if (!sendingDirection && pendingDirection === null && direction.trim().length > 0) {
                                takeoverFormRef.current?.requestSubmit();
                              }
                            }}
                            placeholder={sessionPast ? "Type a message to resume this task…" : "Type a message…"}
                            rows={1}
                            maxLength={19960}
                            autoFocus
                          />
                          {activeMention && (
                            <AgentMentionMenu agents={mentionMatches} activeIndex={selectedMentionIndex} onChoose={chooseMention}
                              inputRef={takeoverInputRef} mentionStart={activeMention.start} value={direction} />
                          )}
                          <div className="composer-toolbar">
                            {takeoverComposerTools}
                            <div className="composer-actions">
                              <span
                                className="composer-budget"
                                title={contextUsageLabel(estimatedContextTokens, CONTEXT_WINDOW_TOKENS)}
                                aria-label={contextUsageLabel(estimatedContextTokens, CONTEXT_WINDOW_TOKENS)}
                              >
                                <ContextRing value={estimatedContextTokens} max={CONTEXT_WINDOW_TOKENS} />
                              </span>
                              <button
                                type="button"
                                className={`composer-icon voice-button ${listening ? "listening" : ""}`}
                                onClick={toggleVoiceInput}
                                title={listening ? "Stop voice input" : "Start voice input"}
                                aria-label={listening ? "Stop voice input" : "Start voice input"}
                                aria-pressed={listening}
                              >
                                <MicrophoneIcon />
                              </button>
                              {sendingDirection || sessionActive ? (
                                <button
                                  type="button"
                                  className="composer-send composer-send-stop"
                                  onClick={() => {
                                    void interruptTurn();
                                  }}
                                  disabled={interrupting}
                                  aria-label={interrupting ? "Stopping the turn" : "Stop the turn"}
                                  title="Stop the turn"
                                >
                                  <span className="send-stop" aria-hidden="true" />
                                </button>
                              ) : (
                                <button
                                  type="submit"
                                  className={`composer-send${sessionPast ? " composer-send-resume" : ""}`}
                                  aria-label={promptConnectionLost ? "Queue message" : sessionPast ? "Resume task and send message" : "Send message"}
                                  title={companionBusyElsewhere ? "Pick another companion before resuming this task" : promptConnectionLost
                                    ? "Offline — the message sends when the connection is back"
                                    : sessionPast ? "Restores this task to Active and sends the message" : undefined}
                                  disabled={detailModelBlocked || companionBusyElsewhere || handoffBusy || pendingDirection !== null || direction.trim().length === 0 || (connectionLost && queuedPrompt !== null)}
                                >
                                  {sessionPast && <span className="composer-send-label">Resume &amp; send</span>}
                                  <SendIcon />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                        {(takeoverError || takeoverStatus || voiceError) && (
                          <div className="takeover-feedback" aria-live="polite">
                            {takeoverError && <span className="takeover-error" role="alert">{takeoverError}</span>}
                            {voiceError && <span className="takeover-error" role="alert">{voiceError}</span>}
                            {takeoverStatus && <span className="takeover-success">{takeoverStatus}</span>}
                          </div>
                        )}
                      </form>
                    )}
                  </div>
                  {hasSidePanel && (
                    <PaneDivider
                      label="Resize chat and terminals"
                      controls="agent-chat agent-side-panel"
                      value={chatWidth}
                      min={chatBounds.min}
                      max={chatBounds.max}
                      defaultValue={Math.max(0, splitWidth - DIVIDER_WIDTH) * DEFAULT_CHAT_SHARE}
                      onChange={(width) => setPaneSizes((current) => {
                        const measured = detailSplitRef.current?.getBoundingClientRect().width || splitWidth;
                        return { ...current, chatShare: clampChatShare(width / Math.max(1, measured - DIVIDER_WIDTH), measured) };
                      })}
                      valueFromPointer={(clientX) => clientX - (detailSplitRef.current?.getBoundingClientRect().left ?? 0)}
                    />
                  )}
                  {detailSidePanel}
                  </div>
                </>
              )}
              </>}
            </section>
          </div>
      </main>
      {textPrompt && (
        <TextPromptDialog key={textPrompt.title} spec={textPrompt} onClose={() => setTextPrompt(null)} />
      )}
      {deleteTarget && (
        <ConfirmDeleteDialog
          title={deleteTarget.title}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteSessionPermanently(deleteTarget.id)}
        />
      )}
    </div>
  );
}

// Pure helpers for translating pilot stream items into app transcript events.
// No runtime imports: safe to load anywhere (worker, probes).

export type PilotItem = {
  kind: string;
  itemId?: string;
  recordedAt?: string;
  // workflow / subagent items (agent-to-agent work)
  workflowRunId?: string;
  entryId?: string;
  scriptId?: string;
  message?: string;
  children?: Array<{ childId?: string; attempt?: number; label?: string; status?: string; phase?: string; durationMs?: number; terminal?: string }>;
  subagentId?: string;
  objective?: string;
  role?: string;
  controlStatus?: string;
  result?: { summary?: string; text?: string; errorKind?: string };
  failureReason?: string;
  text?: string;
  // MSP reasoning.summary streams; reasoning.text is raw committed text on
  // some providers and must not be used as the UI's thinking summary.
  summary?: string[];
  truncated?: boolean;
  fallbackText?: string;
  status?: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  outputRef?: { id: string; byteLen: number; availability: string; mediaType?: string; kind?: string };
  patchRef?: { id: string; byteLen: number; availability: string; mediaType?: string; kind?: string };
  patchSummary?: { files: number; added: number; removed: number };
};

export function pilotReasoningSummary(item: PilotItem | undefined): string | null {
  if (!item || item.kind !== "reasoning") return null;
  const summary = (item.summary ?? []).filter((part) => typeof part === "string" && part.trim()).join("\n\n").trim();
  if (!summary) return ""; // retain the item position; don't show an empty row
  return item.truncated ? `${summary}\n\n(Reasoning summary truncated by Muse.)` : summary;
}

export function pilotItemText(item: PilotItem | undefined): string | null {
  if (!item || item.status === "inProgress") return null;
  // workflow/subagent items are agents rows (pilotAgentsRow), not text lines.
  if (["userMessage", "reasoning", "reminderChild", "compaction", "toolCall", "workflow", "subagent"].includes(item.kind)) {
    return null;
  }
  const content = item.text?.trim() || item.fallbackText?.trim() || "";
  return content || null;
}

const TOOL_SUMMARY_MAX = 300;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function pilotToolSummary(argsJson: string | undefined): string | null {
  if (!argsJson) return null;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const description = record.description;
      if (typeof description === "string" && description.trim()) {
        return collapseWhitespace(description).slice(0, TOOL_SUMMARY_MAX) || null;
      }
      const command = record.command;
      if (typeof command === "string" && command.trim()) {
        const collapsed = collapseWhitespace(command);
        return collapsed ? `$ ${collapsed}`.slice(0, TOOL_SUMMARY_MAX) : null;
      }
      for (const value of Object.values(record)) {
        if (typeof value === "string" && value.trim()) {
          return collapseWhitespace(value).slice(0, TOOL_SUMMARY_MAX) || null;
        }
      }
      return null;
    }
  } catch {
    // Fall through to raw text.
  }
  const collapsed = collapseWhitespace(argsJson);
  return collapsed ? collapsed.slice(0, TOOL_SUMMARY_MAX) : null;
}

// Tool row label ("bash · $ echo hi") for any status, including inProgress:
// tool rows appear when the tool starts and are updated when it finishes.
export function pilotToolLabel(item: PilotItem | undefined): string | null {
  if (!item || item.kind !== "toolCall") return null;
  const tool = item.tool?.trim() || "tool";
  const summary = pilotToolSummary(item.args);
  return summary ? `${tool} · ${summary}` : tool;
}

// When an item revision happened: its durable recordedAt (RFC3339, possibly
// with microseconds), else the pilot's receive time, else null.
export function pilotItemTime(recordedAt: string | undefined, eventAt: string | undefined): Date | null {
  for (const raw of [recordedAt, eventAt]) {
    if (!raw) continue;
    // Keep at most millisecond precision for engines that reject longer fractions.
    const ms = Date.parse(raw.replace(/(\.\d{3})\d+/, "$1"));
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}

export function pilotToolText(item: PilotItem | undefined): string | null {
  if (!item || item.kind !== "toolCall") return null;
  if (item.status === "inProgress") return null;
  const tool = item.tool?.trim() || "tool";
  const summary = pilotToolSummary(item.args);
  return summary ? `${tool} · ${summary}` : tool;
}

export type PilotStreamEvent = {
  seq: number;
  type: string;
  at?: string;
  text?: string;
  item?: PilotItem;
  error?: unknown;
  outcome?: unknown;
  userInputId?: string;
  questions?: Array<{
    id?: string;
    header?: string;
    question?: string;
    selection?: { mode?: string; minSelections?: number; maxSelections?: number };
    options?: Array<{ label?: string; description?: string }>;
  }>;
};

// A turn the user (or runtime) cancelled instead of letting it finish.
// The SDK settles it as turn/completed with terminal "cancelled" (nested
// under params on the facade outcome); older shapes may carry status
// "cancelled". Cancelled is a deliberate stop, never an error.
export function pilotTurnCancelled(outcome: unknown): boolean {
  if (typeof outcome === "string") return /^cancelled$|^canceled$/i.test(outcome.trim());
  if (!outcome || typeof outcome !== "object") return false;
  const record = outcome as Record<string, unknown>;
  for (const key of ["status", "terminal"]) {
    const value = record[key];
    if (typeof value === "string" && /^cancelled$|^canceled$/i.test(value.trim())) return true;
  }
  const params = record.params;
  if (params && typeof params === "object") return pilotTurnCancelled(params);
  return false;
}

// A turn_completed outcome that carries a failure. The SDK reports async
// transport/model failures inside the outcome object rather than as a
// separate turn_error event, so the worker must check before celebrating.
export function pilotTurnOutcomeError(outcome: unknown): string | null {
  if (outcome == null) return null;
  if (pilotTurnCancelled(outcome)) return null;
  if (typeof outcome === "string") {
    const trimmed = outcome.trim();
    if (/^(error|failed|failure)\b/i.test(trimmed)) return trimmed.slice(0, 20000) || null;
    return null;
  }
  if (typeof outcome !== "object") return null;
  const record = outcome as Record<string, unknown>;
  for (const key of ["error", "errorMessage", "message", "failureReason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 20000);
    }
  }
  const params = record.params;
  if (params && typeof params === "object") {
    const nested = pilotTurnOutcomeError(params);
    if (nested) return nested;
  }
  const status = record.status;
  if (typeof status === "string" && /^(error|failed|failure)$/i.test(status.trim())) {
    const detail = typeof record.error === "string" && record.error.trim()
      ? `: ${record.error.trim().slice(0, 20000)}`
      : "";
    return `The turn ended with status "${status.trim()}"${detail}`.slice(0, 20000);
  }
  const terminal = record.terminal;
  if (typeof terminal === "string" && /^(error|failed|failure)$/i.test(terminal.trim())) {
    const errObj = record.error;
    const errMsg = errObj && typeof errObj === "object"
      ? (errObj as Record<string, unknown>).message
      : errObj;
    const detail = typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : typeof errMsg === "string" && errMsg.trim()
        ? errMsg.trim()
        : "";
    return `The turn ended with terminal "${terminal.trim()}"${detail ? `: ${detail}` : ""}`.slice(0, 20000);
  }
  return null;
}

function errorText(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 20000);
  try {
    const encoded = JSON.stringify(error);
    if (encoded && encoded !== "{}" && encoded !== "null") {
      return encoded.slice(0, 20000);
    }
  } catch {
    // Fall through.
  }
  return null;
}

// Transcript text for pilot system event kinds. Returns null for event
// kinds the transcript must skip (e.g. session_started bookkeeping).
// Everything recovery- or error-shaped returns text: failures must surface
// in the transcript, never as silent spinners.
export function pilotSystemText(event: PilotStreamEvent | undefined): string | null {
  if (!event) return null;
  switch (event.type) {
    case "session_recovered":
      return (
        event.text?.trim() ||
        pilotItemText(event.item) ||
        "Backend restarted; this companion was resumed from its transcript."
      );
    case "recovery_failed": {
      const reason = errorText(event.error) ?? event.text?.trim() ?? "";
      const suffix = reason ? `: ${reason}` : "";
      return (
        "Automatic recovery failed after the backend restarted — this companion needs attention. " +
        `Send a new message to retry recovery${suffix}.`
      ).slice(0, 20000);
    }
    case "host_restarted":
      return "The backend host restarted; companions are being resumed.";
    case "host_turn_started":
      return "Muse continued on its own: background work (e.g. a workflow) finished and its results were delivered.";
    case "user_input_requested": {
      const count = Array.isArray(event.questions) ? event.questions.length : 0;
      return (
        "The companion is waiting for your input to continue — answer below." +
        (count > 0 ? ` (${count} question${count === 1 ? "" : "s"})` : "")
      );
    }
    case "user_input_error": {
      const reason = errorText(event.error) ?? event.text?.trim() ?? "";
      return `Sending your answer to the companion failed${reason ? `: ${reason}` : ""}. Try again.`;
    }
    case "session_started":
      return null;
    case "turn_error":
      return errorText(event.error) ?? "Muse Code reported an error while running this turn.";
    case "turn_completed": {
      const outcomeError = pilotTurnOutcomeError(event.outcome);
      return outcomeError;
    }
    default:
      return null;
  }
}

export type UserInputQuestionShape = {
  id: string;
  selection: { mode: string; minSelections?: number; maxSelections?: number };
  options: Array<{ label: string }>;
};

export type UserInputSelectionShape = {
  questionId: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
};

export type WireUserInputAnswer = {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
};

// Shape a user's answers into the wire form the serve host accepts
// (`userInput/answer`: one entry per question, exactly one of
// selectedLabel / selectedLabels / freeText, plus an optional note).
// Returns an error string instead of throwing so callers surface it.
export function buildUserInputAnswers(
  questions: UserInputQuestionShape[],
  selections: UserInputSelectionShape[],
): { ok: true; answers: WireUserInputAnswer[] } | { ok: false; error: string } {
  const byId = new Map(selections.map((s) => [s.questionId, s]));
  const answers: WireUserInputAnswer[] = [];
  for (const question of questions) {
    const selection = byId.get(question.id);
    if (!selection) return { ok: false, error: `Question "${question.id}" was not answered` };
    const labels = (selection.selectedLabels ?? []).filter((l) => l.trim().length > 0);
    const freeText = (selection.freeText ?? "").trim();
    if (labels.length > 0 && freeText) {
      return { ok: false, error: `Question "${question.id}": pick options or write text, not both` };
    }
    if (labels.length === 0 && !freeText) {
      return { ok: false, error: `Question "${question.id}" was not answered` };
    }
    if (freeText) {
      if (freeText.length > 500) return { ok: false, error: `Answer to "${question.id}" is over 500 characters` };
      const answer: WireUserInputAnswer = { questionId: question.id, freeText };
      if (selection.note?.trim()) answer.note = selection.note.trim().slice(0, 500);
      answers.push(answer);
      continue;
    }
    const known = new Set(question.options.map((o) => o.label));
    for (const label of labels) {
      if (!known.has(label)) return { ok: false, error: `"${label}" is not an option for "${question.id}"` };
    }
    const multiple = question.selection.mode === "multiple";
    const min = question.selection.minSelections ?? (multiple ? 1 : 1);
    const max = question.selection.maxSelections ?? (multiple ? labels.length : 1);
    if (!multiple && labels.length !== 1) {
      return { ok: false, error: `Question "${question.id}": pick exactly one option` };
    }
    if (labels.length < min || labels.length > max) {
      return { ok: false, error: `Question "${question.id}": pick between ${min} and ${max} options` };
    }
    const answer: WireUserInputAnswer = multiple
      ? { questionId: question.id, selectedLabels: labels }
      : { questionId: question.id, selectedLabel: labels[0] };
    if (selection.note?.trim()) answer.note = selection.note.trim().slice(0, 500);
    answers.push(answer);
  }
  return { ok: true, answers };
}

// True when the poll response proves the pilot's live backend session was
// replaced (recovery reseeded a new backend id, or the sequence restarted).
// The caller must then drop its stored seq watermark: filtering a fresh
// event stream against a dead backend's watermark hides every new event.
export function pilotBackendChanged(
  storedBackendId: string | null,
  pollBackendId: string | null | undefined,
  storedSeq: number,
  pollLatestSeq: number,
): boolean {
  if (pollBackendId != null) {
    if (!storedBackendId) return true;
    return storedBackendId !== pollBackendId;
  }
  return pollLatestSeq < storedSeq;
}

// ---- agent-to-agent work (workflows and their child agents, subagents) ----

export type AgentsChild = {
  id: string;
  label: string;
  status: string;
  phase: string | null;
  attempt: number;
  durationMs: number | null;
};

export type AgentsRow = {
  kind: "workflow" | "subagent";
  title: string;
  /** The item's generic status: "inProgress" while running, else terminal. */
  status: string;
  /** Workflow terminal message / subagent result summary or failure. */
  message: string | null;
  workflowRunId: string | null;
  subagentId: string | null;
  children: AgentsChild[];
};

const AGENTS_TEXT_MAX = 4000;

// A workflow child's status, normalised: muse reports progress steps
// (scheduled → started → usage… → completed → terminal) and the outcome in
// `terminal`. Returns the display status plus the raw step as a phase.
function childStatus(child: { status?: string; terminal?: string }): { status: string; phase: string | null } {
  if (child.terminal) return { status: child.terminal, phase: null };
  const raw = child.status ?? "running";
  if (/^(scheduled|started|usage|running|starting|accepted|pending|queued)$/i.test(raw)) {
    return { status: "running", phase: /^(scheduled|started)$/i.test(raw) ? raw : null };
  }
  return { status: raw === "terminal" ? "completed" : raw, phase: null };
}

// The workflow's final message is a runtime envelope:
// <workflow-launch-reconciled>{… "final_summary": {"status", "summary"}, "latest_failure": …}</…>.
// Show its summary (or failure), never the raw JSON.
export function workflowMessageText(message: string | undefined): string | null {
  const raw = message?.trim();
  if (!raw) return null;
  const envelope = raw.match(/^<([a-z-]+)>([\s\S]*)<\/\1>$/);
  if (!envelope) return raw;
  try {
    const data = JSON.parse(envelope[2]!) as { final_summary?: { summary?: string } | null; latest_failure?: unknown };
    const summary = data.final_summary?.summary?.trim();
    if (summary) return summary;
    const failure = data.latest_failure;
    if (typeof failure === "string" && failure.trim()) return failure.trim();
    if (failure && typeof failure === "object") {
      const text = (failure as Record<string, unknown>).message ?? (failure as Record<string, unknown>).summary;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A workflow/subagent item as one transcript row (stored as JSON, updated in
 * place). `previous` is the stored row: muse names a child (`label`) only on
 * its first update, so names carry over.
 */
export function pilotAgentsRow(item: PilotItem | undefined, previous: AgentsRow | null = null): AgentsRow | null {
  if (!item || (item.kind !== "workflow" && item.kind !== "subagent")) return null;
  if (item.kind === "workflow") {
    const knownLabels = new Map((previous?.children ?? []).map((child) => [child.id, child.label]));
    // A child can appear once per attempt; show its latest attempt.
    const latest = new Map<string, NonNullable<PilotItem["children"]>[number]>();
    for (const child of item.children ?? []) {
      if (!child?.childId) continue;
      if (child.label?.trim()) knownLabels.set(child.childId, child.label.trim());
      const prev = latest.get(child.childId);
      if (!prev || (child.attempt ?? 1) >= (prev.attempt ?? 1)) latest.set(child.childId, child);
    }
    return {
      kind: "workflow",
      title: item.entryId?.trim() || item.fallbackText?.trim() || "Workflow",
      status: item.status ?? "inProgress",
      message: workflowMessageText(item.message)?.slice(0, AGENTS_TEXT_MAX) ?? previous?.message ?? null,
      workflowRunId: item.workflowRunId ?? previous?.workflowRunId ?? null,
      subagentId: null,
      children: [...latest.values()].map((child, index) => {
        const { status, phase } = childStatus(child);
        return {
          id: child.childId!,
          label: knownLabels.get(child.childId!) || `helper ${index + 1}`,
          status,
          phase,
          attempt: child.attempt ?? 1,
          durationMs: typeof child.durationMs === "number" ? child.durationMs : null,
        };
      }),
    };
  }
  const result = item.result?.summary?.trim() || item.result?.text?.trim() || item.failureReason?.trim() || null;
  return {
    kind: "subagent",
    title: item.objective?.trim() || item.fallbackText?.trim() || "Helper",
    status: item.status ?? "inProgress",
    message: result ? result.slice(0, AGENTS_TEXT_MAX) : previous?.message ?? null,
    workflowRunId: null,
    subagentId: item.subagentId ?? null,
    children: [],
  };
}

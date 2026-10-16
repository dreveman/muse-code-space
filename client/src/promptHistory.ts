// Pure helpers for browsing previous user prompts in the composer with
// ArrowUp (at position 0) and ArrowDown (at the last position).

export type PromptHistoryEvent = {
  kind: string;
  content: string;
};

export type PromptHistoryState = {
  /** Index into the history array, or null when editing the live draft. */
  index: number | null;
  /** The unsent draft saved when entering history browsing mode. */
  draft: string;
};

export const INITIAL_PROMPT_HISTORY_STATE: PromptHistoryState = {
  index: null,
  draft: "",
};

const LEGACY_MODEL_HEADER = /^\[Model:\s*[^\]]+\]\r?\n\r?\n/;

export function cleanUserPromptText(content: string): string {
  return content.replace(LEGACY_MODEL_HEADER, "").trim();
}

/**
 * Builds an ordered list of user prompts (oldest to newest), collapsing
 * consecutive identical entries so stepping backward/forward never appears
 * stuck on the same text twice in a row.
 */
export function buildPromptHistory(
  transcriptEvents: readonly PromptHistoryEvent[],
  extraPrompts: readonly string[] = [],
): string[] {
  const result: string[] = [];
  const push = (raw: string) => {
    const text = cleanUserPromptText(raw);
    if (!text) return;
    if (result[result.length - 1] !== text) result.push(text);
  };
  for (const event of transcriptEvents) {
    if (event.kind === "user") push(event.content);
  }
  for (const prompt of extraPrompts) {
    push(prompt);
  }
  return result;
}

export function navigatePromptHistory(args: {
  state: PromptHistoryState;
  key: "ArrowUp" | "ArrowDown";
  currentText: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  history: readonly string[];
}): { state: PromptHistoryState; value: string; caret: number } | null {
  const { state, key, currentText, selectionStart, selectionEnd, history } = args;
  const start = selectionStart ?? 0;
  const end = selectionEnd ?? start;
  if (start !== end) return null;

  if (key === "ArrowUp") {
    if (start !== 0 || history.length === 0) return null;
    if (state.index === null) {
      let index = history.length - 1;
      if (history[index] === currentText) {
        if (index === 0) return null;
        index -= 1;
      }
      const value = history[index]!;
      return {
        state: { index, draft: currentText },
        value,
        caret: 0,
      };
    }
    if (state.index <= 0) return null;
    const index = state.index - 1;
    const value = history[index]!;
    return {
      state: { index, draft: state.draft },
      value,
      caret: 0,
    };
  }

  // ArrowDown: only when at the last position in the input area.
  if (start !== currentText.length || state.index === null) return null;
  if (state.index < history.length - 1) {
    const index = state.index + 1;
    const value = history[index]!;
    return {
      state: { index, draft: state.draft },
      value,
      caret: value.length,
    };
  }
  return {
    state: INITIAL_PROMPT_HISTORY_STATE,
    value: state.draft,
    caret: state.draft.length,
  };
}

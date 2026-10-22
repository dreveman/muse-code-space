// Selection guidance and answer readiness for the pending question card.
// The server rejects incomplete or out-of-range answers with raw question
// ids; the card instead guides the user up front and only enables Send
// once every question has a valid answer.

export type UserInputQuestionLike = {
  id: string;
  selection: { mode: string; minSelections?: number; maxSelections?: number };
  options?: Array<{ label: string }> | null;
};

function selectionBounds(question: UserInputQuestionLike): { min: number; max: number } {
  const multiple = question.selection.mode === "multiple";
  if (!multiple) return { min: 1, max: 1 };
  const optionCount = question.options?.length ?? 0;
  const min = question.selection.minSelections ?? 1;
  const max = question.selection.maxSelections ?? Math.max(optionCount, min);
  return { min, max };
}

export function questionSelectionHint(question: UserInputQuestionLike): string {
  const options = question.options ?? [];
  if (options.length === 0) return "Write your answer";
  if (question.selection.mode !== "multiple") return "Pick one";
  const { min, max } = selectionBounds(question);
  const hasMin = question.selection.minSelections != null;
  const hasMax = question.selection.maxSelections != null;
  if (hasMin && hasMax) return min === max ? `Pick ${min}` : `Pick ${min}–${max}`;
  if (hasMax) return `Pick up to ${max}`;
  if (hasMin) return `Pick at least ${min}`;
  return min === max ? `Pick ${min}` : `Pick ${min}–${max}`;
}

export function questionAnswered(
  question: UserInputQuestionLike,
  picked: readonly string[],
  freeText: string,
): boolean {
  if (freeText.trim().length > 0) return true;
  if (picked.length === 0) return false;
  const { min, max } = selectionBounds(question);
  return picked.length >= min && picked.length <= max;
}

export function userInputReadiness(
  questions: readonly UserInputQuestionLike[],
  picked: Record<string, string[]>,
  free: Record<string, string>,
): { ready: boolean; answered: number; total: number; firstUnanswered: number } {
  let answered = 0;
  let firstUnanswered = -1;
  questions.forEach((question, index) => {
    if (questionAnswered(question, picked[question.id] ?? [], free[question.id] ?? "")) {
      answered += 1;
    } else if (firstUnanswered === -1) {
      firstUnanswered = index;
    }
  });
  return { ready: answered === questions.length, answered, total: questions.length, firstUnanswered };
}

import { fileToBase64 } from "@hatch/space-sdk/client";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { ApiResponse, api } from "./api";
import { ScratchpadTabIcon, type ScratchpadAttachmentPayload, type ScratchpadBackground, type ScratchpadTargetStep } from "./ScratchpadPanel";
import { questionAnswered, questionSelectionHint, userInputReadiness } from "./userInputCard";

type PendingUserInput = ApiResponse<typeof api, "getPendingUserInputs">["inputs"][number];

export type RichUserInputAnswerSelection = {
  questionId: string;
  selectedLabels?: string[];
  freeText?: string;
  attachment?: {
    name: string;
    mediaType: string;
    base64Data: string;
  };
};

export function isRichUserInput(input: PendingUserInput): boolean {
  if (input.rich === true) return true;
  return input.questions.some(
    (q) => q.kind === "sketch" || q.kind === "image" || q.kind === "text" || q.canvasPreset !== undefined,
  );
}

export function RichUserInputCard({
  input,
  busy,
  error,
  stepAttachments,
  onAttachStepImage,
  onClearStepImage,
  onOpenScratchpadForStep,
  onAnswer,
  onCancel,
}: {
  input: PendingUserInput;
  busy: boolean;
  error: string | null;
  stepAttachments: Record<string, ScratchpadAttachmentPayload>;
  onAttachStepImage: (questionId: string, payload: ScratchpadAttachmentPayload) => void;
  onClearStepImage: (questionId: string) => void;
  onOpenScratchpadForStep: (target: ScratchpadTargetStep, background?: ScratchpadBackground) => void;
  onAnswer: (userInputId: string, selections: RichUserInputAnswerSelection[]) => void;
  onCancel: (userInputId: string) => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  const totalSteps = input.questions.length;
  const clampedIndex = Math.min(Math.max(0, stepIndex), Math.max(0, totalSteps - 1));
  const question = input.questions[clampedIndex];

  useEffect(() => {
    if (stepIndex >= totalSteps && totalSteps > 0) {
      setStepIndex(totalSteps - 1);
    }
  }, [stepIndex, totalSteps]);

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

  const readiness = userInputReadiness(input.questions, picked, free, stepAttachments);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>, questionId: string) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const encoded = await fileToBase64(file);
      const base64Data = encoded.dataBase64;
      const dataUrl = `data:${encoded.mimeType || file.type};base64,${base64Data}`;
      onAttachStepImage(questionId, {
        name: file.name || `image-${Date.now()}.png`,
        mediaType: "image/png",
        base64Data,
        dataUrl,
      });
    } catch { /* ignore unreadable file */ }
  };

  const submit = () => {
    if (!readiness.ready) return;
    onAnswer(
      input.userInputId,
      input.questions.map((q) => {
        const att = stepAttachments[q.id];
        return {
          questionId: q.id,
          selectedLabels: picked[q.id] ?? [],
          freeText: free[q.id] ?? "",
          ...(att
            ? {
                attachment: {
                  name: att.name,
                  mediaType: att.mediaType,
                  base64Data: att.base64Data,
                },
              }
            : {}),
        };
      }),
    );
  };

  if (!question) return null;

  const kind = question.kind ?? ((question.options ?? []).length > 0 ? "choice" : "text");
  const multiple = question.selection.mode === "multiple";
  const currentAttachment = stepAttachments[question.id] ?? null;
  const currentAnswered = questionAnswered(
    question,
    picked[question.id] ?? [],
    free[question.id] ?? "",
    Boolean(currentAttachment),
  );
  const hintId = `rich-user-input-hint-${input.userInputId}-${question.id}`;

  return (
    <div className="user-input-card rich-user-input-card" role="group" aria-label={input.title || "Companion multi-step input"}>
      <div className="rich-user-input-header">
        <p className="eyebrow">{input.title || "Rich input needed"}</p>
        {totalSteps > 1 && (
          <div className="rich-user-input-steps" role="tablist" aria-label="Input steps">
            {input.questions.map((q, idx) => {
              const stepDone = questionAnswered(
                q,
                picked[q.id] ?? [],
                free[q.id] ?? "",
                Boolean(stepAttachments[q.id]),
              );
              const isCurrent = idx === clampedIndex;
              return (
                <button
                  key={q.id}
                  type="button"
                  role="tab"
                  aria-selected={isCurrent}
                  className={`rich-user-input-step-pill${isCurrent ? " is-current" : ""}${stepDone ? " is-done" : ""}`}
                  onClick={() => setStepIndex(idx)}
                >
                  <span className="rich-step-num">{stepDone && !isCurrent ? "✓" : idx + 1}</span>
                  <span className="rich-step-label">{q.header || `Step ${idx + 1}`}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="user-input-questions" role="region" aria-label="Active step">
        <fieldset className={`user-input-question-block${currentAnswered ? " is-answered" : ""}`} aria-describedby={hintId}>
          <legend className="user-input-question">
            {totalSteps > 1 && <span className="user-input-count">Step {clampedIndex + 1} of {totalSteps} · </span>}
            {question.header && question.question && <span className="user-input-header">{question.header} · </span>}
            {question.question || question.header || "Question"}
          </legend>
          <p id={hintId} className="user-input-hint">
            {questionSelectionHint(question)}
            {question.required === false ? " · Optional" : ""}
            {currentAnswered ? " · Answered" : ""}
          </p>

          {(kind === "sketch" || kind === "image") && (
            <div className="rich-user-input-media-box">
              <div className="rich-user-input-media-actions">
                <button
                  type="button"
                  className="rich-scratchpad-open-btn"
                  disabled={busy}
                  onClick={() =>
                    onOpenScratchpadForStep(
                      {
                        userInputId: input.userInputId,
                        questionId: question.id,
                        header: question.header || `Step ${clampedIndex + 1}`,
                      },
                      question.canvasPreset?.background,
                    )
                  }
                >
                  <ScratchpadTabIcon />
                  <span>{currentAttachment ? "Edit in Scratchpad" : "Open Scratchpad to draw"}</span>
                </button>

                <label htmlFor={fileInputId} className="rich-image-upload-btn">
                  <span>{currentAttachment ? "Replace image…" : "Upload image…"}</span>
                </label>
                <input
                  ref={fileInputRef}
                  id={fileInputId}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  disabled={busy}
                  onChange={(e) => void handleFileChange(e, question.id)}
                />
              </div>

              {currentAttachment && (
                <div className="rich-user-input-preview">
                  <img src={currentAttachment.dataUrl} alt={currentAttachment.name} />
                  <div className="rich-user-input-preview-meta">
                    <span>{currentAttachment.name}</span>
                    <button
                      type="button"
                      className="rich-user-input-remove-btn"
                      onClick={() => onClearStepImage(question.id)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}

              <label className={`user-input-other${(free[question.id] ?? "").trim() ? " is-selected" : ""}`}>
                <span className="user-input-other-label">Notes or caption (optional)</span>
                <input
                  className="user-input-free"
                  placeholder={question.placeholder || "Add context about your sketch or image…"}
                  value={free[question.id] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFree((current) => ({ ...current, [question.id]: value }));
                  }}
                  maxLength={1000}
                  disabled={busy}
                />
              </label>
            </div>
          )}

          {kind === "choice" && (question.options ?? []).length > 0 && (
            <>
              <div className="user-input-options" role={multiple ? "group" : "radiogroup"} aria-label={question.header || question.question || question.id}>
                {(question.options ?? []).map((option) => {
                  const selected = (picked[question.id] ?? []).includes(option.label);
                  const maxSelections = question.selection.maxSelections ?? (question.options ?? []).length;
                  const atMax = multiple && !selected && (picked[question.id] ?? []).length >= maxSelections;
                  return (
                    <label key={option.label} className={`user-input-option${selected ? " is-selected" : ""}${atMax ? " is-disabled" : ""}`}>
                      <input
                        type={multiple ? "checkbox" : "radio"}
                        name={`rich-user-input-${input.userInputId}-${question.id}`}
                        checked={selected}
                        onChange={() => toggleOption(question.id, option.label, multiple)}
                        disabled={busy || atMax}
                      />
                      <span>
                        <span className="user-input-option-label">{option.label}</span>
                        {option.description && <span className="user-input-option-desc">{option.description}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
              <label className={`user-input-other${(free[question.id] ?? "").trim() ? " is-selected" : ""}`}>
                <span className="user-input-other-label">Other answer</span>
                <input
                  className="user-input-free"
                  placeholder={question.placeholder || "Write your own answer…"}
                  value={free[question.id] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFree((current) => ({ ...current, [question.id]: value }));
                    if (value.trim()) setPicked((current) => ({ ...current, [question.id]: [] }));
                  }}
                  maxLength={1000}
                  disabled={busy}
                />
              </label>
            </>
          )}

          {kind === "text" && (
            <label className={`user-input-other is-multiline${(free[question.id] ?? "").trim() ? " is-selected" : ""}`}>
              <textarea
                className="user-input-free rich-user-input-textarea"
                rows={3}
                placeholder={question.placeholder || "Write your answer…"}
                value={free[question.id] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setFree((current) => ({ ...current, [question.id]: value }));
                }}
                maxLength={2000}
                disabled={busy}
              />
            </label>
          )}
        </fieldset>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="user-input-actions rich-user-input-actions">
        <span className="user-input-status" role="status">
          {readiness.ready ? "All steps ready" : `${readiness.answered} of ${readiness.total} steps answered`}
        </span>
        <div className="rich-user-input-nav">
          <button
            type="button"
            className="user-input-skip"
            onClick={() => onCancel(input.userInputId)}
            disabled={busy}
          >
            Skip
          </button>
          {clampedIndex > 0 && (
            <button
              type="button"
              className="user-input-skip"
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              disabled={busy}
            >
              Back
            </button>
          )}
          {clampedIndex < totalSteps - 1 ? (
            <button
              type="button"
              className="user-input-submit"
              onClick={() => setStepIndex((i) => Math.min(totalSteps - 1, i + 1))}
              disabled={busy}
            >
              Next step
            </button>
          ) : (
            <button
              type="button"
              className="user-input-submit"
              onClick={submit}
              disabled={busy || !readiness.ready}
            >
              {busy ? "Sending…" : "Send answers"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

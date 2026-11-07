import { fileToBase64 } from "@hatch/space-sdk/client";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { ApiResponse, api } from "./api";
import {
  ScratchpadTabIcon,
  type ScratchpadAttachmentPayload,
  type ScratchpadBackground,
  type ScratchpadBaseImage,
  type ScratchpadTargetStep,
} from "./ScratchpadPanel";
import { questionAnswered, questionSelectionHint, userInputReadiness } from "./userInputCard";

function RichAttachmentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

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
    (q) =>
      q.kind === "file" ||
      q.kind === "embed" ||
      q.kind === "sketch" ||
      q.kind === "image" ||
      q.kind === "text" ||
      q.embed !== undefined ||
      q.canvasPreset !== undefined,
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
  onCancel: _onCancel,
}: {
  input: PendingUserInput;
  busy: boolean;
  error: string | null;
  stepAttachments: Record<string, ScratchpadAttachmentPayload>;
  onAttachStepImage: (questionId: string, payload: ScratchpadAttachmentPayload) => void;
  onClearStepImage: (questionId: string) => void;
  onOpenScratchpadForStep: (
    target: ScratchpadTargetStep,
    background?: ScratchpadBackground,
    baseImage?: ScratchpadBaseImage | null,
  ) => void;
  onAnswer: (userInputId: string, selections: RichUserInputAnswerSelection[]) => void;
  onCancel: (userInputId: string) => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
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
    setSkipped((current) => ({ ...current, [questionId]: false }));
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

  const effectiveQuestions = input.questions.map((q) =>
    skipped[q.id] ? { ...q, required: false } : q,
  );
  const readiness = userInputReadiness(effectiveQuestions, picked, free, stepAttachments);

  const handleFile = async (file: File, questionId: string) => {
    const isAllowed =
      file.type.startsWith("image/") ||
      file.type.startsWith("text/") ||
      file.type === "application/pdf" ||
      file.type === "application/json" ||
      /\.(png|jpe?g|gif|webp|svg|pdf|txt|md|json|csv|ts|tsx|js|jsx|py|rs|go|html|css)$/i.test(file.name);
    if (!isAllowed) return;
    try {
      const encoded = await fileToBase64(file);
      const base64Data = encoded.dataBase64;
      const mimeType =
        encoded.mimeType ||
        file.type ||
        (/\.pdf$/i.test(file.name) ? "application/pdf" : /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name) ? "image/png" : "text/plain");
      const dataUrl = `data:${mimeType};base64,${base64Data}`;
      onAttachStepImage(questionId, {
        name: file.name || `upload-${Date.now()}`,
        mediaType: mimeType,
        base64Data,
        dataUrl,
      });
    } catch { /* ignore unreadable file */ }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>, questionId: string) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await handleFile(file, questionId);
  };

  const sendAnswers = (
    pickedState: Record<string, string[]>,
    freeState: Record<string, string>,
    skippedState: Record<string, boolean>,
  ) => {
    onAnswer(
      input.userInputId,
      input.questions.map((q) => {
        if (skippedState[q.id]) {
          return {
            questionId: q.id,
            selectedLabels: [],
            freeText: "",
          };
        }
        const att = stepAttachments[q.id];
        return {
          questionId: q.id,
          selectedLabels: pickedState[q.id] ?? [],
          freeText: freeState[q.id] ?? "",
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

  const submit = () => {
    if (!readiness.ready) return;
    sendAnswers(picked, free, skipped);
  };

  const skipCurrentStep = () => {
    if (!question) return;
    const nextPicked = { ...picked, [question.id]: [] };
    const nextFree = { ...free, [question.id]: "" };
    const nextSkipped = { ...skipped, [question.id]: true };
    setPicked(nextPicked);
    setFree(nextFree);
    setSkipped(nextSkipped);
    onClearStepImage(question.id);
    if (clampedIndex < totalSteps - 1) {
      setStepIndex(clampedIndex + 1);
      return;
    }
    const nextEffective = input.questions.map((q) =>
      nextSkipped[q.id] ? { ...q, required: false } : q,
    );
    const nextReadiness = userInputReadiness(
      nextEffective,
      nextPicked,
      nextFree,
      stepAttachments,
    );
    if (nextReadiness.ready) {
      sendAnswers(nextPicked, nextFree, nextSkipped);
    } else if (nextReadiness.firstUnanswered >= 0) {
      setStepIndex(nextReadiness.firstUnanswered);
    }
  };

  if (!question) return null;

  const rawKind = question.kind ?? ((question.options ?? []).length > 0 ? "choice" : "text");
  const isKnownScratchpadEmbed =
    rawKind === "sketch" ||
    (rawKind === "embed" && (!question.embed?.type || question.embed.type === "scratchpad" || Boolean(question.canvasPreset)));
  const isUnknownEmbed = rawKind === "embed" && !isKnownScratchpadEmbed;
  const isFileKind = rawKind === "file" || rawKind === "image";
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
    <div
      className="user-input-card rich-user-input-card"
      role="group"
      aria-label={input.title || "Companion rich form"}
      onPaste={(event) => {
        if (busy || (!isFileKind && !isKnownScratchpadEmbed)) return;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files[0]) {
          event.preventDefault();
          void handleFile(files[0], question.id);
        }
      }}
    >
      <div className="rich-user-input-header">
        <p className="eyebrow">{input.title || "Input needed"}</p>
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

          {(isFileKind || isKnownScratchpadEmbed) && (
            <div className="rich-user-input-media-box">
              {currentAttachment ? (
                currentAttachment.mediaType.startsWith("image/") ? (
                  <div className="composer-attachments rich-step-attachments" aria-label="Attached step image">
                    <div className="composer-attachment-card">
                      <img
                        src={currentAttachment.dataUrl}
                        alt={currentAttachment.name}
                        className="composer-attachment-image"
                        title={`Annotate ${currentAttachment.name} in Scratchpad`}
                        onClick={() =>
                          onOpenScratchpadForStep(
                            {
                              userInputId: input.userInputId,
                              questionId: question.id,
                              header: question.header || `Step ${clampedIndex + 1}`,
                            },
                            question.embed?.background ?? question.canvasPreset?.background,
                            { src: currentAttachment.dataUrl, name: currentAttachment.name },
                          )
                        }
                      />
                      <button
                        type="button"
                        className="composer-attachment-annotate"
                        disabled={busy}
                        aria-label={`Annotate ${currentAttachment.name} in Scratchpad`}
                        title={`Annotate ${currentAttachment.name} in Scratchpad`}
                        onClick={() =>
                          onOpenScratchpadForStep(
                            {
                              userInputId: input.userInputId,
                              questionId: question.id,
                              header: question.header || `Step ${clampedIndex + 1}`,
                            },
                            question.embed?.background ?? question.canvasPreset?.background,
                            { src: currentAttachment.dataUrl, name: currentAttachment.name },
                          )
                        }
                      >
                        <ScratchpadTabIcon />
                      </button>
                      <button
                        type="button"
                        className="composer-attachment-remove"
                        disabled={busy}
                        onClick={() => onClearStepImage(question.id)}
                        aria-label={`Remove ${currentAttachment.name}`}
                        title={`Remove ${currentAttachment.name}`}
                      >
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rich-user-input-preview">
                    <div className="rich-user-input-preview-meta">
                      <span>{currentAttachment.name} ({currentAttachment.mediaType})</span>
                      <button
                        type="button"
                        className="composer-attachment-remove rich-file-remove-inline"
                        onClick={() => onClearStepImage(question.id)}
                        disabled={busy}
                        aria-label={`Remove ${currentAttachment.name}`}
                        title={`Remove ${currentAttachment.name}`}
                      >
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )
              ) : (
                <div className="rich-user-input-media-actions">
                  <label htmlFor={fileInputId} className="rich-image-upload-btn">
                    <RichAttachmentIcon />
                    <span>Attach image</span>
                  </label>
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
                        question.embed?.background ?? question.canvasPreset?.background,
                        null,
                      )
                    }
                  >
                    <ScratchpadTabIcon />
                    <span>Scratchpad</span>
                  </button>
                </div>
              )}

              <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                accept="image/*,application/pdf,text/*,.md,.txt,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.html,.css"
                style={{ display: "none" }}
                disabled={busy}
                onChange={(e) => void handleFileChange(e, question.id)}
              />

              <label className={`user-input-other${(free[question.id] ?? "").trim() ? " is-selected" : ""}`}>
                <span className="user-input-other-label">{isKnownScratchpadEmbed ? "Or write your answer / notes" : "Notes or caption (optional)"}</span>
                <input
                  className="user-input-free"
                  placeholder={question.placeholder || "Add context or write your answer…"}
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

          {rawKind === "choice" && (question.options ?? []).length > 0 && (
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

          {(rawKind === "text" || isUnknownEmbed) && (
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

      <div className="user-input-actions">
        <span className="user-input-status" role="status">
          {readiness.ready ? "Ready to send" : `${readiness.answered} of ${readiness.total} answered`}
        </span>
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
            Next
          </button>
        ) : (
          <button
            type="button"
            className="user-input-submit"
            onClick={submit}
            disabled={busy || !readiness.ready}
          >
            {busy ? "Sending…" : "Send answer"}
          </button>
        )}
        <button
          type="button"
          className="user-input-skip"
          onClick={skipCurrentStep}
          disabled={busy}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

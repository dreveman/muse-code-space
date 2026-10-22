import { memo } from "react";
import type { UserInputPreview } from "./toolPresentation";

// Formatted view of one request_user_input call: the questions as asked,
// with the user's answers marked once the completed output carries them.
// While the agent is still waiting it shows the questions unmarked — the
// actionable card under the transcript is where answers are given.
export const ToolUserInputView = memo(function ToolUserInputView({ preview }: { preview: UserInputPreview }) {
  return (
    <div className="tool-user-input">
      <div className="tool-diff-caption">
        {preview.total} {preview.total === 1 ? "question" : "questions"}
        {preview.answered > 0 ? ` · ${preview.answered} answered` : " · waiting for your answer"}
      </div>
      {preview.questions.map((question) => (
        <div key={question.id} className="tool-user-input-question">
          <div className="tool-user-input-heading">
            {question.header && <span className="tool-user-input-header">{question.header}</span>}
            <span className="tool-user-input-mode">{question.mode === "multiple" ? "Multiple choice" : "Single choice"}</span>
          </div>
          <p className="tool-user-input-text">{question.question}</p>
          {question.options.length > 0 && (
            <div className="tool-user-input-options">
              {question.options.map((option) => {
                const selected = question.answer?.labels.includes(option.label) ?? false;
                return (
                  <div key={option.label} className={`tool-user-input-option${selected ? " is-selected" : ""}`}>
                    <span className="tool-user-input-marker" aria-hidden="true">{selected ? "●" : "○"}</span>
                    <span className="tool-user-input-option-body">
                      <span className="tool-user-input-option-label">
                        {option.label}
                        {selected && <span className="tool-user-input-answer-tag">Your answer</span>}
                      </span>
                      {option.description && <span className="tool-user-input-option-desc">{option.description}</span>}
                      {selected && option.preview && <span className="tool-user-input-preview">{option.preview}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {question.answer?.freeText && (
            <div className="tool-user-input-answer">
              <span className="tool-user-input-answer-tag">Your answer</span>
              <p>{question.answer.freeText}</p>
            </div>
          )}
          {question.answer?.note && <p className="tool-user-input-note">Note: {question.answer.note}</p>}
        </div>
      ))}
    </div>
  );
});

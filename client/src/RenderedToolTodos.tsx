import { memo } from "react";
import type { TodoStatus, TodosPreview } from "./toolPresentation";

const GLYPHS: Record<TodoStatus, string> = {
  completed: "✓",
  in_progress: "●",
  pending: "○",
  cancelled: "✕",
};
const LABELS: Record<TodoStatus, string> = {
  completed: "Completed",
  in_progress: "In progress",
  pending: "Pending",
  cancelled: "Cancelled",
};
const CLASSES: Record<TodoStatus, string> = {
  completed: "is-completed",
  in_progress: "is-active",
  pending: "is-pending",
  cancelled: "is-cancelled",
};

// Snapshot of one write_todos call: the plan exactly as submitted in that
// call's args. Later calls replace the list; rows are never merged.
export const ToolTodosView = memo(function ToolTodosView({ preview }: { preview: TodosPreview }) {
  return (
    <div className="tool-todos">
      <div className="tool-diff-caption">
        {preview.total} {preview.total === 1 ? "item" : "items"} · {preview.done} done
        {preview.active ? ` · active: ${preview.active.text}` : ""}
      </div>
      <div className="tool-todos-list" role="list" aria-label="Plan items">
        {preview.items.map((item, index) => (
          <div
            key={index}
            role="listitem"
            aria-label={`${LABELS[item.status]}: ${item.text}`}
            className={`tool-todos-item ${CLASSES[item.status]}`}
            data-status={item.status}
          >
            <span className="tool-todos-glyph" aria-hidden="true">{GLYPHS[item.status]}</span>
            <span className="tool-todos-text">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

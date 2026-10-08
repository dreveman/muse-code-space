// In-app dialogs. Native window.prompt/confirm/alert are never used: the
// host shows the app in a sandboxed iframe that can block them, and they
// can't match the app's look.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

// Backdrop + panel: Escape or a click outside cancels (unless busy), and the
// element marked data-autofocus gets focus once, when the dialog opens.
function DialogShell({ role = "dialog", labelledBy, describedBy, busy, onCancel, children }: {
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  busy: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // The app re-renders often (polling): keep the latest callbacks without
  // re-running the effect, so focus is only set when the dialog opens.
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };
  useEffect(() => {
    const target = panelRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    target?.focus();
    if (target instanceof HTMLInputElement) target.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !latest.current.busy) latest.current.onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div ref={panelRef} className="confirm-dialog" role={role} aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy}>
        {children}
      </div>
    </div>
  );
}

// Permanent delete needs a deliberate yes and must say it can't be undone.
// Cancel has focus.
export function ConfirmDeleteDialog({ title, busy, error, onCancel, onConfirm }: {
  title: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell role="alertdialog" labelledBy="delete-dialog-title" describedBy="delete-dialog-body" busy={busy} onCancel={onCancel}>
      <h2 id="delete-dialog-title">Delete task permanently?</h2>
      <p id="delete-dialog-body">
        The task “{title}” and its conversation will be deleted.
        <br />
        <strong>This can’t be undone.</strong>
      </p>
      <p className="confirm-dialog-note">Files in the task’s working directory are kept.</p>
      {error && <p className="confirm-dialog-error" role="alert">{error}</p>}
      <div className="confirm-dialog-actions">
        <button type="button" className="confirm-dialog-cancel" onClick={onCancel} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className="confirm-dialog-delete" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </DialogShell>
  );
}

export type TextPromptSpec = {
  title: string;
  description?: string;
  label: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel: string;
  maxLength: number;
  allowEmpty?: boolean;
  /** Returns an error to show in the dialog, or null to close it. */
  onSubmit: (value: string) => Promise<string | null> | string | null;
};

// One-field form (rename, new project, working directory). Enter submits;
// the value is selected on open; errors keep the dialog open.
export function TextPromptDialog({ spec, onClose }: { spec: TextPromptSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await spec.onSubmit(value);
      if (failure) setError(failure);
      else onClose();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogShell labelledBy="text-dialog-title" describedBy={spec.description ? "text-dialog-body" : undefined} busy={busy} onCancel={onClose}>
      <form onSubmit={submit}>
        <h2 id="text-dialog-title">{spec.title}</h2>
        {spec.description && <p id="text-dialog-body">{spec.description}</p>}
        <label className="dialog-field">
          <span>{spec.label}</span>
          <input
            type="text"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder={spec.placeholder}
            maxLength={spec.maxLength}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            data-autofocus
          />
        </label>
        {error && <p className="confirm-dialog-error" role="alert">{error}</p>}
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="confirm-dialog-primary" disabled={busy || (!spec.allowEmpty && value.trim().length === 0)}>
            {busy ? "Saving…" : spec.confirmLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

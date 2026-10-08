import { useEffect, useId, useRef, useState } from "react";
import type { SortMode } from "./sessionList";

const OPTIONS: Array<{ value: SortMode; label: string; subtitle: string }> = [
  { value: "priority", label: "Priority", subtitle: "Needs you first, then finished -> working -> idle" },
  { value: "updated", label: "Updated", subtitle: "Last prompt or reply first" },
  { value: "created", label: "Created", subtitle: "Newest agent first" },
];

export function SortMenu({ value, onChange }: { value: SortMode; onChange: (mode: SortMode) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = OPTIONS.find((option) => option.value === value)?.label ?? "Priority";

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  return (
    <div className="sort-menu-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sort-trigger"
        aria-label={`Sort by ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((previous) => !previous)}
      >
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4 5h12M6 10h8M8 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span>{label}</span>
        <svg className="sort-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={menuId} className="sort-menu" role="menu" aria-label="Sort agents by">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={`sort-option${option.value === value ? " selected" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="sort-option-title">{option.label}</span>
              <span className="sort-option-subtitle">{option.subtitle}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

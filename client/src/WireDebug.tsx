import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { type ColorMode } from "./colorMode";
import { RelayDebugPanel } from "./RelayDebug";

type WireEntry = {
  at: string;
  dir: string;
  method: string;
  ms?: number;
  ok?: boolean;
  params?: string;
  error?: string;
};

type PopoverPosition = {
  top: number;
  right: number;
  width: number;
};

type SettingsMenuItemProps = {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  onActivate: () => void;
};

export type SessionMenuAction = {
  key: string;
  label: string;
  description: string;
  disabled?: boolean;
  checked?: boolean;
  radio?: boolean;
  onActivate: () => void;
};

export const UI_BUILD_ID = "2026-10-19.v3";

const COLOR_MODE_OPTIONS: Array<{ value: ColorMode; label: string; description: string }> = [
  { value: "system", label: "System default", description: "Follow this device's appearance" },
  { value: "light", label: "Light", description: "Always use the light palette" },
  { value: "dark", label: "Dark", description: "Always use the dark palette" },
];

function ActionMenuItem({ action, onDone }: { action: SessionMenuAction; onDone: () => void }) {
  return (
    <button
      type="button"
      className="wire-settings-item session-menu-action"
      role={action.radio ? "menuitemradio" : action.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={action.checked}
      disabled={action.disabled}
      onClick={() => {
        if (action.checked === undefined) onDone();
        action.onActivate();
      }}
    >
      <span className="wire-settings-item-copy">
        <span className="wire-settings-item-label">{action.label}</span>
        <span className="wire-settings-item-description">{action.description}</span>
      </span>
      {action.radio ? (
        <span className="session-menu-radio-mark" aria-hidden="true">{action.checked ? "✓" : ""}</span>
      ) : action.checked !== undefined && (
        <span className={`wire-settings-switch${action.checked ? " active" : ""}`} aria-hidden="true"><span /></span>
      )}
    </button>
  );
}

function entryDirection(entry: WireEntry): "out" | "in" {
  return entry.dir === "→" ? "out" : "in";
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
      <path d="M3.5 5.25h13M3.5 10h13M3.5 14.75h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SettingsMenuItem({ label, description, checked, disabled = false, trailing, onActivate }: SettingsMenuItemProps) {
  return (
    <button
      type="button"
      className="wire-settings-item"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onActivate}
    >
      <span className="wire-settings-item-copy">
        <span className="wire-settings-item-label">{label}</span>
        <span className="wire-settings-item-description">{description}</span>
      </span>
      {trailing ?? (
        <span className={`wire-settings-switch${checked ? " active" : ""}`} aria-hidden="true">
          <span />
        </span>
      )}
    </button>
  );
}

// The transcript header's burger menu: view preferences, session actions
// (the touch-friendly path to rename/archive), and the wire-log toggle.
export function SessionMenu({ actions = [], colorMode, onColorModeChange, showRawToolOutput, onToggleRawToolOutput }: {
  actions?: SessionMenuAction[];
  colorMode: ColorMode;
  onColorModeChange: (mode: ColorMode) => void;
  showRawToolOutput: boolean;
  onToggleRawToolOutput: () => void;
}) {
  const [panelVisible, setPanelVisible] = useState(false);
  const [relayVisible, setRelayVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({ top: 48, right: 12, width: 560 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wireBodyRef = useRef<HTMLDivElement>(null);
  const followWireRef = useRef(true);
  const menuId = useId();

  const wireQuery = useQuery({
    queryKey: ["wireDebug"],
    queryFn: () => api.getWireDebug({}),
    enabled: panelVisible,
    refetchInterval: panelVisible ? 2000 : false,
  });
  const relayQuery = useQuery({
    queryKey: ["relayDebug"],
    queryFn: () => api.getRelayDebug({}),
    enabled: relayVisible,
    refetchInterval: relayVisible ? 2000 : false,
  });

  const entries: WireEntry[] = wireQuery.data?.ok === true ? wireQuery.data.entries : [];
  const readError = wireQuery.data?.ok === false ? wireQuery.data.error : null;
  const showPopover = menuOpen || panelVisible || relayVisible;

  // Wire entries arrive oldest first. Follow the bottom when the log opens
  // or the user is already there; don't interrupt someone reading history.
  useLayoutEffect(() => {
    if (panelVisible && followWireRef.current && wireBodyRef.current) {
      wireBodyRef.current.scrollTop = wireBodyRef.current.scrollHeight;
    }
  }, [panelVisible, wireQuery.data?.entries]);

  useEffect(() => {
    if (!showPopover) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 12;
      const viewportWidth = window.innerWidth;
      const width = Math.min(560, Math.max(0, viewportWidth - (margin * 2)));
      const maxRight = Math.max(margin, viewportWidth - margin - width);
      const right = Math.min(Math.max(viewportWidth - rect.right, margin), maxRight);
      setPopoverPosition({ top: rect.bottom + 6, right, width });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [showPopover]);

  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const popovers = showPopover && typeof document !== "undefined" ? createPortal(
    <div
      className="wire-debug-popovers"
      style={{
        top: `${popoverPosition.top}px`,
        right: `${popoverPosition.right}px`,
        width: `${popoverPosition.width}px`,
      }}
    >
      {menuOpen && (
        <div
          ref={menuRef}
          id={menuId}
          className="wire-settings-menu"
          role="menu"
          aria-label="Companion menu"
          style={{ maxHeight: `calc(100dvh - ${popoverPosition.top + 12}px)` }}
        >
          {actions.map((action) => (
            <ActionMenuItem key={action.key} action={action} onDone={() => setMenuOpen(false)} />
          ))}
          <div className="session-menu-separator" role="separator" />
          <details className="session-menu-section" role="group" aria-label="Color mode">
            <summary className="session-menu-heading">Color mode<span className="session-menu-chevron" aria-hidden="true">›</span></summary>
            {COLOR_MODE_OPTIONS.map((option) => (
              <ActionMenuItem
                key={option.value}
                action={{
                  key: `color-${option.value}`,
                  label: option.label,
                  description: option.description,
                  checked: colorMode === option.value,
                  radio: true,
                  onActivate: () => onColorModeChange(option.value),
                }}
                onDone={() => { /* Keep the menu open to compare palettes. */ }}
              />
            ))}
          </details>
          <div className="session-menu-separator" role="separator" />
          <details className="session-menu-section" role="group" aria-label="Debug">
            <summary className="session-menu-heading">Debug<span className="session-menu-chevron" aria-hidden="true">›</span></summary>
            <SettingsMenuItem
              label="Show raw tool output"
              description="Use unformatted tool arguments and output"
              checked={showRawToolOutput}
              onActivate={onToggleRawToolOutput}
            />
            <SettingsMenuItem
              label={panelVisible ? "Hide wire log" : "Show wire log"}
              description="View pilot ↔ backend traffic"
              checked={panelVisible}
              onActivate={() => { followWireRef.current = true; setRelayVisible(false); setPanelVisible((visible) => !visible); }}
            />
            <SettingsMenuItem
              label={relayVisible ? "Hide relay log" : "Show relay log"}
              description="View safe model-connection diagnostics"
              checked={relayVisible}
              onActivate={() => { setPanelVisible(false); setRelayVisible((visible) => !visible); }}
            />
            <div className="wire-settings-build" aria-label={`Build ${UI_BUILD_ID}`}>
              <span className="wire-settings-item-label">Build</span>
              <code className="wire-settings-build-code">{UI_BUILD_ID}</code>
            </div>
          </details>
        </div>
      )}

      {panelVisible && (
        <section className="wire-debug-log" aria-label="Pilot wire log">
          <div className="wire-debug-log-header">
            <span>pilot ↔ backend</span>
            <span>{entries.length} {entries.length === 1 ? "event" : "events"}</span>
          </div>
          <div ref={wireBodyRef} className="wire-debug-log-body" role="log" aria-live="polite" onScroll={(event) => {
            const body = event.currentTarget;
            followWireRef.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 4;
          }}>
            {wireQuery.isPending ? (
              <p className="wire-debug-empty">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="wire-debug-empty">No wire traffic yet. Send a prompt to capture it.</p>
            ) : (
              entries.map((entry, index) => (
                <div
                  key={`${entry.at}-${entry.method}-${index}`}
                  className={`wire-debug-entry dir-${entryDirection(entry)}`}
                >
                  <span className="wire-debug-time">{entry.at.slice(11, 19)}</span>
                  <span className="wire-debug-dir" aria-label={entryDirection(entry) === "out" ? "Sent" : "Received"}>{entry.dir}</span>
                  <span className="wire-debug-method">{entry.method}</span>
                  {typeof entry.ms === "number" && <span className="wire-debug-ms">{entry.ms}ms</span>}
                  {entry.ok === false && <span className="wire-debug-error">FAIL</span>}
                  {entry.params && <span className="wire-debug-params">{entry.params}</span>}
                  {entry.error && <span className="wire-debug-error wire-debug-error-detail">{entry.error}</span>}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {relayVisible && <RelayDebugPanel data={relayQuery.data} pending={relayQuery.isPending} />}

      {readError && panelVisible && (
        <div className="wire-debug-feedback" role="alert">{readError}</div>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <div className="wire-debug">
      <button
        ref={triggerRef}
        type="button"
        className={`wire-settings-trigger${panelVisible || relayVisible ? " active" : ""}`}
        onClick={() => setMenuOpen((open) => !open)}
        title="Companion menu"
        aria-label="Companion menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
      >
        <MenuIcon />
        {(panelVisible || relayVisible) && <span className="wire-settings-active-dot" aria-label="Debug log visible" />}
      </button>
      {popovers}
    </div>
  );
}

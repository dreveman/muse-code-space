// Session side panel: file tabs share the space beside the transcript with
// terminal tabs. Closing a terminal ends its shell; closing a file discards
// its local view.
import { memo, useEffect, useRef, useState } from "react";
import { TerminalView } from "./TerminalPanel";
import { FileTab } from "./FileTab";

export type SideTab =
  | { key: string; kind: "terminal"; terminalId: string | null; number: number | null }
  | { key: string; kind: "file"; path: string };

export type SidePanelState = { tabs: SideTab[]; activeKey: string | null };

export const OwnedArtifactMenu = memo(function OwnedArtifactMenu({ paths, onOpen }: { paths: readonly string[]; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (paths.length === 0) setOpen(false); }, [paths.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  if (paths.length === 0) return null;
  return <div className="artifact-menu-wrap" ref={root}>
    <button type="button" className={`terminal-toggle${open ? " active" : ""}`} onClick={() => setOpen((current) => !current)} aria-label="Open companion artifact" title="Open companion artifact" aria-haspopup="menu" aria-expanded={open}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h8" /></svg>
    </button>
    {open && <div className="artifact-menu" role="menu" aria-label="Companion artifacts">
      {paths.map((path) => <button key={path} type="button" role="menuitem" title={path} onClick={() => { setOpen(false); onOpen(path); }}>{path}</button>)}
    </div>}
  </div>;
});

export function sideTabLabel(tab: SideTab): string {
  if (tab.kind === "file") return tab.path.split("/").at(-1) || tab.path;
  return tab.number !== null ? `Terminal ${tab.number}` : "Terminal";
}

export function SidePanel({ sessionId, state, onSelect, onClose, onTerminalOpened }: {
  sessionId: string;
  state: SidePanelState;
  onSelect: (key: string) => void;
  onClose: (tab: SideTab) => void;
  onTerminalOpened: (key: string, terminalId: string, number: number) => void;
}) {
  return (
    <section id="agent-side-panel" className="side-panel" aria-label="Side panel">
      <div className="side-tabs" role="tablist" aria-label="Side panel tabs">
        {state.tabs.map((tab) => {
          const label = sideTabLabel(tab);
          const selected = tab.key === state.activeKey;
          return (
            <div key={tab.key} className={`side-tab${selected ? " active" : ""}`}>
              <button
                type="button"
                role="tab"
                id={`side-tab-${tab.key}`}
                aria-selected={selected}
                aria-controls={`side-panel-${tab.key}`}
                className="side-tab-label"
                onClick={() => onSelect(tab.key)}
              >
                {label}
              </button>
              <button
                type="button"
                className="side-tab-close"
                onClick={() => onClose(tab)}
                aria-label={`Close ${label}`}
                title={tab.kind === "terminal" ? "Close (ends the shell)" : "Close"}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="side-tab-panels">
        {state.tabs.map((tab) => {
          const selected = tab.key === state.activeKey;
          return (
            <div
              key={tab.key}
              id={`side-panel-${tab.key}`}
              role="tabpanel"
              aria-labelledby={`side-tab-${tab.key}`}
              className="side-tab-panel"
              hidden={!selected}
            >
              {tab.kind === "terminal" ? (
                <TerminalView
                  sessionId={sessionId}
                  terminalId={tab.terminalId}
                  active={selected}
                  onOpened={(terminalId, number) => onTerminalOpened(tab.key, terminalId, number)}
                />
              ) : <FileTab sessionId={sessionId} path={tab.path} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

import { memo, useEffect, useId, useRef, useState, type CSSProperties } from "react";

export type ProjectOption = { id: string; name: string; color: string; session_count: number; description?: string; briefing?: string };

export type NewProjectInput = { name: string; color: string; briefing: string };

export const PROJECT_COLORS = ["#e5484d", "#f76b15", "#ffb224", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#e93d82"];

function ProjectFolderIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" width="12" height="12" aria-hidden="true">
      <path d="M4.003 1.2a1.8 1.8 0 0 1 1.273.527l.497.497a.6.6 0 0 0 .424.176H10.8A1.2 1.2 0 0 1 12 3.6v6a1.2 1.2 0 0 1-1.2 1.2H1.2A1.2 1.2 0 0 1 0 9.6V2.4a1.2 1.2 0 0 1 1.2-1.2h2.803z" />
    </svg>
  );
}

// The floating project control above a composer, mirroring the RepoPicker
// ("github icon") control: the folder icon expands on hover to reveal
// "assign project" (or the assigned project's name), and opens a dropdown
// to pick an existing project, clear the assignment, or create a new one.
export const ProjectPicker = memo(function ProjectPicker({ projects, selected, disabled, bare = false, companionHue, infoOnly = false, onChoose, onCreateProject }: {
  projects: readonly ProjectOption[];
  selected: string | null;
  disabled?: boolean;
  /** The current companion's hue, for the unassigned (dimmed) color. */
  companionHue?: number;
  /** Show project info on click instead of allowing (re)assignment. */
  infoOnly?: boolean;
  /** Render only the picker wrap (to sit inside another picker's row). */
  bare?: boolean;
  onChoose: (projectId: string | null) => void;
  onCreateProject: (input: NewProjectInput) => Promise<{ id: string | null; error: string | null }>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PROJECT_COLORS[4]!);
  const [newBriefing, setNewBriefing] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selectedProject = projects.find((project) => project.id === selected) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open ]);

  const choose = (projectId: string | null) => {
    onChoose(projectId);
    setOpen(false);
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    const result = await onCreateProject({ name, color: newColor, briefing: newBriefing });
    setBusy(false);
    if (!result.id) {
      setError(result.error ?? "Project was not created.");
      return;
    }
    setNewName("");
    setNewBriefing("");
    setCreating(false);
    choose(result.id);
  };

  const wrap = (
      <div ref={wrapRef} className="repo-picker-wrap project-picker-wrap"
        style={(selectedProject
          ? { "--project-color": selectedProject.color }
          : companionHue !== undefined ? { "--companion-hue": companionHue } : undefined) as CSSProperties | undefined}>
        <div className={`repo-picker-control${selectedProject ? " repo-has-selection" : ""}`}>
          <button type="button" className="repo-picker-trigger project-picker-trigger" aria-haspopup="dialog" aria-expanded={open}
            aria-controls={`${id}-menu`} disabled={disabled} title={infoOnly ? undefined : "Assign project"}
            onClick={() => setOpen((value) => !value)}>
            <ProjectFolderIcon />
            {selectedProject
              ? <span className="repo-picker-name">{selectedProject.name}</span>
              : <span className="repo-picker-hover-only project-hover-label">Assign project</span>}
          </button>
          {selectedProject && !infoOnly && (
            <button type="button" className="repo-picker-dismiss project-picker-dismiss" aria-label="Remove project assignment"
              disabled={disabled} onClick={() => choose(null)}>
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          )}
        </div>
        {open && infoOnly && selectedProject && (
          <div id={`${id}-menu`} className="repo-menu project-menu" role="dialog" aria-label={`Project: ${selectedProject.name}`}>
            <div className="project-info">
              <p className="project-info-name"><span className="project-color-dot" style={{ background: selectedProject.color }} aria-hidden="true" />{selectedProject.name}</p>
              {selectedProject.description ? <p className="project-info-description">{selectedProject.description}</p> : null}
              <p className="project-info-meta">{selectedProject.session_count === 1 ? "1 conversation" : `${selectedProject.session_count} conversations`}</p>
              {selectedProject.briefing?.trim() ? (
                <details className="companion-soul project-info-briefing-details">
                  <summary>PROJECT.md</summary>
                  <pre className="project-info-briefing">{selectedProject.briefing}</pre>
                </details>
              ) : null}
            </div>
          </div>
        )}
        {open && !infoOnly && (
          <div id={`${id}-menu`} className="repo-menu project-menu" role="dialog" aria-label="Assign project">
            {projects.length > 0 && (<div className="repo-menu-list" role="listbox" aria-label="Projects">
              {projects.map((project) => (
                <button key={project.id} type="button" role="option" aria-selected={project.id === selected}
                  className={`repo-menu-option${project.id === selected ? " selected" : ""}`} onClick={() => choose(project.id)}>
                  <span className="project-color-dot" style={{ background: project.color }} aria-hidden="true" />
                  <span className="project-menu-option-name">{project.name}</span>
                  <span className="repo-row-status">{project.session_count === 1 ? "1 conversation" : `${project.session_count} conversations`}</span>
                </button>
              ))}
            </div>)}
            {creating ? (
              <div className="project-menu-create" role="group" aria-label="New project">
                <label className="sr-only" htmlFor={`${id}-new-project`}>Project name (required)</label>
                <input id={`${id}-new-project`} type="text" value={newName} maxLength={80} placeholder="Name *"
                  autoFocus disabled={busy} onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      void submitCreate();
                    }
                  }} />
                <div className="project-menu-colors" role="radiogroup" aria-label="Project color (required)">
                  {PROJECT_COLORS.map((color) => (
                    <button key={color} type="button" role="radio" aria-checked={newColor === color} title={color}
                      className={`project-color-swatch${newColor === color ? " selected" : ""}`}
                      style={{ background: color }} disabled={busy} onClick={() => setNewColor(color)} />
                  ))}
                  <input type="color" value={newColor} disabled={busy} aria-label="Custom project color"
                    onChange={(event) => setNewColor(event.target.value)} />
                </div>
                <label className="project-menu-briefing-label" htmlFor={`${id}-new-briefing`}>PROJECT.md</label>
                <textarea id={`${id}-new-briefing`} value={newBriefing} maxLength={8000} rows={6} disabled={busy}
                  placeholder={"Goals, constraints and working notes. Sent to agents as-is. Can be empty."}
                  onChange={(event) => setNewBriefing(event.target.value)} />
                {error && <span role="alert">{error}</span>}
                <div className="project-menu-create-actions">
                  <button type="button" disabled={busy || !newName.trim()} onClick={() => void submitCreate()}>
                    {busy ? "Creating…" : "Create project"}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="project-menu-create-toggle" onClick={() => setCreating(true)}>
                + New project
              </button>
            )}
          </div>
        )}
      </div>
  );
  return bare ? wrap : <div className="repo-row">{wrap}</div>;
});

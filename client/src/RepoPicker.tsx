import { useEffect, useId, useRef, useState } from "react";
import { parseRepoSlug } from "../../server/src/repoSlug";
import { filterRepos, repoStatusText, repoTriggerLabel, type RepoOption } from "./repoOptions";

function RepoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="5.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.1v5.8M12 7.1c0 2.8-3.4 2.7-6 3.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

// The tool/status row above a new companion's first-message prompt: pick a
// GitHub repo and it is cloned into the companion's fresh workspace before
// its first turn, instead of the agent cloning by hand. Picking nothing
// keeps today's blank generated workspace.
export function RepoPicker({ repos, githubEnabled, loading, selected, disabled, phase, onChoose }: {
  repos: readonly RepoOption[];
  githubEnabled: boolean;
  loading: boolean;
  selected: string | null;
  disabled?: boolean;
  phase: "idle" | "starting" | "queued";
  onChoose: (slug: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const visible = filterRepos(repos, query);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open ]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (slug: string | null) => {
    onChoose(slug);
    setOpen(false);
    setPasteError(null);
    triggerRef.current?.focus();
  };

  // Not a form element: this row lives inside the composer's own form, and
  // a nested one would hijack its submit. Enter is handled on the input.
  const submitPaste = () => {
    const slug = parseRepoSlug(pasteValue);
    if (!slug) {
      setPasteError("Enter an owner/repo or a github.com URL.");
      return;
    }
    setPasteValue("");
    choose(slug);
  };

  return (
    <div className="repo-row">
      <div className="repo-picker-wrap" ref={wrapRef}>
        <button ref={triggerRef} type="button" className="repo-picker-trigger"
          aria-label={selected ? `Repository: ${selected}. Change repository` : "Pick a repository to clone on start"}
          aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
          disabled={disabled} onClick={() => setOpen((value) => !value)}>
          <RepoIcon />
          <span className="repo-picker-name">{repoTriggerLabel(selected)}</span>
          <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div id={id} className="repo-menu" role="dialog" aria-label="Pick a repository">
            <p className="repo-menu-heading">Start in a repository</p>
            <input type="search" className="repo-menu-filter" aria-label="Filter repositories"
              placeholder="Filter repositories" value={query} maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
            <div className="repo-menu-list" role="listbox" aria-label="Repositories">
              <button type="button" className={`repo-menu-option${selected === null ? " selected" : ""}`}
                aria-selected={selected === null} onClick={() => choose(null)}>
                <span className="repo-menu-identity"><strong>No repo</strong><small>Blank workspace, as today</small></span>
              </button>
              {visible.map((repo) => (
                <button type="button" key={repo.slug}
                  className={`repo-menu-option${selected === repo.slug ? " selected" : ""}`}
                  aria-selected={selected === repo.slug} onClick={() => choose(repo.slug)}>
                  <span className="repo-menu-identity"><strong>{repo.slug}</strong>
                    <small>{repo.private ? "Private" : "Public"}{repo.description ? ` · ${repo.description}` : ""}</small></span>
                </button>
              ))}
              {loading && <p className="repo-menu-note">Loading repositories…</p>}
              {!loading && repos.length === 0 && (
                <p className="repo-menu-note">
                  {githubEnabled
                    ? "No repositories found for the GitHub credential."
                    : "GitHub isn't set up for Code Space, so no list to pick from. Paste a public repo below — private repos need GitHub setup (docs/PILOT.md)."}
                </p>
              )}
              {!loading && repos.length > 0 && visible.length === 0 && (
                <p className="repo-menu-note">No repositories match “{query.trim()}”.</p>
              )}
            </div>
            <div className="repo-menu-paste">
              <input type="text" aria-label="Paste an owner/repo or github.com URL"
                placeholder="owner/repo or github.com URL" value={pasteValue} maxLength={300}
                onChange={(event) => { setPasteValue(event.target.value); setPasteError(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitPaste(); } }} />
              <button type="button" disabled={pasteValue.trim().length === 0} onClick={submitPaste}>Use</button>
            </div>
            {pasteError && <p className="repo-menu-error" role="alert">{pasteError}</p>}
          </div>
        )}
      </div>
      <span className="repo-row-status" role="status">{repoStatusText(selected, phase)}</span>
    </div>
  );
}

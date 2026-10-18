import { useEffect, useId, useRef, useState } from "react";
import { ExpandButton } from "./MoreCompanionsButton";
import { SmartLogIcon } from "./SmartLogPanel";
import {
  formatCloneProgressLabel,
  repoOwnerAvatarUrl,
  repoStatusText,
  repoTriggerLabel,
  visibleTopRepos,
  type RepoCloneProgress,
  type RepoOption,
} from "./repoOptions";
import { smartlogCheckoutLabel, type SessionVcsStatus } from "./smartlogLayout";

function RepoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943" />
    </svg>
  );
}

function DismissIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// The floating repo control above a companion's composer:
// - mode="pick" (new companion draft): pick a GitHub repo to clone into the
//   fresh workspace before the first turn starts.
// - mode="manage" (started conversation with a repo): continues showing the
//   GitHub icon + repo name, displays a live clone progress bar while cloning,
//   and opens a repository connection popover on click.
export function RepoPicker({
  repos,
  githubEnabled,
  loading,
  selected,
  disabled,
  phase,
  mode = "pick",
  cloneProgress = null,
  workspacePath = null,
  vcsStatus = null,
  smartlogOpen = false,
  onToggleSmartlog,
  onChoose,
}: {
  repos: readonly RepoOption[];
  githubEnabled: boolean;
  loading: boolean;
  selected: string | null;
  disabled?: boolean;
  phase: "idle" | "starting" | "queued";
  mode?: "pick" | "manage";
  cloneProgress?: RepoCloneProgress | null;
  workspacePath?: string | null;
  vcsStatus?: SessionVcsStatus | null;
  smartlogOpen?: boolean;
  onToggleSmartlog?: () => void;
  onChoose?: (slug: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number>();
  const [connectDismissed, setConnectDismissed] = useState(false);
  const [copiedField, setCopiedField] = useState<"url" | "path" | null>(null);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { shown: visible, hasMore } = visibleTopRepos(repos, query, moreExpanded);
  const showConnectPrompt = mode === "pick" && !githubEnabled && selected === null;
  const cloning = Boolean(selected && (phase === "starting" || cloneProgress?.active));

  useEffect(() => {
    if (!open) {
      setMoreExpanded(false);
      setCopiedField(null);
      return;
    }
    const measure = () => setMenuMaxHeight(Math.max(200, (triggerRef.current?.getBoundingClientRect().top ?? 16) - 16));
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [open]);

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
  useEffect(() => { if (disabled && mode === "pick") setOpen(false); }, [disabled, mode]);

  const choose = (slug: string | null) => {
    onChoose?.(slug);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const copyText = (field: "url" | "path", value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopiedField(field);
    window.setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 1500);
  };

  const checkoutLabel = smartlogCheckoutLabel(vcsStatus);
  if (mode === "manage" && !selected && !checkoutLabel) return null;

  const statusText = repoStatusText(selected, phase, cloneProgress);
  if (showConnectPrompt && connectDismissed) {
    return statusText ? (
      <div className="repo-row">
        <span className="repo-row-status" role="status">{statusText}</span>
      </div>
    ) : null;
  }

  const matchedRepo = selected
    ? repos.find((item) => item.slug.toLowerCase() === selected.toLowerCase()) ?? null
    : null;
  const selectedOwner = selected?.split("/")[0] ?? "";
  const repoHtmlUrl = matchedRepo?.html_url ?? (selected ? `https://github.com/${selected}` : "");
  const clonePercent = cloneProgress?.percent != null ? Math.min(100, Math.max(0, cloneProgress.percent)) : null;

  return (
    <div className="repo-row">
      {(mode === "pick" || selected) && (
      <div className="repo-picker-wrap" ref={wrapRef}>
        <div className="repo-picker-control">
          <button ref={triggerRef} type="button" className="repo-picker-trigger"
            aria-label={mode === "manage"
              ? `Repository connection: ${selected}`
              : selected ? `Repository: ${selected}. Change repository` : showConnectPrompt ? "Connect GitHub · Work on your repos" : "Select repository"}
            aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
            disabled={mode === "pick" ? disabled : false} onClick={() => setOpen((value) => !value)}>
            <RepoIcon />
            <span className={`repo-picker-name${mode === "pick" && githubEnabled && selected === null ? " repo-picker-hover-only" : ""}`}>
              {repoTriggerLabel(selected, githubEnabled)}
            </span>
            {showConnectPrompt && (
              <>
                <span className="repo-picker-sep" aria-hidden="true">·</span>
                <span className="repo-picker-sublabel">Work on your repos</span>
              </>
            )}
          </button>
          {showConnectPrompt && (
            <button type="button" className="repo-picker-dismiss"
              aria-label="Dismiss" title="Dismiss"
              disabled={disabled}
              onClick={() => { setOpen(false); setConnectDismissed(true); }}>
              <DismissIcon />
            </button>
          )}
        </div>
        {open && mode === "manage" && selected && (
          <div id={id} className="repo-menu repo-manage-menu" role="dialog" aria-label={`Repository connection for ${selected}`}>
            <div className="repo-manage-header">
              <img className="repo-menu-avatar repo-manage-avatar"
                src={repoOwnerAvatarUrl({ owner: selectedOwner, owner_avatar_url: matchedRepo?.owner_avatar_url })}
                width={32} height={32} alt="" />
              <div className="repo-menu-identity">
                <strong>{selected}</strong>
                <small>
                  {matchedRepo ? (matchedRepo.private ? "Private repository" : "Public repository") : "GitHub repository"}
                  {matchedRepo?.default_branch ? ` · ${matchedRepo.default_branch}` : ""}
                </small>
              </div>
              <span className={`repo-manage-badge${cloning ? " cloning" : " connected"}`}>
                {cloning ? "Cloning" : "Connected"}
              </span>
            </div>
            {matchedRepo?.description && (
              <p className="repo-manage-description">{matchedRepo.description}</p>
            )}
            {cloning && (
              <div className="repo-manage-progress">
                <div className="repo-clone-bar">
                  <div className={`repo-clone-fill${clonePercent == null ? " indeterminate" : ""}`}
                    style={clonePercent != null ? { width: `${clonePercent}%` } : undefined} />
                </div>
                <span className="repo-clone-label">{formatCloneProgressLabel(selected, cloneProgress)}</span>
              </div>
            )}
            <hr className="repo-manage-divider" />
            {workspacePath && (
              <div className="repo-manage-field">
                <span className="repo-manage-field-label">Workspace</span>
                <code className="repo-manage-field-value">{workspacePath}</code>
                <button type="button" className="repo-manage-copy"
                  onClick={() => copyText("path", workspacePath)}>
                  {copiedField === "path" ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            <div className="repo-manage-field">
              <span className="repo-manage-field-label">Remote</span>
              <code className="repo-manage-field-value">{repoHtmlUrl}</code>
              <button type="button" className="repo-manage-copy"
                onClick={() => copyText("url", `${repoHtmlUrl}.git`)}>
                {copiedField === "url" ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="repo-manage-actions">
              <a className="repo-manage-action" href={repoHtmlUrl} target="_blank" rel="noopener noreferrer">
                Open on GitHub ↗
              </a>
              <a className="repo-manage-action" href={`${repoHtmlUrl}/pulls`} target="_blank" rel="noopener noreferrer">
                Pull requests ↗
              </a>
              <a className="repo-manage-action" href={`${repoHtmlUrl}/issues`} target="_blank" rel="noopener noreferrer">
                Issues ↗
              </a>
            </div>
          </div>
        )}
        {open && mode === "pick" && (
          <div id={id} className="repo-menu" style={{ maxHeight: menuMaxHeight }} role="dialog" aria-label="Pick a repository">
            <p className="repo-menu-heading">Top repositories</p>
            <input type="search" className="repo-menu-filter" aria-label="Search for repositories"
              placeholder="Search for repositories" value={query} maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
            <div id={`${id}-repos`} className="repo-menu-list" role="listbox" aria-label="Repositories">
              {selected !== null && (
                <button type="button" className="repo-menu-option"
                  aria-selected={false} onClick={() => choose(null)}>
                  <span className="repo-menu-identity"><strong>No repo</strong><small>Blank workspace, as today</small></span>
                </button>
              )}
              {visible.map((repo) => (
                <button type="button" key={repo.slug}
                  className={`repo-menu-option${selected === repo.slug ? " selected" : ""}`}
                  aria-selected={selected === repo.slug} onClick={() => choose(repo.slug)}>
                  <img className="repo-menu-avatar" src={repoOwnerAvatarUrl(repo)} width={20} height={20} alt="" loading="lazy" />
                  <span className="repo-menu-identity"><strong>{repo.slug}</strong>
                    <small>{repo.private ? "Private" : "Public"}{repo.description ? ` · ${repo.description}` : ""}</small></span>
                </button>
              ))}
              {loading && <p className="repo-menu-note">Loading repositories…</p>}
              {!loading && repos.length === 0 && (
                <p className="repo-menu-note">
                  {githubEnabled
                    ? "No repositories found for the GitHub credential."
                    : "GitHub isn't set up for Code Space, so no list to pick from."}
                </p>
              )}
              {!loading && repos.length > 0 && visible.length === 0 && (
                <p className="repo-menu-note">No repositories match “{query.trim()}”.</p>
              )}
            </div>
            {hasMore && (
              <ExpandButton expanded={moreExpanded} controls={`${id}-repos`}
                onToggle={() => setMoreExpanded((value) => !value)}>
                {moreExpanded ? "Show less" : "Show more"}
              </ExpandButton>
            )}
          </div>
        )}
      </div>
      )}
      {cloning ? (
        <div className="repo-clone-inline" role="progressbar"
          aria-label={`Cloning ${selected}`}
          aria-valuenow={clonePercent ?? undefined}
          aria-valuemin={0} aria-valuemax={100}>
          <div className="repo-clone-bar">
            <div className={`repo-clone-fill${clonePercent == null ? " indeterminate" : ""}`}
              style={clonePercent != null ? { width: `${clonePercent}%` } : undefined} />
          </div>
          <span className="repo-clone-label">{formatCloneProgressLabel(selected, cloneProgress)}</span>
        </div>
      ) : (
        statusText && <span className="repo-row-status" role="status">{statusText}</span>
      )}
      {checkoutLabel && onToggleSmartlog && (
        <div className="smartlog-trigger-wrap">
          <button
            type="button"
            className={`repo-picker-trigger smartlog-trigger${smartlogOpen ? " active" : ""}`}
            aria-label={smartlogOpen ? "Close Smart Log" : "Open Smart Log"}
            aria-pressed={smartlogOpen}
            title={smartlogOpen ? "Close Smart Log" : "Open Smart Log"}
            onClick={onToggleSmartlog}
          >
            <span className="repo-picker-name">{checkoutLabel}</span>
            <SmartLogIcon />
          </button>
        </div>
      )}
    </div>
  );
}

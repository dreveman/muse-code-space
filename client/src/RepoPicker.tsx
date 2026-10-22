import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExpandButton } from "./MoreCompanionsButton";
import { PrMonitoringSyncIcon, PullRequestIcon } from "./PrMonitorEvent";
import { SmartLogIcon } from "./SmartLogPanel";
import type { OwnedPullRequest } from "./ownedPullRequests";
import {
  formatCloneProgressLabel,
  repoOwnerAvatarUrl,
  repoOwnerFallbackAvatar,
  repoStatusText,
  repoTriggerLabel,
  visibleTopRepos,
  type RepoCloneProgress,
  type RepoOption,
} from "./repoOptions";
import { formatRelativeTime } from "./sessionList";
import { formatGitAuthor, parseGitAuthorText } from "./gitAuthor";
import { copyTextToClipboard } from "./clipboard";
import { smartlogCheckoutLabel, type SessionVcsStatus } from "./smartlogLayout";

function UncommittedDraftRingIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="2" strokeDasharray="2.1 1.9" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16" color="currentColor" aria-hidden="true">
      <path d="M3.46 14.89h9.143a2.292 2.292 0 0 0 2.286-2.286v-1.523a.764.764 0 0 0-.762-.762.764.764 0 0 0-.762.761v1.524a.764.764 0 0 1-.762.762H3.46a.764.764 0 0 1-.762-.762V3.461c0-.419.343-.761.762-.761h1.524c.42 0 .762-.343.762-.762a.764.764 0 0 0-.762-.762H3.46A2.292 2.292 0 0 0 1.175 3.46v9.143A2.292 2.292 0 0 0 3.46 14.89z" />
      <path d="M7.27 1.938c0 .419.343.762.762.762h4.259L5.974 9.016a.759.759 0 0 0 .541 1.295.78.78 0 0 0 .541-.22l6.317-6.317v4.259c0 .419.342.762.761.762.42 0 .762-.343.762-.762V1.938a.764.764 0 0 0-.762-.762H8.04a.764.764 0 0 0-.762.762H7.27z" />
    </svg>
  );
}

function CopyButtonIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16" color="currentColor" aria-hidden="true">
      <path d="M14.238 4.333a.764.764 0 0 0-.762.762v6.095a3.047 3.047 0 0 1-3.048 3.048H6.62a.764.764 0 0 0-.762.762c0 .419.343.761.762.761h3.81a4.575 4.575 0 0 0 4.57-4.57V5.094a.764.764 0 0 0-.761-.762z" />
      <path d="M11.952 10.81V2.427A1.905 1.905 0 0 0 10.047.523H3.19a1.905 1.905 0 0 0-1.904 1.905v8.381c0 1.052.853 1.905 1.904 1.905h6.857a1.905 1.905 0 0 0 1.905-1.905zm-9.143 0V2.427c0-.213.168-.38.381-.38h6.857c.214 0 .381.167.381.38v8.381c0 .214-.167.381-.38.381H3.19a.377.377 0 0 1-.38-.38z" />
      <path d="M8.143 3.571H5.095a.764.764 0 0 0-.762.762c0 .419.343.762.762.762h3.048c.419 0 .762-.343.762-.762a.764.764 0 0 0-.762-.762zM6.619 6.619H5.095a.764.764 0 0 0-.762.762c0 .419.343.761.762.761H6.62c.419 0 .762-.342.762-.761a.764.764 0 0 0-.762-.762z" />
    </svg>
  );
}

function CopiedCheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
      <path d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  );
}

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
export const RepoPicker = memo(function RepoPicker({
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
  ownedPrs = [],
  smartlogOpen = false,
  onToggleSmartlog,
  onChoose,
  globalGitIdentity = null,
  sessionGitAuthor = null,
  onSaveSessionGitAuthor,
  githubSetup = null,
  onPerformGithubSetupStep,
  onSaveGlobalGitAuthor,
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
  ownedPrs?: readonly OwnedPullRequest[];
  smartlogOpen?: boolean;
  onToggleSmartlog?: () => void;
  onChoose?: (slug: string | null) => void;
  globalGitIdentity?: { name: string; email: string } | null;
  sessionGitAuthor?: { name: string; email: string } | null;
  onSaveSessionGitAuthor?: (identity: { name: string; email: string } | null) => Promise<boolean>;
  githubSetup?: { brokerDone: boolean; appDone: boolean; brokerRequested?: boolean } | null;
  onPerformGithubSetupStep?: (step: "broker" | "app", payload?: { appId: string; installationId: string; privateKey: string }) => Promise<{ ok: boolean; error: string | null; brokerRequested?: boolean }>;
  onSaveGlobalGitAuthor?: (identity: { name: string; email: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [openPrKey, setOpenPrKey] = useState<string | null>(null);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number>();
  const [connectDismissed, setConnectDismissed] = useState(false);
  const [manageAuthorText, setManageAuthorText] = useState("");
  const [editingAuthor, setEditingAuthor] = useState(false);
  const [savingAuthor, setSavingAuthor] = useState(false);
  const parsedManageAuthor = parseGitAuthorText(manageAuthorText);
  // Editing is local until Save: Edit seeds the field with the effective
  // author (per-checkout override, else the global identity); Save parses
  // "Name <email>", stores it as this checkout's override (blank, or a value
  // equal to the global identity, clears the override back to global).
  const startEditingAuthor = () => {
    const effective = sessionGitAuthor ?? globalGitIdentity;
    setManageAuthorText(effective ? formatGitAuthor(effective) : "");
    setEditingAuthor(true);
  };
  const saveAuthor = async () => {
    if (!onSaveSessionGitAuthor || parsedManageAuthor === "invalid" || savingAuthor) return;
    const override = parsedManageAuthor
      && globalGitIdentity
      && parsedManageAuthor.name === globalGitIdentity.name
      && parsedManageAuthor.email === globalGitIdentity.email
      ? null
      : parsedManageAuthor;
    setSavingAuthor(true);
    try {
      if (await onSaveSessionGitAuthor(override)) setEditingAuthor(false);
    } finally {
      setSavingAuthor(false);
    }
  };
  // GitHub setup dialog (pick mode): while any step is incomplete the
  // dropdown shows the steps instead of the repo list. The Commit author
  // step derives from the global identity; broker/App progress comes from
  // the pilot through App.
  const [setupExpanded, setSetupExpanded] = useState<"app" | "author" | null>(null);
  const [setupBusy, setSetupBusy] = useState<"broker" | "app" | "author" | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupAppId, setSetupAppId] = useState("");
  const [setupInstallationId, setSetupInstallationId] = useState("");
  const [setupPrivateKey, setSetupPrivateKey] = useState("");
  const [setupAuthorText, setSetupAuthorText] = useState("");
  const setupAuthorParsed = parseGitAuthorText(setupAuthorText);
  const setupAuthorDone = Boolean(globalGitIdentity);
  const setupCompleteCount = (githubSetup?.brokerDone ? 1 : 0) + (githubSetup?.appDone ? 1 : 0) + (setupAuthorDone ? 1 : 0);
  const showGithubSetup = mode === "pick" && githubSetup !== null && Boolean(onPerformGithubSetupStep)
    && !(githubSetup.brokerDone && githubSetup.appDone && setupAuthorDone);
  const [setupBrokerWaiting, setSetupBrokerWaiting] = useState(false);
  const brokerWaiting = !githubSetup?.brokerDone && (setupBrokerWaiting || Boolean(githubSetup?.brokerRequested));
  const runSetupStep = async (step: "broker" | "app") => {
    if (!onPerformGithubSetupStep || setupBusy) return;
    setSetupBusy(step);
    setSetupError(null);
    try {
      const result = await onPerformGithubSetupStep(step, step === "app"
        ? { appId: setupAppId, installationId: setupInstallationId, privateKey: setupPrivateKey }
        : undefined);
      if (result.ok) {
        if (step === "app") { setSetupPrivateKey(""); setSetupExpanded(null); }
        // The broker step asks the Muse assistant to initiate the Secure
        // Vault addition; the dialog waits (status polling in App) until
        // the broker credential actually lands.
        if (step === "broker" && result.brokerRequested) setSetupBrokerWaiting(true);
      } else {
        setSetupError(result.error ?? "That step could not be completed.");
      }
    } finally {
      setSetupBusy(null);
    }
  };
  const saveSetupAuthor = async () => {
    if (!onSaveGlobalGitAuthor || setupAuthorParsed === "invalid" || !setupAuthorParsed || setupBusy) return;
    setSetupBusy("author");
    setSetupError(null);
    try {
      if (await onSaveGlobalGitAuthor(setupAuthorParsed)) setSetupExpanded(null);
      else setSetupError("That author could not be saved.");
    } finally {
      setSetupBusy(null);
    }
  };
  const [copiedField, setCopiedField] = useState<"url" | "path" | "pr-url" | null>(null);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const prWrapRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const prMenuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const prMenuId = useId();
  const { shown: visible, hasMore } = useMemo(
    () => visibleTopRepos(repos, query, moreExpanded),
    [repos, query, moreExpanded],
  );
  const showConnectPrompt = mode === "pick" && !githubEnabled && selected === null;
  const cloning = Boolean(selected && (phase === "starting" || cloneProgress?.active));

  useLayoutEffect(() => {
    const activeMenu = open ? menuRef.current : openPrKey ? prMenuRef.current : null;
    if (!activeMenu) return;
    const adjustPosition = () => {
      activeMenu.style.removeProperty("transform");
      const rect = activeMenu.getBoundingClientRect();
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const margin = 12;
      let dx = 0;
      if (rect.left < margin) {
        dx = margin - rect.left;
      } else if (rect.right > vw - margin) {
        dx = (vw - margin) - rect.right;
      }
      if (dx !== 0) {
        activeMenu.style.transform = `translateX(${Math.round(dx)}px)`;
      }
    };
    adjustPosition();
    window.addEventListener("resize", adjustPosition);
    window.visualViewport?.addEventListener("resize", adjustPosition);
    return () => {
      window.removeEventListener("resize", adjustPosition);
      window.visualViewport?.removeEventListener("resize", adjustPosition);
    };
  }, [open, openPrKey]);

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
    if (!open && !openPrKey) return;
    const close = (event: PointerEvent | FocusEvent) => {
      if (!(event.target instanceof Node)) return;
      if (open && !wrapRef.current?.contains(event.target)) setOpen(false);
      if (openPrKey && !prWrapRef.current?.contains(event.target)) setOpenPrKey(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setOpenPrKey(null);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, openPrKey]);
  useEffect(() => { if (disabled && mode === "pick") setOpen(false); }, [disabled, mode]);

  const choose = (slug: string | null) => {
    onChoose?.(slug);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const copyText = (field: "url" | "path" | "pr-url", value: string) => {
    void copyTextToClipboard(value).then((ok) => {
      if (!ok) return;
      setCopiedField(field);
      window.setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 1500);
    });
  };

  const checkoutLabel = smartlogCheckoutLabel(vcsStatus);
  if (mode === "manage" && !selected && !checkoutLabel && ownedPrs.length === 0) return null;

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
            disabled={mode === "pick" ? disabled : false} onClick={() => { setOpenPrKey(null); setOpen((value) => !value); }}>
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
          <div ref={menuRef} id={id} className="repo-menu repo-manage-menu" role="dialog" aria-label={`Repository connection for ${selected}`}>
            <div className="repo-manage-header">
              <img className="repo-menu-avatar repo-manage-avatar"
                src={repoOwnerAvatarUrl({ owner: selectedOwner, owner_avatar_url: matchedRepo?.owner_avatar_url })}
                onError={(event) => {
                  const fallback = repoOwnerFallbackAvatar(selectedOwner);
                  if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
                }}
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
                  title={copiedField === "path" ? "Copied" : "Copy"}
                  aria-label={copiedField === "path" ? "Copied workspace path" : "Copy workspace path"}
                  onClick={() => copyText("path", workspacePath)}>
                  {copiedField === "path" ? <CopiedCheckIcon /> : <CopyButtonIcon />}
                </button>
              </div>
            )}
            <div className="repo-manage-field">
              <span className="repo-manage-field-label">Remote</span>
              <code className="repo-manage-field-value">{repoHtmlUrl}</code>
              <button type="button" className="repo-manage-copy"
                title={copiedField === "url" ? "Copied" : "Copy"}
                aria-label={copiedField === "url" ? "Copied remote URL" : "Copy remote URL"}
                onClick={() => copyText("url", `${repoHtmlUrl}.git`)}>
                {copiedField === "url" ? <CopiedCheckIcon /> : <CopyButtonIcon />}
              </button>
            </div>
            {onSaveSessionGitAuthor && (
              <div className="repo-manage-field">
                <span className="repo-manage-field-label">Author</span>
                {editingAuthor ? (
                  <input type="text" className="repo-manage-field-value repo-author-input" aria-label="Author"
                    value={manageAuthorText} maxLength={300} autoComplete="name" autoFocus
                    placeholder="Name <email>"
                    aria-invalid={parsedManageAuthor === "invalid"}
                    onChange={(event) => setManageAuthorText(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveAuthor(); } }} />
                ) : (
                  <code className="repo-manage-field-value">
                    {sessionGitAuthor
                      ? formatGitAuthor(sessionGitAuthor)
                      : globalGitIdentity
                        ? formatGitAuthor(globalGitIdentity)
                        : "Not set"}
                  </code>
                )}
                <button type="button" className={`repo-manage-copy repo-author-edit${editingAuthor ? " pressed" : ""}`}
                  title={editingAuthor ? "Save commit author for this checkout" : "Edit commit author for this checkout"}
                  aria-label={editingAuthor ? "Save commit author for this checkout" : "Edit commit author for this checkout"}
                  aria-expanded={editingAuthor}
                  aria-pressed={editingAuthor}
                  disabled={editingAuthor && (parsedManageAuthor === "invalid" || savingAuthor)}
                  onClick={() => { if (editingAuthor) void saveAuthor(); else startEditingAuthor(); }}>
                  {editingAuthor ? "Save" : "Edit"}
                </button>
              </div>
            )}
            <div className="repo-manage-actions">
              <a className="repo-manage-action" href={repoHtmlUrl} target="_blank" rel="noopener noreferrer">
                <span>Open on GitHub</span>
                <ExternalLinkIcon />
              </a>
              <a className="repo-manage-action" href={`${repoHtmlUrl}/pulls`} target="_blank" rel="noopener noreferrer">
                <span>Pull requests</span>
                <ExternalLinkIcon />
              </a>
              <a className="repo-manage-action" href={`${repoHtmlUrl}/issues`} target="_blank" rel="noopener noreferrer">
                <span>Issues</span>
                <ExternalLinkIcon />
              </a>
            </div>
          </div>
        )}
        {open && mode === "pick" && showGithubSetup && githubSetup && (
          <div ref={menuRef} id={id} className="repo-menu repo-setup-menu" style={{ maxHeight: menuMaxHeight }} role="dialog" aria-label="GitHub setup">
            <div className="repo-setup-header">
              <strong>GitHub setup</strong>
              <span>{setupCompleteCount} of 3 complete</span>
            </div>
            <ol className="repo-setup-steps">
              <li className={`repo-setup-step${githubSetup.brokerDone ? " done" : ""}`}>
                <span className="repo-setup-status" aria-hidden="true">{githubSetup.brokerDone ? "✓" : "1"}</span>
                <div className="repo-setup-identity">
                  <strong>GitHub broker</strong>
                  <small>Lets companions use gh and list repositories</small>
                </div>
                {!githubSetup.brokerDone && (brokerWaiting ? (
                  <span className="repo-setup-waiting" role="status">
                    <span className="working-spinner" aria-hidden="true" />
                    Waiting…
                  </span>
                ) : (
                  <button type="button" className="repo-setup-action"
                    disabled={setupBusy !== null}
                    onClick={() => { void runSetupStep("broker"); }}>
                    {setupBusy === "broker" ? "Asking…" : "Set up"}
                  </button>
                ))}
              </li>
              {brokerWaiting && (
                <li className="repo-setup-note" role="status">
                  Your Muse assistant has been asked to set up the GitHub broker, starting with the Secure Vault addition for <code>custom.github-broker</code>. Go to your Muse assistant to add the GitHub credential — this step completes automatically once it’s done.
                </li>
              )}
              <li className={`repo-setup-step${githubSetup.appDone ? " done" : ""}`}>
                <span className="repo-setup-status" aria-hidden="true">{githubSetup.appDone ? "✓" : "2"}</span>
                <div className="repo-setup-identity">
                  <strong>GitHub App</strong>
                  <small>Lets companions clone, pull, and push to repositories</small>
                </div>
                {!githubSetup.appDone && (
                  <button type="button" className={`repo-setup-action${setupExpanded === "app" ? " pressed" : ""}`}
                    aria-expanded={setupExpanded === "app"}
                    disabled={setupBusy !== null}
                    onClick={() => setSetupExpanded((value) => (value === "app" ? null : "app"))}>
                    Connect
                  </button>
                )}
              </li>
              {setupExpanded === "app" && !githubSetup.appDone && (
                <li className="repo-setup-form">
                  <label className="repo-setup-field">
                    <span>App ID</span>
                    <input type="text" inputMode="numeric" aria-label="App ID" value={setupAppId} maxLength={32}
                      onChange={(event) => setSetupAppId(event.target.value)} />
                  </label>
                  <label className="repo-setup-field">
                    <span>Installation ID</span>
                    <input type="text" inputMode="numeric" aria-label="Installation ID" value={setupInstallationId} maxLength={32}
                      onChange={(event) => setSetupInstallationId(event.target.value)} />
                  </label>
                  <label className="repo-setup-field">
                    <span>Private key</span>
                    <textarea aria-label="Private key" value={setupPrivateKey} rows={4} maxLength={16000}
                      placeholder="Paste the App private key (.pem)" autoComplete="off" spellCheck={false}
                      onChange={(event) => setSetupPrivateKey(event.target.value)} />
                  </label>
                  <button type="button" className="repo-setup-action repo-setup-submit"
                    disabled={setupBusy !== null || !setupAppId.trim() || !setupInstallationId.trim() || !setupPrivateKey.trim()}
                    onClick={() => { void runSetupStep("app"); }}>
                    {setupBusy === "app" ? "Connecting…" : "Connect GitHub App"}
                  </button>
                </li>
              )}
              <li className={`repo-setup-step${setupAuthorDone ? " done" : ""}`}>
                <span className="repo-setup-status" aria-hidden="true">{setupAuthorDone ? "✓" : "3"}</span>
                <div className="repo-setup-identity">
                  <strong>Commit author</strong>
                  <small>{globalGitIdentity ? formatGitAuthor(globalGitIdentity) : "Default name and email for commits"}</small>
                </div>
                <button type="button" className={`repo-setup-action${setupExpanded === "author" ? " pressed" : ""}`}
                  aria-expanded={setupExpanded === "author"}
                  disabled={setupBusy !== null}
                  onClick={() => {
                    if (setupExpanded === "author") { setSetupExpanded(null); return; }
                    setSetupAuthorText(globalGitIdentity ? formatGitAuthor(globalGitIdentity) : "");
                    setSetupExpanded("author");
                  }}>
                  {setupAuthorDone ? "Edit" : "Set author"}
                </button>
              </li>
              {setupExpanded === "author" && (
                <li className="repo-setup-form">
                  <label className="repo-setup-field">
                    <span>Author</span>
                    <input type="text" aria-label="Author" value={setupAuthorText} maxLength={300}
                      placeholder="Name <email>" autoComplete="name"
                      aria-invalid={setupAuthorParsed === "invalid"}
                      onChange={(event) => setSetupAuthorText(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveSetupAuthor(); } }} />
                  </label>
                  <button type="button" className="repo-setup-action repo-setup-submit"
                    disabled={setupBusy !== null || setupAuthorParsed === "invalid" || !setupAuthorParsed}
                    onClick={() => { void saveSetupAuthor(); }}>
                    {setupBusy === "author" ? "Saving…" : "Save"}
                  </button>
                </li>
              )}
            </ol>
            {setupError && <p className="repo-setup-error" role="alert">{setupError}</p>}
          </div>
        )}
        {open && mode === "pick" && !showGithubSetup && (
          <div ref={menuRef} id={id} className="repo-menu" style={{ maxHeight: menuMaxHeight }} role="dialog" aria-label="Pick a repository">
            <p className="repo-menu-heading">Top repositories</p>
            <input type="search" className="repo-menu-filter" aria-label="Search for repositories"
              placeholder="Search for repositories" value={query} maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
            <div id={`${id}-repos`} className="repo-menu-list" role="listbox" aria-label="Repositories">
              {visible.map((repo) => (
                <button type="button" key={repo.slug}
                  className={`repo-menu-option${selected === repo.slug ? " selected" : ""}`}
                  aria-selected={selected === repo.slug} onClick={() => choose(repo.slug)}>
                  <img className="repo-menu-avatar" src={repoOwnerAvatarUrl(repo)} width={20} height={20} alt="" loading="lazy"
                    onError={(event) => {
                      const fallback = repoOwnerFallbackAvatar(repo.owner);
                      if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
                    }} />
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
      {(ownedPrs.length > 0 || (checkoutLabel && onToggleSmartlog)) && (() => {
        const isDirty = (vcsStatus?.uncommittedFileCount ?? 0) > 0;
        const hasDraftCommits = vcsStatus?.smartlogCommits.some((c) => c.phase === "draft") ?? false;
        const showNodeRail = ownedPrs.length > 0 || isDirty || hasDraftCommits;
        const baseCommit =
          vcsStatus?.smartlogCommits.find((c) => c.phase === "public") ??
          vcsStatus?.smartlogCommits[0] ??
          null;
        const baseAge = baseCommit?.date
          ? formatRelativeTime(baseCommit.date, Date.now()).replace(/\s+ago$/i, "")
          : null;
        const activePr = openPrKey ? ownedPrs.find((p) => p.key === openPrKey) ?? null : null;
        const activePrOwner = activePr?.repo.split("/")[0] ?? "";
        const activePrMatchedRepo = activePr
          ? repos.find((item) => item.slug.toLowerCase() === activePr.repo.toLowerCase()) ?? null
          : null;
        const activePrStateLabel = activePr
          ? activePr.monitoring
            ? "Monitoring"
            : activePr.state === "merged"
              ? "Merged"
              : activePr.state === "closed"
                ? "Closed"
                : activePr.draft
                  ? "Draft"
                  : "Open"
          : "";
        return (
          <div className="smartlog-trigger-wrap">
            {showNodeRail && baseAge && (
              <span className="vcs-base-age" title="Base commit age">{baseAge}</span>
            )}
            {showNodeRail && (
              <span ref={prWrapRef} className="vcs-node-rail" aria-label="Pull requests and local stack">
                <span className="vcs-rail-tick" aria-hidden="true" />
                {ownedPrs.length > 0 ? (
                  ownedPrs.map((pr) => {
                    const stateLabel = pr.monitoring
                      ? "Monitoring"
                      : pr.state === "merged"
                        ? "Merged"
                        : pr.state === "closed"
                          ? "Closed"
                          : pr.draft
                            ? "Draft"
                            : "Open";
                    const tooltip = `PR #${pr.number}${pr.title ? ` · ${pr.title}` : ""} (${stateLabel})`;
                    const isPrOpen = openPrKey === pr.key;
                    return (
                      <button
                        key={pr.key}
                        type="button"
                        className={`vcs-node-bubble state-${pr.state}${pr.draft ? " is-draft" : ""}${pr.checks === "failure" ? " checks-failed" : ""}${pr.monitoring ? " is-monitoring" : ""}`}
                        title={tooltip}
                        aria-label={tooltip}
                        aria-expanded={isPrOpen}
                        aria-controls={isPrOpen ? prMenuId : undefined}
                        aria-haspopup="dialog"
                        onClick={() => {
                          setOpen(false);
                          setOpenPrKey((current) => (current === pr.key ? null : pr.key));
                        }}
                      >
                        {pr.monitoring ? (
                          <PrMonitoringSyncIcon className="vcs-node-sync-spin" />
                        ) : (
                          <PullRequestIcon merged={pr.state === "merged"} />
                        )}
                      </button>
                    );
                  })
                ) : (
                  <button
                    type="button"
                    className="vcs-node-bubble state-draft-commit"
                    title="Local draft changes · Open Smart Log"
                    aria-label="Local draft changes · Open Smart Log"
                    onClick={onToggleSmartlog}
                  >
                    <UncommittedDraftRingIcon />
                  </button>
                )}
                {activePr && (
                  <div
                    ref={prMenuRef}
                    id={prMenuId}
                    className="repo-menu repo-manage-menu pr-manage-menu"
                    role="dialog"
                    aria-label={`Pull request #${activePr.number}`}
                  >
                    <div className="repo-manage-header">
                      <img
                        className="repo-menu-avatar repo-manage-avatar"
                        src={repoOwnerAvatarUrl({
                          owner: activePrOwner,
                          owner_avatar_url: activePrMatchedRepo?.owner_avatar_url,
                        })}
                        onError={(event) => {
                          const fallback = repoOwnerFallbackAvatar(activePrOwner);
                          if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
                        }}
                        width={32}
                        height={32}
                        alt=""
                      />
                      <div className="repo-menu-identity">
                        <strong>
                          PR #{activePr.number} · {activePr.repo}
                        </strong>
                        <small>{activePr.title ?? "Pull request"}</small>
                      </div>
                      <span
                        className={`repo-manage-badge ${
                          activePr.monitoring
                            ? "monitoring"
                            : activePr.state === "merged"
                              ? "merged"
                              : activePr.checks === "failure"
                                ? "failed"
                                : "connected"
                        }`}
                      >
                        {activePrStateLabel}
                      </span>
                    </div>
                    {(activePr.checksSummary || activePr.latestChange) && (
                      <p className="repo-manage-description">
                        {activePr.latestChange
                          ? `${activePr.latestChange}${activePr.checksSummary ? ` · ${activePr.checksSummary}` : ""}`
                          : activePr.checksSummary}
                      </p>
                    )}
                    <hr className="repo-manage-divider" />
                    {activePr.branchLine && (
                      <div className="repo-manage-field">
                        <span className="repo-manage-field-label">Branches</span>
                        <code className="repo-manage-field-value">{activePr.branchLine}</code>
                      </div>
                    )}
                    <div className="repo-manage-field">
                      <span className="repo-manage-field-label">URL</span>
                      <code className="repo-manage-field-value">{activePr.url}</code>
                      <button
                        type="button"
                        className="repo-manage-copy"
                        title={copiedField === "pr-url" ? "Copied" : "Copy"}
                        aria-label={copiedField === "pr-url" ? "Copied PR URL" : "Copy PR URL"}
                        onClick={() => copyText("pr-url", activePr.url)}
                      >
                        {copiedField === "pr-url" ? <CopiedCheckIcon /> : <CopyButtonIcon />}
                      </button>
                    </div>
                    <div className="repo-manage-actions">
                      <a className="repo-manage-action" href={activePr.url} target="_blank" rel="noopener noreferrer">
                        <span>Open PR on GitHub</span>
                        <ExternalLinkIcon />
                      </a>
                      <a className="repo-manage-action" href={`${activePr.url}/files`} target="_blank" rel="noopener noreferrer">
                        <span>Files changed</span>
                        <ExternalLinkIcon />
                      </a>
                      <a className="repo-manage-action" href={`${activePr.url}/checks`} target="_blank" rel="noopener noreferrer">
                        <span>Checks</span>
                        <ExternalLinkIcon />
                      </a>
                    </div>
                  </div>
                )}
              </span>
            )}
            {isDirty && vcsStatus && (
              <button
                type="button"
                className="repo-picker-trigger vcs-uncommitted-stats"
                title="View uncommitted changes in Smart Log"
                onClick={onToggleSmartlog}
              >
                <span className="vcs-files-count">
                  {vcsStatus.uncommittedFileCount} {vcsStatus.uncommittedFileCount === 1 ? "file" : "files"}
                </span>
                {(vcsStatus.totalAdditions > 0 || vcsStatus.totalDeletions > 0) && (
                  <span className="vcs-churn-counts">
                    <span className="vcs-churn-add">+{vcsStatus.totalAdditions}</span>{" "}
                    <span className="vcs-churn-del">−{vcsStatus.totalDeletions}</span>
                  </span>
                )}
              </button>
            )}
            {checkoutLabel && onToggleSmartlog && (
              <button
                type="button"
                className={`repo-picker-trigger smartlog-trigger${smartlogOpen ? " active" : ""}`}
                aria-label={smartlogOpen ? "Close Smart Log" : "Open Smart Log"}
                aria-pressed={smartlogOpen}
                title={smartlogOpen ? "Close Smart Log" : "Open Smart Log"}
                onClick={onToggleSmartlog}
              >
                {!isDirty && !showNodeRail && (
                  <span className="repo-picker-name">{checkoutLabel}</span>
                )}
                <SmartLogIcon />
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
});

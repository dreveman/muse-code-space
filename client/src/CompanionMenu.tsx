import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Companion } from "./Companions";
import { CompanionMiniStats } from "./CompanionMiniStats";
import { companionForName, companionRoleTitle, isDefaultCompanion } from "./companionRoster";
import { MoreCompanionsButton } from "./MoreCompanionsButton";
import { companionArtwork } from "./companionArtwork";
import { companionWorkingStyle } from "./companionWorkingStyle";
import { companionModelAccess, orderCompanionsByAccess, MUSE_MODEL_BILLING_URL } from "../../server/src/companionModels";
import { CompanionLock } from "./CompanionAccess";

export function CompanionMenu({ name, effort, icon, options, models, picking = false, browsing = false, disabled, disabledReason, busy, onChoose }: {
  name: string;
  effort: string;
  icon: ReactNode;
  options: Companion[];
  models?: readonly { id: string }[];
  picking?: boolean;
  browsing?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
  onChoose: (id: string) => void;
}) {
  const current = companionForName(name);
  const artwork = current && companionArtwork[current.id];
  const [open, setOpen] = useState(false);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const otherOptions = options.filter((companion) => companion.id !== current?.id);
  const defaultOptions = otherOptions.filter(isDefaultCompanion).slice(0, 4);
  const visibleOptions = orderCompanionsByAccess(moreExpanded ? otherOptions : defaultOptions, models);
  const hasMoreOptions = otherOptions.length > defaultOptions.length;
  const [menuMaxHeight, setMenuMaxHeight] = useState<number>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const composer = wrapRef.current?.closest(".terminal-composer");
    composer?.classList.toggle("menu-open", open);
    if (!open) return;
    const measure = () => setMenuMaxHeight(Math.max(0, (triggerRef.current?.getBoundingClientRect().top ?? 16) - 16));
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      composer?.classList.remove("menu-open");
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    wrapRef.current?.querySelector<HTMLElement>(".companion-menu-option:not(:disabled), .more-companions-button")?.focus({ preventScroll: true });
    // A tap can blur with no relatedTarget before its click fires. Close on
    // an actual outside pointer or focus destination instead.
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
  }, [open]);
  useEffect(() => { setOpen(false); }, [name, disabled, busy]);
  useEffect(() => { if (!open) setMoreExpanded(false); }, [open]);
  return <div className="companion-menu-wrap" ref={wrapRef}>
    <button ref={triggerRef} type="button" className="composer-companion-trigger"
      aria-label={`Companion options for ${name}, ${companionWorkingStyle(effort)}`} title="Skills and working style"
      aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      disabled={disabled || busy} onClick={() => setOpen((value) => !value)}>
      {icon}
      <span className="composer-companion-name">{name}</span>
      <span aria-hidden="true">·</span>
      <span className="composer-companion-style">{companionWorkingStyle(effort)}</span>
    </button>
    {open && <div id={id} className="companion-menu" style={{ maxHeight: menuMaxHeight }} role="dialog" aria-label="Choose a companion">
      <div className="companion-menu-current">
        {artwork && <img src={artwork.still} width={44} height={44} alt="" />}
        <span className="companion-menu-identity"><strong>{name}</strong>
          {current && <small>{companionRoleTitle(current.role)}</small>}
        </span>
        <CompanionMiniStats ratings={current?.stats} />
      </div>
      <hr className="companion-menu-divider" />
      <p className="companion-menu-heading">{picking ? "Pick another companion" : "Let another companion take over"}</p>
      {disabledReason ? <p className="companion-menu-note" role="status">{disabledReason}</p> : otherOptions.length === 0
        ? <p className="companion-menu-note">Everyone else is on a task.</p>
        : <><div id={`${id}-companions`} className="companion-menu-list">
          {visibleOptions.map((companion) => {
            const access = companionModelAccess(companion, models);
            const locked = access.status !== "ready";
            const upgradeRequired = access.status === "upgrade-required";
            const content = <>
              <img src={companion.artwork.still} width={44} height={44} alt="" />
              <span className="companion-menu-identity"><strong>{companion.name}{locked && <CompanionLock />}</strong>
                <small>{!browsing && locked ? (upgradeRequired ? "Upgrade required" : "Unavailable") : companionRoleTitle(companion.role)}</small></span>
              <CompanionMiniStats ratings={companion.stats} />
            </>;
            if (!browsing && upgradeRequired) return <a key={companion.id} className="companion-menu-option companion-menu-upgrade"
              href={MUSE_MODEL_BILLING_URL} target="_blank" rel="noopener noreferrer" aria-label={`Upgrade to work with ${companion.name}`}>
              {content}
            </a>;
            return <button type="button" key={companion.id} className="companion-menu-option"
              disabled={!browsing && access.status !== "ready"}
              title={!browsing && locked ? "This model is unavailable." : undefined}
              onClick={() => { setOpen(false); triggerRef.current?.focus(); onChoose(companion.id); }}>
              {content}
            </button>;
          })}
        </div>
        {hasMoreOptions && <MoreCompanionsButton expanded={moreExpanded} controls={`${id}-companions`}
          onToggle={() => setMoreExpanded((value) => !value)} />}
        </>}
    </div>}
  </div>;
}

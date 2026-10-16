import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { companionDefinitions, companionRoleTitle } from "./companionRoster";
import { companionArtwork } from "./companionArtwork";
import { agentNameHue } from "./agentColor";
import { displayModelLabel } from "./modelLabel";
import { companionModelAccess } from "../../server/src/companionModels";
import { CompanionAccessNotice, CompanionLock } from "./CompanionAccess";
import { CompanionAvatar, isIdleMotionAllowed, subscribeIdleMotion } from "./CompanionAvatar";
import { ExpandButton } from "./MoreCompanionsButton";
import "./companions.css";

// Read-only seed definitions in this checkpoint. No session or pilot actions.
export const companions = companionDefinitions.map((companion) => {
  const artwork = companionArtwork[companion.id];
  if (!artwork) throw new Error(`Missing artwork for ${companion.id}`);
  return { ...companion, artwork };
});
export type Companion = (typeof companions)[number];
const stats = [
  ["speed", "Speed"],
  ["thoughtfulness", "Thoughtfulness"],
  ["creativity", "Creativity"],
  ["initiative", "Initiative"],
] as const;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function CompanionRatings({ companion }: { companion: Companion }) {
  return (
    <dl className="companion-stats" aria-label="Working style ratings">
      {stats.map(([key, label]) => (
        <div className="companion-stat" key={key}>
          <dt>{label}</dt>
          <dd aria-label={`${companion.stats[key]} out of 5`}>
            <span className="companion-stat-bars" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((level) => <span key={level} className={level <= companion.stats[key] ? "filled" : ""} />)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CompanionConfiguration({ companion }: { companion: Companion }) {
  return <>
    <dl className="companion-configuration">
      <div><dt>Preferred model</dt><dd>{displayModelLabel(companion.model.preferredId)}</dd></div>
      <div><dt>Effort</dt><dd>{companion.effort === "xhigh" ? "Extra high" : companion.effort}</dd></div>
    </dl>
    <p className="companion-ratings-note">Ratings reflect relative strengths, model, and working style.</p>
    <details className="companion-soul">
      <summary>SOUL.md</summary>
      <pre>{companion.artwork.soul}</pre>
    </details>
  </>;
}

function CompanionCard({ companion, visible, models }: { companion: Companion; visible: boolean; models?: readonly { id: string }[] }) {
  const cardRef = useRef<HTMLElement>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [idleMotionAllowed, setIdleMotionAllowed] = useState(isIdleMotionAllowed);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const access = companionModelAccess(companion, models);
  const locked = access.status !== "ready";
  useEffect(() => subscribeIdleMotion(setIdleMotionAllowed), []);
  const motion = !locked && !reducedMotion && idleMotionAllowed && visible;
  const cardStill = companion.artwork.cardStill;
  const source = motion ? companion.artwork.cardIdle : cardStill;
  const imageSource = failedSource === source ? cardStill : source;
  return (
    <article ref={cardRef} className={`companion-card${locked ? " companion-card-locked" : ""}${detailsOpen ? " companion-card-expanded" : ""}`} aria-labelledby="companion-card-name"
      style={{ "--companion-hue": agentNameHue(companion.name) } as CSSProperties}>
      <div className="companion-card-identity">
        <div className="companion-card-portrait">
          <img src={imageSource} width={256} height={256} alt={companion.character}
            decoding="async" onError={() => setFailedSource(source)} />
          {locked && <span className="companion-unavailable-banner">Unavailable</span>}
        </div>
        <header className="companion-card-heading">
          <p className="companion-card-role">{companion.role}</p>
          <h2 id="companion-card-name">{companion.name}</h2>
          <p className="companion-card-description">{companion.description}</p>
        </header>
      </div>
      <div className="companion-card-access">
        <CompanionAccessNotice access={access} modelName={displayModelLabel(companion.model.preferredId)} compact />
        {(access.status === "ready" || detailsOpen) && <p className="companion-phone-description">{companion.description}</p>}
      </div>
      <CompanionRatings companion={companion} />
      <section className="companion-skills" aria-labelledby="companion-skills-heading">
        <h3 id="companion-skills-heading">Best at</h3>
        <ul>{companion.skills.map((skill) => <li key={skill}>{skill}</li>)}</ul>
      </section>
      <section className="companion-tradeoff" aria-labelledby="companion-tradeoff-heading">
        <h3 id="companion-tradeoff-heading">The trade-off</h3>
        <p>{companion.tradeOff}</p>
      </section>
      <section className="companion-details">
        <ExpandButton expanded={detailsOpen} controls="companion-details-content"
          className="companion-more-button" onToggle={() => {
            if (!detailsOpen && cardRef.current) {
              // Preserve the space distributed by the fixed-height card when
              // its additional content makes the expanded card grow.
              for (const section of ["skills", "details"]) {
                const element = cardRef.current.querySelector<HTMLElement>(`.companion-${section}`);
                if (element) cardRef.current.style.setProperty(`--companion-${section}-spacing`,
                  section === "skills" ? getComputedStyle(element).marginBottom : getComputedStyle(element).marginTop);
              }
            }
            setDetailsOpen((open) => !open);
          }}>
          More about {companion.name}
        </ExpandButton>
        {detailsOpen && <div id="companion-details-content"><CompanionConfiguration companion={companion} /></div>}
      </section>
    </article>
  );
}

export function CompanionContact({ companion, selected, disabled, models, onSelect }: {
  companion: Companion;
  selected: boolean;
  disabled?: boolean;
  models?: readonly { id: string }[];
  onSelect: () => void;
}) {
  const access = companionModelAccess(companion, models);
  return (
    <button type="button" className="companion-contact"
      aria-current={selected ? "true" : undefined}
      style={{ "--companion-hue": agentNameHue(companion.name) } as CSSProperties}
      onClick={onSelect} disabled={disabled}>
      {/* Still in the Available list: motion is reserved for companions
          with a task in the sidebar (their session rows animate). */}
      <CompanionAvatar artwork={companion.artwork} animate={false} />
      <span><strong>{companion.name}{access.status !== "ready" && <span title={access.status === "upgrade-required" ? "Upgrade required" : "Unavailable"}><CompanionLock /></span>}</strong><small>{companionRoleTitle(companion.role)}</small></span>
    </button>
  );
}

export function CompanionWelcome({ companion, visible, models, availableIds, onBrowse, browsingDisabled, composer, onBack, actions }: {
  companion: Companion;
  visible: boolean;
  models?: readonly { id: string }[];
  availableIds: string[];
  onBrowse: (id: string) => void;
  browsingDisabled?: boolean;
  composer?: ReactNode;
  onBack: () => void;
  actions?: ReactNode;
}) {
  const welcomeRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery("(max-width: 779px)");
  useLayoutEffect(() => {
    const element = welcomeRef.current;
    if (!phone || !visible || !element) return;
    const viewport = window.visualViewport;
    const measure = () => {
      if (!viewport || viewport.scale !== 1) return;
      const height = Math.max(0, viewport.height + viewport.offsetTop - element.getBoundingClientRect().top);
      element.style.maxHeight = `${Math.floor(height)}px`;
    };
    measure();
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      element.style.removeProperty("max-height");
    };
  }, [phone, visible]);
  const index = availableIds.indexOf(companion.id);
  const canBrowse = index >= 0 && availableIds.length > 1;
  const browse = (direction: -1 | 1) => {
    if (canBrowse && !browsingDisabled) onBrowse(availableIds[(index + direction + availableIds.length) % availableIds.length]!);
  };
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [companion.id]);
  return (
    <section ref={welcomeRef} className="companion-welcome" aria-labelledby="companion-welcome-heading">
      <header className="chat-floating-toolbar companion-welcome-header">
        <button className="mobile-back-button" type="button" onClick={onBack} aria-label="Back to companions">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 12H6M11 7l-5 5 5 5" />
          </svg>
        </button>
        <h2 id="companion-welcome-heading" className="companion-sr-only" tabIndex={-1}>Meet {companion.name}</h2>
        <div className="chat-floating-actions">{actions}</div>
      </header>
      <div className="companion-welcome-content" ref={contentRef}>
        <div className="companion-card-browser">
          {canBrowse && <nav className="companion-card-navigation" aria-label="Browse available companions">
            <button type="button" onClick={() => browse(-1)} disabled={browsingDisabled} aria-label="Previous companion">‹</button>
            <button type="button" onClick={() => browse(1)} disabled={browsingDisabled} aria-label="Next companion">›</button>
          </nav>}
          <CompanionCard key={companion.id} companion={companion} visible={visible} models={models} />
        </div>
      </div>
      {composer}
    </section>
  );
}

import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { builtinCompanionDefinitions, companionDefinitions, companionForName, companionRoleTitle } from "./companionRoster";
import { companionArtwork, type CompanionArtwork } from "./companionArtwork";
import { agentNameHue } from "./agentColor";
import { displayModelLabel } from "./modelLabel";
import { companionModelAccess, computeCompanionStats, PAID_COMPANION_MODELS, type CompanionStats } from "../../server/src/companionModels";
import {
  companionAccomplishments,
  highestAccomplishmentIcon,
  type AccomplishmentIcon,
  type AccomplishmentNotice,
  type CompanionStatisticsSummary,
} from "../../server/src/companionStatistics";
import { companionMusicOf, type CompanionMusic } from "../../server/src/companionMusic";
import { CompanionMusicSection, CompanionTunedBadge } from "./SpotifyMusic";
import { CompanionAccessNotice, CompanionLock } from "./CompanionAccess";
import { CompanionAvatar, isAnimationPreloaded, isIdleMotionAllowed, subscribeIdleMotion, useProgressiveCompanionImage } from "./CompanionAvatar";
import { ExpandButton } from "./MoreCompanionsButton";
import "./companions.css";

export type Companion = {
  id: string;
  iconId: string;
  name: string;
  character: string;
  role: string;
  description: string;
  skills: string[];
  tradeOff: string;
  music: CompanionMusic | null;
  stats: CompanionStats;
  model: { preferredId: string; ifUnavailable: string };
  effort: string;
  artwork: CompanionArtwork;
  custom?: boolean;
};

function toCompanion(definition: (typeof companionDefinitions)[number]): Companion {
  const artwork = companionArtwork[definition.id];
  if (!artwork) throw new Error(`Missing artwork for ${definition.id}`);
  return {
    id: definition.id,
    iconId: definition.id,
    name: definition.name,
    character: definition.character,
    role: definition.role,
    description: definition.description,
    skills: [...definition.skills],
    tradeOff: definition.tradeOff,
    music: companionMusicOf(definition),
    stats: computeCompanionStats(definition.model.preferredId, definition.effort),
    model: definition.model,
    effort: definition.effort,
    artwork,
  };
}

// Built-in companions available on a fresh install, in sidebar order.
export const companions: Companion[] = builtinCompanionDefinitions.map(toCompanion);

// Every catalog entry, including artwork donors for the icon picker.
export const iconDonorCompanions: Companion[] = companionDefinitions.map(toCompanion);

export type CustomCompanionRecord = {
  id: string;
  name: string;
  icon_id: string;
  icon_data_url: string | null;
  character: string;
  role: string;
  description: string;
  skills: string[];
  trade_off: string;
  soul: string;
  model_id: string;
  effort: string;
};

// Session rows and transcripts resolve artwork by companion name (the session
// title bridge). Custom companions register here once loaded so their borrowed
// artwork shows up in those name-only contexts too.
const customArtworkByName = new Map<string, CompanionArtwork>();
export function registerCustomCompanionArtwork(customs: readonly Companion[]): void {
  customArtworkByName.clear();
  for (const companion of customs) {
    customArtworkByName.set(companion.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(), companion.artwork);
  }
}
export function artworkForCompanionName(name: string): CompanionArtwork | undefined {
  const custom = customArtworkByName.get(name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase());
  if (custom) return custom;
  const definition = companionForName(name);
  return definition ? companionArtwork[definition.id] : undefined;
}

export function customCompanionToCompanion(record: CustomCompanionRecord): Companion {
  const donorArtwork = companionArtwork[record.icon_id] ?? companionArtwork[builtinCompanionDefinitions[0]!.id]!;
  // An uploaded icon is a single image used for every artwork slot.
  const uploaded = record.icon_data_url
    ? { cardIdle: record.icon_data_url, portraitIdle: record.icon_data_url, cardStill: record.icon_data_url, working: record.icon_data_url, waking: record.icon_data_url, still: record.icon_data_url }
    : null;
  return {
    id: record.id,
    iconId: record.icon_id,
    name: record.name,
    character: record.character,
    role: record.role,
    description: record.description,
    skills: [...record.skills],
    tradeOff: record.trade_off,
    music: null,
    stats: computeCompanionStats(record.model_id, record.effort),
    model: {
      preferredId: record.model_id,
      ifUnavailable: Object.hasOwn(PAID_COMPANION_MODELS, record.model_id) ? "upgrade-required" : "use-catalog-default",
    },
    effort: record.effort,
    artwork: { ...donorArtwork, ...(uploaded ?? {}), soul: record.soul },
    custom: true,
  };
}
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

function formatCompactCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    const scaled = value / 1000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}k`;
  }
  const scaled = value / 1_000_000;
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}M`;
}

function AccomplishmentIcon({ kind }: { kind: AccomplishmentIcon }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "trophy" && <>
        <path d="M6.5 3.5h11v5a5.5 5.5 0 0 1-11 0v-5Z" fill="currentColor" fillOpacity="0.14" />
        <path d="M6.5 5.5H4.2a1.7 1.7 0 0 0-1.7 1.7v.5a3.8 3.8 0 0 0 3.8 3.8h.5" />
        <path d="M17.5 5.5h2.3a1.7 1.7 0 0 1 1.7 1.7v.5a3.8 3.8 0 0 1-3.8 3.8h-.5" />
        <path d="M12 14v3.5" />
        <path d="M9 17.5h6" />
        <path d="M7.5 20.5h9" />
      </>}
      {kind === "medal" && <>
        <path d="M8.5 9.8 5.8 3h4.3L12 7.2 13.9 3h4.3l-2.7 6.8" />
        <circle cx="12" cy="15" r="5.5" fill="currentColor" fillOpacity="0.14" />
        <path d="m12 11.9.95 1.92 2.12.31-1.53 1.5.36 2.11L12 16.74l-1.9 1 .36-2.11-1.53-1.5 2.12-.31L12 11.9Z" fill="currentColor" stroke="none" />
      </>}
      {kind === "badge" && <>
        <path d="m8.8 14.1-1.6 6.7 4.8-2.5 4.8 2.5-1.6-6.7" />
        <circle cx="12" cy="9.5" r="5.5" fill="currentColor" fillOpacity="0.14" />
        <path d="m9.6 9.6 1.65 1.65 3.35-3.35" />
      </>}
    </svg>
  );
}

const ACCOMPLISHMENT_TIER_NAMES: Record<AccomplishmentIcon, string> = {
  badge: "Badge", medal: "Medal", trophy: "Trophy",
};

function AccomplishmentMilestones({ statistics }: { statistics: CompanionStatisticsSummary }) {
  const items = companionAccomplishments(statistics);
  return (
    <ul className="companion-accomplishment-list">
      {items.map((item) => (
        <li key={item.id} className={`companion-accomplishment${item.earnedThreshold > 0 ? " is-earned" : ""}`}>
          <span className="companion-accomplishment-icon"><AccomplishmentIcon kind={item.icon} /></span>
          <span className="companion-accomplishment-label">{item.label}</span>
          <span className="companion-accomplishment-progress">
            {item.earnedThreshold > 0
              ? `${ACCOMPLISHMENT_TIER_NAMES[item.icon]} · ${formatCompactCount(item.current)}${item.nextThreshold ? ` · next at ${formatCompactCount(item.nextThreshold)}` : " · highest tier"}`
              : `Not yet · ${formatCompactCount(item.current)} / ${item.nextThreshold ? formatCompactCount(item.nextThreshold) : ""}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Compact single row of accomplishments (title on the left, icons + numbers
// and expand chevron on the right) that expands to the milestone details.
export function CompanionAccomplishmentsRow({ statistics, expanded, onToggle }: {
  statistics?: CompanionStatisticsSummary | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!statistics) return null;
  const items = companionAccomplishments(statistics);
  const earned = items.filter((item) => item.earnedThreshold > 0).length;
  const linesItem = items.find((item) => item.id === "lines-shipped");
  const linesIcon: AccomplishmentIcon = linesItem && linesItem.earnedThreshold > 0 ? linesItem.icon : "medal";
  return (
    <div className="companion-accomplishments">
      <button type="button" className="more-companions-button companion-accomplishments-row" aria-expanded={expanded} onClick={onToggle}
        aria-label={`Accomplishments: ${statistics.prs_merged} PRs landed, ${statistics.lines_added} lines shipped, ${earned} of ${items.length} milestones earned. ${expanded ? "Hide" : "Show"} details.`}>
        <span className="companion-accomplishments-label">Accomplishments</span>
        <span className="companion-accomplishments-items">
          <span className={`companion-accomplishments-item${statistics.prs_merged > 0 ? " is-earned" : ""}`} title="PRs landed">
            <AccomplishmentIcon kind="trophy" />{formatCompactCount(statistics.prs_merged)}
          </span>
          <span className={`companion-accomplishments-item${statistics.lines_added > 0 ? " is-earned" : ""}`} title="Lines shipped">
            <AccomplishmentIcon kind={linesIcon} />{formatCompactCount(statistics.lines_added)}
          </span>
          <span className={`companion-accomplishments-item${earned > 0 ? " is-earned" : ""}`} title="Milestones earned">
            <AccomplishmentIcon kind="badge" />{earned}/{items.length}
          </span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded && <AccomplishmentMilestones statistics={statistics} />}
    </div>
  );
}

export function AccomplishmentCelebrationEvent({ notice }: { notice: AccomplishmentNotice }) {
  const hue = agentNameHue(notice.companionName);
  const leadIcon = highestAccomplishmentIcon(notice.icons);
  const milestoneSummary = notice.milestones.join(" · ");
  const earnedSuffix = notice.summaryText.replace(/^earned\s+/, "");
  return (
    <div
      className={`accomplishment-celebration is-${leadIcon}`}
      style={{ "--companion-hue": hue } as CSSProperties}
      role="status"
      aria-label={`${notice.companionName} ${notice.summaryText}: ${milestoneSummary}`}
    >
      <span className="accomplishment-celebration-emblem" aria-hidden="true">
        <AccomplishmentIcon kind={leadIcon} />
        <span className="accomplishment-sparkle s1" />
        <span className="accomplishment-sparkle s2" />
        <span className="accomplishment-sparkle s3" />
      </span>
      <span className="accomplishment-celebration-body">
        <span className="accomplishment-celebration-title">
          <strong>{notice.companionName}</strong> earned <strong>{earnedSuffix}</strong>
        </span>
      </span>
      <span className="accomplishment-celebration-pill">{milestoneSummary}</span>
    </div>
  );
}

let savedDetailsOpen = false;
let savedSoulOpen = false;
let savedSpacing: { skills?: string; details?: string } = {};

function CompanionConfiguration({
  companion,
  soulOpen,
  onToggleSoul,
}: {
  companion: Companion;
  soulOpen: boolean;
  onToggleSoul: (open: boolean) => void;
}) {
  return <>
    <dl className="companion-configuration">
      <div><dt>Preferred model</dt><dd>{displayModelLabel(companion.model.preferredId)}</dd></div>
      <div><dt>Effort</dt><dd>{companion.effort === "xhigh" ? "Extra high" : companion.effort}</dd></div>
    </dl>
    <CompanionMusicSection companion={companion} />
    <details
      className="companion-soul"
      open={soulOpen}
      onToggle={(event) => onToggleSoul(event.currentTarget.open)}
    >
      <summary>SOUL.md</summary>
      <pre>{companion.artwork.soul}</pre>
    </details>
  </>;
}

const CompanionCard = memo(function CompanionCard({
  companion,
  visible,
  models,
  statistics,
  detailsOpen,
  onToggleDetails,
  soulOpen,
  onToggleSoul,
}: {
  companion: Companion;
  visible: boolean;
  models?: readonly { id: string }[];
  statistics?: CompanionStatisticsSummary | null;
  detailsOpen: boolean;
  onToggleDetails: (next: boolean) => void;
  soulOpen: boolean;
  onToggleSoul: (next: boolean) => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [accomplishmentsOpen, setAccomplishmentsOpen] = useState(false);
  const [idleMotionAllowed, setIdleMotionAllowed] = useState(isIdleMotionAllowed);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const access = companionModelAccess(companion, models);
  const locked = access.status !== "ready";
  useEffect(() => subscribeIdleMotion(setIdleMotionAllowed), []);
  const motion = !locked && !reducedMotion && idleMotionAllowed && visible;
  const cardStill = companion.artwork.cardStill;
  const { source: imageSource, onStillLoad, onError } = useProgressiveCompanionImage(
    cardStill,
    companion.artwork.cardIdle,
    motion,
  );
  const spacingStyle = {
    "--companion-hue": agentNameHue(companion.name),
    ...(savedSpacing.skills ? { "--companion-skills-spacing": savedSpacing.skills } : {}),
    ...(savedSpacing.details ? { "--companion-details-spacing": savedSpacing.details } : {}),
  } as CSSProperties;
  const isExpanded = detailsOpen || accomplishmentsOpen;
  const captureCardSpacing = () => {
    if (!isExpanded && cardRef.current) {
      // Preserve the space distributed by the fixed-height card when
      // its additional content makes the expanded card grow.
      for (const section of ["skills", "details"] as const) {
        const element = cardRef.current.querySelector<HTMLElement>(`.companion-${section}`);
        if (element) {
          const val = section === "skills" ? getComputedStyle(element).marginBottom : getComputedStyle(element).marginTop;
          savedSpacing[section] = val;
          cardRef.current.style.setProperty(`--companion-${section}-spacing`, val);
        }
      }
    }
  };
  return (
    <article ref={cardRef} className={`companion-card${locked ? " companion-card-locked" : ""}${isExpanded ? " companion-card-expanded" : ""}`} aria-labelledby="companion-card-name"
      style={spacingStyle}>
      <div className="companion-card-identity">
        <div className="companion-card-portrait">
          <img src={imageSource} width={256} height={256} alt={companion.character}
            fetchPriority="high" decoding={isAnimationPreloaded(imageSource) ? "sync" : "async"} onLoad={onStillLoad} onError={onError} />
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
        {(access.status === "ready" || isExpanded) && <p className="companion-phone-description">{companion.description}</p>}
      </div>
      <CompanionAccomplishmentsRow statistics={statistics} expanded={accomplishmentsOpen}
        onToggle={() => {
          captureCardSpacing();
          setAccomplishmentsOpen((value) => !value);
        }} />
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
            captureCardSpacing();
            onToggleDetails(!detailsOpen);
          }}>
          More about {companion.name}
        </ExpandButton>
        {detailsOpen && (
          <div id="companion-details-content">
            <CompanionConfiguration companion={companion} soulOpen={soulOpen} onToggleSoul={onToggleSoul} />
          </div>
        )}
      </section>
    </article>
  );
});

export function CompanionContact({ companion, selected, disabled, models, onSelect }: {
  companion: Companion;
  selected: boolean;
  disabled?: boolean;
  models?: readonly { id: string }[];
  onSelect: () => void;
}) {
  const access = companionModelAccess(companion, models);
  const roleLabel = companionRoleTitle(companion.role);
  return (
    <button type="button" className="companion-contact"
      aria-current={selected ? "true" : undefined}
      title={`${companion.name} — ${roleLabel}`}
      style={{ "--companion-hue": agentNameHue(companion.name) } as CSSProperties}
      onClick={onSelect} disabled={disabled}>
      {/* Still in the Available list: motion is reserved for companions
          with a task in the sidebar (their session rows animate). */}
      <span className="companion-contact-avatar-wrap">
        <CompanionAvatar artwork={companion.artwork} animate={false} />
        <CompanionTunedBadge music={companion.music} className="sidebar-contact-tuned-badge" />
      </span>
      <span><strong>{companion.name}{access.status !== "ready" && <span title={access.status === "upgrade-required" ? "Upgrade required" : "Unavailable"}><CompanionLock /></span>}</strong><small>{roleLabel}</small></span>
    </button>
  );
}

export function CompanionWelcome({ companion, visible, models, statistics, availableIds, onBrowse, browsingDisabled, composer, onBack, actions }: {
  companion: Companion;
  visible: boolean;
  models?: readonly { id: string }[];
  statistics?: CompanionStatisticsSummary | null;
  availableIds: string[];
  onBrowse: (id: string) => void;
  browsingDisabled?: boolean;
  composer?: ReactNode;
  onBack: () => void;
  actions?: ReactNode;
}) {
  const welcomeRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const uiStateQuery = useQuery({
    queryKey: ["ui-state"],
    queryFn: () => api.getUiState({}),
    staleTime: Infinity,
    retry: false,
  });
  const [detailsOpen, setDetailsOpenState] = useState(() => savedDetailsOpen);
  const [soulOpen, setSoulOpenState] = useState(() => savedSoulOpen);
  const restoredDetailsRef = useRef(false);
  useEffect(() => {
    if (restoredDetailsRef.current || !uiStateQuery.data) return;
    restoredDetailsRef.current = true;
    const shouldExpandDetails = uiStateQuery.data.details_open || uiStateQuery.data.spotify_setup_open || Boolean(uiStateQuery.data.spotify_started_state);
    if (shouldExpandDetails !== savedDetailsOpen) {
      savedDetailsOpen = shouldExpandDetails;
      setDetailsOpenState(shouldExpandDetails);
    }
    if (uiStateQuery.data.soul_open !== savedSoulOpen) {
      savedSoulOpen = uiStateQuery.data.soul_open;
      setSoulOpenState(uiStateQuery.data.soul_open);
    }
  }, [uiStateQuery.data]);
  const setDetailsOpen = (next: boolean) => {
    savedDetailsOpen = next;
    setDetailsOpenState(next);
    void api.setUiState({ details_open: next, ...(next ? {} : { spotify_setup_open: false }) })
      .then(() => queryClient.invalidateQueries({ queryKey: ["ui-state"] }))
      .catch(() => undefined);
  };
  const setSoulOpen = (next: boolean) => {
    savedSoulOpen = next;
    setSoulOpenState(next);
    void api.setUiState({ soul_open: next })
      .then(() => queryClient.invalidateQueries({ queryKey: ["ui-state"] }))
      .catch(() => undefined);
  };
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
      <div className="companion-welcome-stage">
        {canBrowse && <nav className="companion-card-navigation" aria-label="Browse available companions">
          <button type="button" onClick={() => browse(-1)} disabled={browsingDisabled} aria-label="Previous companion">‹</button>
          <button type="button" onClick={() => browse(1)} disabled={browsingDisabled} aria-label="Next companion">›</button>
        </nav>}
        <div className="companion-welcome-content" ref={contentRef}>
          <div className="companion-card-browser">
            <CompanionCard
              key={companion.id}
              companion={companion}
              visible={visible}
              models={models}
              statistics={statistics}
              detailsOpen={detailsOpen}
              onToggleDetails={setDetailsOpen}
              soulOpen={soulOpen}
              onToggleSoul={setSoulOpen}
            />
          </div>
        </div>
      </div>
      {composer}
    </section>
  );
}

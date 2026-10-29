import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { agentNameHue } from "./agentColor";
import { artworkForCompanionName, CompanionAccomplishmentsRow, companions, type Companion } from "./Companions";
import { CompanionMusicBanner, CompanionMusicSection, CompanionTunedBadge } from "./SpotifyMusic";
import {
  isAnimationPreloaded,
  isIdleMotionAllowed,
  isSlowConnection,
  markAnimationPreloaded,
  subscribeIdleMotion,
  subscribeSlowConnection,
  useProgressiveCompanionImage,
} from "./CompanionAvatar";
import { displayModelLabel } from "./modelLabel";
import { ExpandButton } from "./MoreCompanionsButton";
import { parseAgentsRow } from "./AgentsEvent";
import { parsePrMonitor } from "./prMonitor";

const RATING_STATS = [
  ["speed", "Speed"],
  ["thoughtfulness", "Thoughtfulness"],
  ["creativity", "Creativity"],
  ["initiative", "Initiative"],
] as const;

export type TranscriptActivitySourceEvent = {
  id: number;
  kind: string;
  content: string;
  created_at: string;
};

type TaskActivityItem = {
  id: string;
  text: string;
  timeLabel: string;
  timestampMs: number;
  live?: boolean;
};

type TaskActivityGroup = {
  key: string;
  label: string;
  items: TaskActivityItem[];
};

const dayMonthFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const timeOfDayFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function startOfLocalDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDayBucketLabel(ms: number, nowMs: number): { key: string; label: string } {
  const dayStart = startOfLocalDayMs(ms);
  const todayStart = startOfLocalDayMs(nowMs);
  const diffDays = Math.round((todayStart - dayStart) / 86_400_000);
  if (diffDays <= 0) return { key: "today", label: "Today" };
  if (diffDays === 1) return { key: "yesterday", label: "Yesterday" };
  return { key: `day-${dayStart}`, label: dayMonthFormatter.format(new Date(ms)) };
}

function summarizeMarkdownOneLine(raw: string): string | null {
  const lines = raw.split("\n");
  let inFence = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed) continue;
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) continue;
    if (/^(\|.*\|[-:| ]+\|)$/.test(trimmed)) continue;
    const cleaned = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+>]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 3) return cleaned;
  }
  return null;
}

function buildTaskActivityGroups(
  events: readonly TranscriptActivitySourceEvent[],
  taskSummary: string | null | undefined,
  startedAt: string | undefined,
  nowMs: number,
): TaskActivityGroup[] {
  const items: TaskActivityItem[] = [];

  for (const event of events) {
    const atMs = Date.parse(event.created_at);
    const validMs = Number.isFinite(atMs) ? atMs : nowMs;
    if (event.kind === "stdout") {
      const line = summarizeMarkdownOneLine(event.content);
      if (line) {
        items.push({
          id: `ev-${event.id}`,
          text: line,
          timeLabel: timeOfDayFormatter.format(new Date(validMs)),
          timestampMs: validMs,
        });
      }
    } else if (event.kind === "pr_monitor") {
      const pr = parsePrMonitor(event.content);
      if (pr) {
        const verb =
          pr.status === "merged"
            ? `Merged PR #${pr.number}`
            : pr.status === "closed"
              ? `Closed PR #${pr.number}`
              : `Monitoring PR #${pr.number}`;
        items.push({
          id: `pr-${event.id}`,
          text: pr.title ? `${verb} · ${pr.title}` : verb,
          timeLabel: timeOfDayFormatter.format(new Date(validMs)),
          timestampMs: validMs,
        });
      }
    } else if (event.kind === "agents") {
      const row = parseAgentsRow(event.content);
      if (row?.title) {
        items.push({
          id: `ag-${event.id}`,
          text: row.title,
          timeLabel: timeOfDayFormatter.format(new Date(validMs)),
          timestampMs: validMs,
        });
      }
    }
  }

  if (items.length === 0 && taskSummary?.trim()) {
    const startMs = startedAt ? Date.parse(startedAt) : NaN;
    const validMs = Number.isFinite(startMs) ? startMs : nowMs;
    items.push({
      id: "task-start",
      text: taskSummary.trim(),
      timeLabel: timeOfDayFormatter.format(new Date(validMs)),
      timestampMs: validMs,
    });
  }

  // Newest first.
  items.reverse();

  const groups: TaskActivityGroup[] = [];
  for (const item of items) {
    const { key, label } = formatDayBucketLabel(item.timestampMs, nowMs);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function CompanionPortrait({ source, stillSource, crossFade, onError }: {
  source: string;
  stillSource?: string;
  crossFade: boolean;
  onError: () => void;
}) {
  const baseLayer = stillSource ?? source;
  const startShown = isAnimationPreloaded(source) ? source : baseLayer;
  const [layers, setLayers] = useState<string[]>(() => {
    const initial = [baseLayer];
    if (source !== baseLayer) initial.push(source);
    return initial;
  });
  const [shown, setShown] = useState(startShown);
  const loaded = useRef(new Set<string>([baseLayer, ...(isAnimationPreloaded(source) ? [source] : [])]));

  useLayoutEffect(() => {
    loaded.current.add(baseLayer);
    const sourceReady = loaded.current.has(source) || isAnimationPreloaded(source);
    if (sourceReady) {
      loaded.current.add(source);
      setShown(source);
    }
    setLayers((current) => {
      if (!crossFade && sourceReady) {
        return source === baseLayer ? [baseLayer] : [baseLayer, source];
      }
      const next = current.includes(baseLayer) ? [...current] : [baseLayer, ...current];
      if (!next.includes(source)) next.push(source);
      return next;
    });
  }, [source, baseLayer, crossFade]);

  useEffect(() => {
    // Retire outgoing animated layers after the 640ms fade so their animations
    // stop, while keeping `baseLayer` (still.png) permanently mounted underneath.
    const timer = window.setTimeout(() => {
      setLayers((current) => {
        const filtered = current.filter((layer) => layer === baseLayer || layer === shown || layer === source);
        return filtered.length === current.length ? current : filtered;
      });
    }, 660);
    return () => window.clearTimeout(timer);
  }, [shown, source, baseLayer]);

  return <span className="transcript-companion-portrait" aria-hidden="true">
    {layers.map((layer) => <img key={layer} className="transcript-companion-image"
      src={layer} width={64} height={64} alt="" decoding={isAnimationPreloaded(layer) ? "sync" : "async"}
      style={{ opacity: layer === baseLayer || layer === shown ? 1 : 0 }}
      onLoad={(event) => {
        loaded.current.add(layer);
        markAnimationPreloaded(layer, event.currentTarget);
        if (layer !== source) return;
        // Establish the starting opacity even when the image is cached.
        void getComputedStyle(event.currentTarget).opacity;
        setShown(layer);
      }}
      onError={() => {
        if (layer === source) {
          setShown(baseLayer);
          onError();
        }
      }} />)}
  </span>;
}

export const TranscriptCompanion = memo(function TranscriptCompanion({
  name,
  companion: companionProp,
  summary,
  startedAt,
  events = [],
  active,
  starting,
  activity,
  visible,
  archived = false,
  connecting = false,
}: {
  name: string;
  companion?: Companion;
  summary?: string | null;
  startedAt?: string;
  events?: readonly TranscriptActivitySourceEvent[];
  active: boolean;
  starting: boolean;
  activity: string;
  visible: boolean;
  archived?: boolean;
  connecting?: boolean;
}) {
  const companion =
    companionProp ??
    companions.find((item) => item.name.toLowerCase() === name.toLowerCase()) ??
    companions[0];
  const artwork = companion?.artwork ?? artworkForCompanionName(name);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [visibleOpen, setVisibleOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"activity" | "companion">("activity");
  const [accomplishmentsOpen, setAccomplishmentsOpen] = useState(false);
  const statisticsQuery = useQuery({
    queryKey: ["companion-statistics"],
    queryFn: () => api.getCompanionStatistics({}),
    enabled: mounted,
    staleTime: 5000,
    refetchInterval: 30_000,
    retry: false,
  });
  const statistics = statisticsQuery.data?.statistics.find((row) => row.companion_id === companion?.id) ?? null;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [soulOpen, setSoulOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setVisibleOpen(false);
    const timer = window.setTimeout(() => {
      setMounted(false);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    // Force style/layout commit of the initial collapsed state before flipping
    // .is-open so the opening transition always animates from the top icon.
    void dropdownRef.current?.getBoundingClientRect();
    let frame2 = 0;
    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        setVisibleOpen(true);
      });
    });
    return () => {
      cancelAnimationFrame(frame1);
      if (frame2) cancelAnimationFrame(frame2);
    };
  }, [open, mounted]);
  // Choose the first frame before mounting the image. Starting with a still
  // would briefly show the idle pose before the wake-up animation.
  const [motionAllowed, setMotionAllowed] = useState(() =>
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches && !document.hidden);
  const [idleMotionAllowed, setIdleMotionAllowed] = useState(isIdleMotionAllowed);
  const [slowConnection, setSlowConnection] = useState(isSlowConnection);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionAllowed(!media.matches && !document.hidden);
    update();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    const stopIdle = subscribeIdleMotion(setIdleMotionAllowed);
    const stopSlow = subscribeSlowConnection(setSlowConnection);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      stopIdle();
      stopSlow();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
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
  }, [open]);
  const animation = starting ? "waking" : active ? "working" : "idle";
  const animatedSource = artwork && (animation === "idle" ? artwork.portraitIdle : artwork[animation]);
  const canLoadAnimated = !slowConnection || isAnimationPreloaded(animatedSource);
  const canAnimate = (animation === "idle" ? idleMotionAllowed : motionAllowed) && canLoadAnimated && visible && !archived;
  const source = artwork && (canAnimate ? animatedSource : artwork.still);
  const imageSource = failedSource === source ? artwork?.still : source;
  const activityLabel = activity === "Thinking" ? "is thinking"
    : activity === "Typing" ? "is typing"
    : activity.startsWith("Running ") ? `is running ${activity.slice(8)}` : activity;
  const label = connecting ? "is connecting" : archived ? "archived task" : starting ? "is waking up" : active ? activityLabel : name;
  const showActivity = connecting || archived || active || starting;
  const cardMotion = open && motionAllowed && idleMotionAllowed && !archived;
  const {
    source: cardImageSource,
    onStillLoad: onCardStillLoad,
    onError: onCardError,
  } = useProgressiveCompanionImage(
    companion?.artwork.cardStill ?? artwork?.still ?? "",
    companion?.artwork.cardIdle ?? companion?.artwork.cardStill ?? artwork?.still ?? "",
    cardMotion,
  );
  const liveActivityText = connecting
    ? "Connecting"
    : archived
      ? "Archived task"
      : starting
        ? "Starting"
        : active
          ? activity
          : null;
  const activityGroups = mounted
    ? buildTaskActivityGroups(events, summary, startedAt, Date.now())
    : [];
  const cardStyle = {
    "--companion-hue": agentNameHue(name),
  } as CSSProperties;
  return (
    <div ref={wrapRef} className={`transcript-companion${open ? " menu-open" : ""}${visibleOpen ? " is-expanded" : ""}`} data-animation={archived ? "archived" : animation}>
      <button
        ref={triggerRef}
        type="button"
        className="transcript-companion-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={mounted ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {imageSource && (
          <span className="transcript-companion-portrait-wrap">
            <CompanionPortrait source={imageSource}
              stillSource={artwork?.still ?? imageSource}
              crossFade={motionAllowed && visible && !archived}
              onError={() => setFailedSource(source ?? null)} />
            <CompanionTunedBadge music={companion?.music} className="transcript-companion-tuned-badge" />
          </span>
        )}
        <span className="transcript-companion-label" role="status" aria-live="polite" aria-atomic="true"
          aria-label={showActivity ? `${name}: ${label}` : name}>
          <span className="transcript-companion-name">{name}</span>
          {showActivity && <span className="transcript-companion-activity">
            <span className="transcript-companion-activity-text">{label}</span>
          </span>}
        </span>
      </button>
      {mounted && companion && (
        <div
          ref={dropdownRef}
          id={menuId}
          className={`transcript-companion-dropdown${visibleOpen ? " is-open" : ""}`}
          role="dialog"
          aria-label={`${name} details`}
        >
          <article
            className={`companion-card transcript-companion-card${detailsOpen && activeTab === "companion" ? " companion-card-expanded" : ""}`}
            style={cardStyle}
          >
            <button
              type="button"
              className="transcript-companion-close-btn"
              aria-label={`Close ${companion.name} card`}
              title="Close"
              onClick={() => setOpen(false)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.5 6.5 6.5 17.5M6.5 6.5l11 11" />
              </svg>
            </button>
            <div className="companion-card-identity">
              <div className="companion-card-portrait">
                <img
                  src={cardImageSource}
                  width={256}
                  height={256}
                  alt={companion.character}
                  decoding="async"
                  onLoad={onCardStillLoad}
                  onError={onCardError}
                />
              </div>
              <header className="companion-card-heading">
                <p className="companion-card-role">{companion.role}</p>
                <h2>{companion.name}</h2>
                <p className="companion-card-description">{companion.description}</p>
              </header>
            </div>
            <div className="companion-card-access">
              <p className="companion-phone-description">{companion.description}</p>
            </div>

            <CompanionMusicBanner companion={companion} />

            <CompanionAccomplishmentsRow statistics={statistics} expanded={accomplishmentsOpen}
              onToggle={() => setAccomplishmentsOpen((value) => !value)} />

            <div className="transcript-companion-tabs filter-bar" role="tablist" aria-label="Companion view">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "activity"}
                className={activeTab === "activity" ? "active" : ""}
                onClick={() => setActiveTab("activity")}
              >
                Activity
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "companion"}
                className={activeTab === "companion" ? "active" : ""}
                onClick={() => setActiveTab("companion")}
              >
                About {companion.name}
              </button>
            </div>

            {activeTab === "activity" ? (
              <div className="transcript-companion-activity-pane">
                {liveActivityText && (
                  <div className="companion-activity-live-banner" role="status">
                    <span className="companion-activity-bullet is-live" aria-hidden="true" />
                    <span className="companion-activity-live-text">{liveActivityText}</span>
                  </div>
                )}
                {activityGroups.length === 0 && !liveActivityText ? (
                  <p className="companion-activity-empty">No activity recorded on this task yet.</p>
                ) : (
                  activityGroups.map((group) => (
                    <section key={group.key} className="companion-activity-group" aria-label={group.label}>
                      <h3 className="companion-activity-day">{group.label}</h3>
                      <ul className="companion-activity-list">
                        {group.items.map((item) => (
                          <li key={item.id} className="companion-activity-item">
                            <span className="companion-activity-bullet" aria-hidden="true" />
                            <div className="companion-activity-item-body">
                              <span className="companion-activity-text" title={item.text}>
                                {item.text}
                              </span>
                              <time className="companion-activity-time">{item.timeLabel}</time>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </div>
            ) : (
              <>
                <dl className="companion-stats" aria-label="Working style ratings">
                  {RATING_STATS.map(([key, statLabel]) => (
                    <div className="companion-stat" key={key}>
                      <dt>{statLabel}</dt>
                      <dd aria-label={`${companion.stats[key]} out of 5`}>
                        <span className="companion-stat-bars" aria-hidden="true">
                          {[1, 2, 3, 4, 5].map((level) => (
                            <span key={level} className={level <= companion.stats[key] ? "filled" : ""} />
                          ))}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
                <section className="companion-skills">
                  <h3>Best at</h3>
                  <ul>
                    {companion.skills.map((skill) => (
                      <li key={skill}>{skill}</li>
                    ))}
                  </ul>
                </section>
                <section className="companion-tradeoff">
                  <h3>The trade-off</h3>
                  <p>{companion.tradeOff}</p>
                </section>
                <section className="companion-details">
                  <ExpandButton
                    expanded={detailsOpen}
                    controls={`${menuId}-details`}
                    className="companion-more-button"
                    onToggle={() => setDetailsOpen((v) => !v)}
                  >
                    More about {companion.name}
                  </ExpandButton>
                  {detailsOpen && (
                    <div id={`${menuId}-details`}>
                      <dl className="companion-configuration">
                        <div>
                          <dt>Preferred model</dt>
                          <dd>{displayModelLabel(companion.model.preferredId)}</dd>
                        </div>
                        <div>
                          <dt>Effort</dt>
                          <dd>{companion.effort === "xhigh" ? "Extra high" : companion.effort}</dd>
                        </div>
                      </dl>
                      <CompanionMusicSection companion={companion} />
                      <details
                        className="companion-soul"
                        open={soulOpen}
                        onToggle={(event) => setSoulOpen(event.currentTarget.open)}
                      >
                        <summary>SOUL.md</summary>
                        <pre>{companion.artwork.soul}</pre>
                      </details>
                    </div>
                  )}
                </section>
              </>
            )}
          </article>
        </div>
      )}
    </div>
  );
});

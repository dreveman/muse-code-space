import { useEffect, useState } from "react";
import { displayAgentName } from "./agentColor";
import { agentVisualStatus } from "./agentStatus";
import { api, type ApiResponse } from "./api";
import { companions } from "./Companions";
import { PreviewTabIcon } from "./PreviewPanel";
import { sessionTaskTitle } from "./sessionList";
import { SmartLogIcon } from "./SmartLogPanel";
import { WelcomeSpotifyCard } from "./SpotifyMusic";

type Session = ApiResponse<typeof api, "listSessions">["sessions"][number];

export function timeOfDayGreeting(userName?: string | null, hour = new Date().getHours()): string {
  const base =
    hour < 5
      ? "GOOD EVENING"
      : hour < 12
        ? "GOOD MORNING"
        : hour < 17
          ? "GOOD AFTERNOON"
          : "GOOD EVENING";
  const trimmed = userName?.trim();
  return trimmed ? `${base}, ${trimmed}` : base;
}

function WelcomeStatusDot({ session }: { session: Session }) {
  const visual = agentVisualStatus(session);
  if (visual === "working") {
    return <span className="working-spinner welcome-session-spinner" aria-label="Working" />;
  }
  if (visual === "complete") {
    return (
      <span className="welcome-session-check" aria-label="Completed">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3.5 8.5 3 3 6-6.5" />
        </svg>
      </span>
    );
  }
  return <span className={`welcome-session-dot status-${visual}`} aria-hidden="true" />;
}

function TerminalIllustration() {
  return (
    <div className="welcome-illus-window" aria-hidden="true">
      <div className="welcome-illus-tabbar">
        <span className="welcome-illus-tab">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
            <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
          </svg>
          Terminal
        </span>
        <span className="welcome-illus-close">×</span>
      </div>
      <div className="welcome-illus-subbar">
        <span className="welcome-illus-live">
          <i /> Connected
        </span>
      </div>
      <div className="welcome-illus-body">
        <div className="welcome-illus-dim">~/workspace/app</div>
        <div className="welcome-illus-cmd">&gt; bun test</div>
        <div className="welcome-illus-ok">✓ 24 tests passed</div>
        <div className="welcome-illus-prompt">
          &gt; <span className="welcome-illus-cursor" />
        </div>
      </div>
    </div>
  );
}

function PreviewIllustration() {
  return (
    <div className="welcome-illus-window" aria-hidden="true">
      <div className="welcome-illus-tabbar">
        <span className="welcome-illus-tab">
          <PreviewTabIcon />
          Preview
        </span>
        <span className="welcome-illus-close">×</span>
      </div>
      <div className="welcome-illus-subbar">
        <span className="welcome-illus-url">127.0.0.1:5173</span>
        <span className="welcome-illus-live">
          <i />
        </span>
      </div>
      <div className="welcome-illus-body welcome-illus-preview-body">
        <div className="welcome-illus-badge">● Live</div>
        <div className="welcome-illus-preview-title">My Website</div>
        <div className="welcome-illus-dim">Updates automatically as you make changes.</div>
      </div>
    </div>
  );
}

function SmartLogIllustration() {
  return (
    <div className="welcome-illus-window" aria-hidden="true">
      <div className="welcome-illus-tabbar">
        <span className="welcome-illus-tab">
          <SmartLogIcon />
          Smart Log
        </span>
        <span className="welcome-illus-close">×</span>
      </div>
      <div className="welcome-illus-body welcome-illus-sl-body">
        <div className="welcome-illus-sl-pill">You are here</div>
        <div className="welcome-illus-sl-row">
          <span className="welcome-illus-sl-dot head" />
          <span className="welcome-illus-sl-text">Add live preview tab</span>
          <span className="welcome-illus-sl-tag">main</span>
        </div>
        <div className="welcome-illus-sl-row">
          <span className="welcome-illus-sl-dot" />
          <span className="welcome-illus-sl-text welcome-illus-dim">Initial repository setup</span>
        </div>
      </div>
    </div>
  );
}

function GitHubIllustration() {
  return (
    <div className="welcome-illus-window" aria-hidden="true">
      <div className="welcome-illus-tabbar">
        <span className="welcome-illus-tab">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          acme/web-app
        </span>
        <span className="welcome-illus-live">
          <i /> Monitoring
        </span>
      </div>
      <div className="welcome-illus-body">
        <div className="welcome-illus-gh-pr">
          <span className="welcome-illus-gh-badge">PR #42</span>
          <span className="welcome-illus-sl-text">Add live preview tab</span>
        </div>
        <div className="welcome-illus-ok">✓ 4 CI checks passed</div>
        <div className="welcome-illus-dim">Watching for review comments</div>
      </div>
    </div>
  );
}

function MentionIllustration({ assistantName = "Jolly" }: { assistantName?: string } = {}) {
  return (
    <div className="welcome-illus-window" aria-hidden="true">
      <div className="welcome-illus-tabbar">
        <span className="welcome-illus-tab">@ Mention</span>
      </div>
      <div className="welcome-illus-body">
        <div className="welcome-illus-mention-row active">
          <span className="welcome-illus-mention-chip">@Remy</span>
          <span className="welcome-illus-dim">Companion</span>
        </div>
        <div className="welcome-illus-mention-row">
          <span className="welcome-illus-mention-chip muse">@{assistantName}</span>
          <span className="welcome-illus-dim">Your Muse assistant</span>
        </div>
        <div className="welcome-illus-cmd">
          Ask <span className="welcome-illus-mention-inline">@Remy</span> to check the tests
        </div>
      </div>
    </div>
  );
}

function SplitViewIllustration() {
  return (
    <div className="welcome-illus-window" aria-hidden="true">
      <div className="welcome-illus-tabbar">
        <span className="welcome-illus-tab">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <path d="M8 2.5v11" />
          </svg>
          Split view
        </span>
        <span className="welcome-illus-live">
          <i /> Linked
        </span>
      </div>
      <div className="welcome-illus-split-body">
        <div className="welcome-illus-split-pane">
          <div className="welcome-illus-split-head">
            <span className="welcome-illus-sl-dot head" />
            <span>Poppy</span>
          </div>
          <div className="welcome-illus-dim">Build UI layout</div>
          <div className="welcome-illus-ok">✓ Ready</div>
        </div>
        <div className="welcome-illus-split-pane">
          <div className="welcome-illus-split-head">
            <span className="welcome-illus-sl-dot head" />
            <span>Remy</span>
          </div>
          <div className="welcome-illus-dim">Run test suite</div>
          <div className="welcome-illus-ok">● Working</div>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    id: "mention",
    title: "Message companions with @.",
    description: "Type @ in any conversation to message another companion or your Muse assistant.",
    Illustration: MentionIllustration,
  },
  {
    id: "split",
    title: "Link tasks in split view.",
    description: "Use Split view in the menu to link two active conversations side by side.",
    Illustration: SplitViewIllustration,
  },
  {
    id: "github",
    title: "Work on your GitHub repos.",
    description: "Clone repos, open pull requests, and watch CI checks and reviews.",
    Illustration: GitHubIllustration,
  },
  {
    id: "terminal",
    title: "A terminal in your workspace.",
    description: "Run a command, inspect logs, or check a test without leaving the conversation.",
    Illustration: TerminalIllustration,
  },
  {
    id: "preview",
    title: "Preview your website live.",
    description: "See the webpage you’re building and watch it update as your companion makes changes.",
    Illustration: PreviewIllustration,
  },
  {
    id: "smartlog",
    title: "Your git stack, in view.",
    description: "Inspect uncommitted changes, commit history, and pull request checks in Smart Log.",
    Illustration: SmartLogIllustration,
  },
] as const;

export function HomeWelcomeCard({
  sessions,
  userName = null,
  assistantName = null,
  formatTime,
  onSelectSession,
  onPickCompanion,
}: {
  sessions: readonly Session[];
  userName?: string | null;
  assistantName?: string | null;
  formatTime: (iso: string) => string;
  onSelectSession: (id: string) => void;
  onPickCompanion: () => void;
}) {
  const [featureIndex, setFeatureIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [animCompanionIdx, setAnimCompanionIdx] = useState(1);

  const recentSessions = sessions.filter((session) => !session.archived).slice(0, 5);
  const feature = FEATURES[featureIndex] ?? FEATURES[0];
  const Illustration = feature.Illustration;
  const resolvedAssistantName = assistantName?.trim() || "Jolly";
  const teamMembers = ["nova", "poppy", "tilly", "remy", "sage"]
    .map((id) => companions.find((c) => c.id === id))
    .filter((c): c is (typeof companions)[number] => Boolean(c));

  // Animate only one companion at a time, stepping in a non-adjacent order so
  // they never blink in unison.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const order = [1, 3, 0, 4, 2];
    let step = 0;
    const timer = window.setInterval(() => {
      step = (step + 1) % order.length;
      setAnimCompanionIdx(order[step]!);
    }, 4800);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="welcome-home-stage">
      <section className="welcome-home-card" aria-label="Welcome to Code Space">
        <span className="companion-sr-only">Select a task to see its conversation.</span>
        <div className="welcome-home-main">
          <span className="welcome-home-eyebrow">{timeOfDayGreeting(userName)}</span>
          <h2 className="welcome-home-headline">
            {recentSessions.length > 0 ? "Pick up where you left off." : "Start a new conversation."}
          </h2>

          {recentSessions.length > 0 && (
            <div className="welcome-session-list" role="list" aria-label="Recent conversations">
              {recentSessions.map((session) => {
                const companionName = displayAgentName(session.title);
                const taskSummary =
                  session.session_summary?.trim() ||
                  session.summary?.trim() ||
                  sessionTaskTitle(session) ||
                  "Conversation";
                const unread = agentVisualStatus(session) === "unread";
                const relTime = formatTime(session.updated_at);
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={`welcome-session-row${unread ? " is-unread" : ""}`}
                    onClick={() => onSelectSession(session.id)}
                  >
                    <WelcomeStatusDot session={session} />
                    <span className="welcome-session-text">
                      <span className="welcome-session-companion">{companionName}</span>
                      <span className="welcome-session-sep" aria-hidden="true">›</span>
                      <span className="welcome-session-summary">{taskSummary}</span>
                    </span>
                    <span className="welcome-session-meta">{relTime}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="welcome-callout">
            <div className="welcome-callout-body">
              <h3>Work with specialized code companions</h3>
              <p>
                Pick a companion tuned for your task.
              </p>
              <div className="welcome-team-photo style-medallions" aria-label="The coding companions">
                {teamMembers.map((companion, idx) => {
                  const animateThis = idx === animCompanionIdx;
                  return (
                    <div
                      key={companion.id}
                      className={`welcome-team-member member-${companion.id}`}
                      title={`${companion.name} — ${companion.role}`}
                      onPointerEnter={() => setAnimCompanionIdx(idx)}
                    >
                      <img
                        className="welcome-team-img-still"
                        src={companion.artwork.still}
                        alt={companion.name}
                      />
                      {animateThis && (
                        <img
                          className="welcome-team-img-anim"
                          src={companion.artwork.portraitIdle}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="welcome-callout-actions">
                <button type="button" className="welcome-btn-primary" onClick={onPickCompanion}>
                  Pick a companion
                </button>
              </div>
            </div>
          </div>

          <WelcomeSpotifyCard />
        </div>

        <aside
          className="welcome-home-feature"
          aria-label="Explore Code Space features"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <div className="welcome-feature-art">
            {feature.id === "mention" ? (
              <MentionIllustration assistantName={resolvedAssistantName} />
            ) : (
              <Illustration />
            )}
          </div>
          <div className="welcome-feature-copy">
            <h3>{feature.title}</h3>
            <p>{feature.description}</p>
          </div>
          <div className="welcome-feature-dots" role="tablist" aria-label="Feature slides">
            {FEATURES.map((item, idx) => {
              const active = idx === featureIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={item.title}
                  className={`welcome-feature-dot${active ? " active" : ""}${hovered ? " paused" : ""}`}
                  onClick={() => setFeatureIndex(idx)}
                >
                  <span className="welcome-feature-dot-track">
                    {active && (
                      <span
                        key={featureIndex}
                        className="welcome-feature-dot-fill"
                        onAnimationEnd={() => {
                          setFeatureIndex((current) => (current + 1) % FEATURES.length);
                        }}
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      </section>
    </div>
  );
}

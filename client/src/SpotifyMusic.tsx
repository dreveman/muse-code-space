// Spotify companion music UI: the setup dialog and the companion card's
// "Music taste" section.
//
// Playback state is global to the user's Spotify account (never per
// session, never stored client-side). Nothing here starts or changes
// playback except an explicit Tune in press.

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { copyTextToClipboard } from "./clipboard";
import { detectIosDevice } from "./colorMode";
import { companionForName } from "./companionRoster";
import type { CompanionMusic } from "../../server/src/companionMusic";
import {
  extractSpotifyAuthCode,
  extractSpotifyAuthState,
  isCompanionBusyInSessions,
  shouldOpenSpotifyAuthInNewTab,
  spotifyRedirectUri,
  targetCompanionVolume,
} from "./spotifyControlLogic";

type MusicCompanion = { id: string; name: string; music: CompanionMusic | null };

let savedSetupClientId = "";
let savedStartedState: string | null = null;
let stoppedContextUri: string | null = null;
let tuneInSeq = 0;
function setStoppedContextUri(uri: string | null) {
  stoppedContextUri = uri;
  if (uri === null) tuneInSeq += 1;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("muse-code-space:spotify-stopped", { detail: uri }));
  }
}

function useSpotifyStatus() {
  return useQuery({
    queryKey: ["spotify-status"],
    queryFn: () => api.getSpotifyStatus({}),
    staleTime: 5000,
    retry: false,
  });
}

export function useSpotifyPlayback() {
  const statusQuery = useSpotifyStatus();
  const connected = statusQuery.data?.connected === true;
  return useQuery({
    queryKey: ["spotify-playback"],
    queryFn: () => api.getSpotifyPlayback({}),
    enabled: connected,
    staleTime: 3000,
    refetchInterval: 10_000,
    retry: false,
  });
}

export function useCompanionTunedState(music: CompanionMusic | null | undefined) {
  const statusQuery = useSpotifyStatus();
  const playbackQuery = useSpotifyPlayback();
  const [, setTick] = useState(0);
  useEffect(() => {
    const onStopped = () => setTick((v) => v + 1);
    window.addEventListener("muse-code-space:spotify-stopped", onStopped);
    return () => window.removeEventListener("muse-code-space:spotify-stopped", onStopped);
  }, []);
  const connected = statusQuery.data?.connected === true;
  const playback = playbackQuery.data?.playback ?? null;
  const playlistUri = music?.playlist?.uri ?? null;
  const matchesPlaylist = Boolean(
    connected &&
    playlistUri &&
    playback?.context_uri &&
    playback.context_uri === playlistUri &&
    stoppedContextUri !== playlistUri,
  );
  return {
    connected,
    tunedIn: matchesPlaylist,
    isPlaying: matchesPlaylist && playback?.is_playing === true,
    track: matchesPlaylist ? (playback?.track ?? null) : null,
    deviceId: playback?.device?.id ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Setup dropdown (modeled on the GitHub setup dropdown in RepoPicker.tsx):
// create a Spotify Developer app, register the exact redirect URI shown,
// enter the Client ID, approve in Spotify, land back in Code Space. If
// Spotify returns the user somewhere the callback didn't run, pasting the
// redirect URL into the same dropdown completes the connection instead.
// ---------------------------------------------------------------------------

export function SpotifySetupMenu({
  id,
  triggerRef,
  menuRef,
  onClose,
}: {
  id?: string;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useSpotifyStatus();
  const uiStateQuery = useQuery({
    queryKey: ["ui-state"],
    queryFn: () => api.getUiState({}),
    staleTime: Infinity,
    retry: false,
  });
  const connected = statusQuery.data?.connected === true;
  const [clientId, setClientIdState] = useState(() => savedSetupClientId || uiStateQuery.data?.spotify_client_id || "");
  const [startedState, setStartedStateLocal] = useState<string | null>(() => savedStartedState ?? uiStateQuery.data?.spotify_started_state ?? null);
  useEffect(() => {
    if (!clientId && uiStateQuery.data?.spotify_client_id) {
      savedSetupClientId = uiStateQuery.data.spotify_client_id;
      setClientIdState(uiStateQuery.data.spotify_client_id);
    }
    if (!startedState && uiStateQuery.data?.spotify_started_state) {
      savedStartedState = uiStateQuery.data.spotify_started_state;
      setStartedStateLocal(uiStateQuery.data.spotify_started_state);
    }
  }, [uiStateQuery.data, clientId, startedState]);
  const setClientId = (next: string) => {
    savedSetupClientId = next;
    setClientIdState(next);
  };
  const setStartedState = (next: string | null) => {
    savedStartedState = next;
    setStartedStateLocal(next);
  };
  const [pasteValue, setPasteValue] = useState("");
  const [copiedUri, setCopiedUri] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const redirectUri = spotifyRedirectUri(window.location);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 12;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const width = Math.min(360, Math.max(220, viewportW - margin * 2));
      const maxLeft = Math.max(margin, viewportW - margin - width);
      const left = Math.min(Math.max(rect.right - width, margin), maxLeft);
      const spaceAbove = rect.top - margin - 6;
      const spaceBelow = viewportH - rect.bottom - margin - 6;
      const openAbove = spaceAbove >= 240 || spaceAbove >= spaceBelow;
      if (openAbove) {
        setMenuStyle({
          position: "fixed",
          left: `${left}px`,
          bottom: `${Math.max(margin, viewportH - rect.top + 6)}px`,
          top: "auto",
          right: "auto",
          width: `${width}px`,
          maxHeight: `${Math.max(160, spaceAbove)}px`,
          zIndex: 10000,
        });
      } else {
        setMenuStyle({
          position: "fixed",
          left: `${left}px`,
          top: `${Math.max(margin, rect.bottom + 6)}px`,
          bottom: "auto",
          right: "auto",
          width: `${width}px`,
          maxHeight: `${Math.max(160, spaceBelow)}px`,
          zIndex: 10000,
        });
      }
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [triggerRef, startedState, error]);

  const copyRedirectUri = async () => {
    if (await copyTextToClipboard(redirectUri)) {
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 1500);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      let res: Awaited<ReturnType<typeof api.startSpotifySetup>>;
      try {
        res = await api.startSpotifySetup({ client_id: clientId, redirect_uri: redirectUri });
      } catch {
        await new Promise((r) => setTimeout(r, 700));
        res = await api.startSpotifySetup({ client_id: clientId, redirect_uri: redirectUri });
      }
      if (!res.ok || !res.auth_url) {
        setError(res.error ?? "Could not start the Spotify connection.");
        return;
      }
      setStartedState(res.state);
      await queryClient.invalidateQueries({ queryKey: ["ui-state"] });
      if (!res.auth_url.startsWith("#")) {
        if (shouldOpenSpotifyAuthInNewTab(window, detectIosDevice())) {
          window.open(res.auth_url, "_blank");
        } else {
          window.location.assign(res.auth_url);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the Spotify connection. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const completeFromPaste = async () => {
    const code = extractSpotifyAuthCode(pasteValue);
    if (!code) {
      setError("Paste the full Completion URL from Spotify (it contains a code), or the code itself.");
      return;
    }
    const stateToUse = extractSpotifyAuthState(pasteValue) ?? startedState;
    if (!stateToUse) {
      setError("Click Connect first, approve in Spotify, then paste the Completion URL here.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let res: Awaited<ReturnType<typeof api.completeSpotifySetup>>;
      try {
        res = await api.completeSpotifySetup({ code, state: stateToUse });
      } catch {
        // After switching back from Safari on iOS, the Space auth session may
        // still be refreshing; wait briefly and retry once automatically.
        await new Promise((r) => setTimeout(r, 700));
        res = await api.completeSpotifySetup({ code, state: stateToUse });
      }
      if (!res.ok) {
        setError(res.error ?? "Spotify did not accept that code.");
        return;
      }
      setStartedState(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["spotify-status"] }),
        queryClient.invalidateQueries({ queryKey: ["ui-state"] }),
      ]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session was still reconnecting — tap Complete with URL again.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.disconnectSpotify({});
      if (!res.ok) {
        setError(res.error ?? "Could not disconnect Spotify.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["spotify-status"] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect Spotify.");
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div
      ref={menuRef}
      id={id}
      className="repo-menu repo-setup-menu spotify-setup-menu"
      style={menuStyle}
      role="dialog"
      aria-label="Spotify setup"
    >
      <div className="repo-setup-header">
        <strong>Spotify setup</strong>
      </div>
      {connected ? (
        <div className="spotify-setup-connected">
          <p className="repo-manage-description">
            Connected{statusQuery.data?.account_name ? <> as <strong>{statusQuery.data.account_name}</strong></> : ""}. Companion playlists play on your active Spotify device.
          </p>
          {error && <p className="repo-setup-error" role="alert">{error}</p>}
          <div className="spotify-setup-actions">
            <button type="button" className="repo-setup-action" onClick={() => void disconnect()} disabled={busy}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      ) : (
        <ol className="repo-setup-steps">
          <li className="repo-setup-step">
            <span className="repo-setup-status" aria-hidden="true">1</span>
            <div className="repo-setup-identity">
              <strong>Spotify Developer app</strong>
              <small>
                Create an app at{" "}
                <a
                  href="https://developer.spotify.com/dashboard"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="spotify-setup-link"
                >
                  developer.spotify.com/dashboard
                </a>{" "}
                and add this Redirect URI
              </small>
            </div>
          </li>
          <li className="repo-setup-form">
            <div className="repo-manage-field">
              <span className="repo-manage-field-label">Redirect URI</span>
              <code className="repo-manage-field-value spotify-redirect-uri" title={redirectUri}>{redirectUri}</code>
              <button
                type="button"
                className="repo-manage-copy"
                title={copiedUri ? "Copied" : "Copy Redirect URI"}
                aria-label={copiedUri ? "Copied Redirect URI" : "Copy Redirect URI"}
                onClick={() => void copyRedirectUri()}
              >
                {copiedUri ? "✓" : (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                    <path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" />
                  </svg>
                )}
              </button>
            </div>
          </li>
          <li className="repo-setup-step">
            <span className="repo-setup-status" aria-hidden="true">2</span>
            <div className="repo-setup-identity">
              <strong>Client ID</strong>
              <small>Paste your app’s Client ID and authorize in Spotify</small>
            </div>
          </li>
          <li className="repo-setup-form">
            <label className="repo-setup-field">
              <span>Client ID</span>
              <input
                type="text"
                aria-label="Spotify Client ID"
                value={clientId}
                placeholder="Client ID from Spotify app"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setClientId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && clientId.trim()) {
                    event.preventDefault();
                    void connect();
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="repo-setup-action repo-setup-submit"
              disabled={busy || !clientId.trim()}
              onClick={() => void connect()}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
            {startedState && (
              <>
                <label className="repo-setup-field">
                  <span>Completion URL</span>
                  <input
                    type="text"
                    aria-label="Spotify completion URL or code"
                    value={pasteValue}
                    placeholder="https://…/?code=…"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    onChange={(event) => setPasteValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && pasteValue.trim()) {
                        event.preventDefault();
                        void completeFromPaste();
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="repo-setup-action repo-setup-submit"
                  disabled={busy || !pasteValue.trim()}
                  onClick={() => void completeFromPaste()}
                >
                  Complete with URL
                </button>
              </>
            )}
          </li>
          {error && <li className="repo-setup-error" role="alert">{error}</li>}
        </ol>
      )}
    </div>
  );
  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}

// ---------------------------------------------------------------------------
// Companion card "Music taste" row: a single line in the card's
// configuration list (after Effort). Disconnected shows a Connect Spotify
// button on the right; connected shows just the Spotify icon (which is
// the Tune in button when the companion has a playlist).
// ---------------------------------------------------------------------------

export function SpotifyIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 496 512" aria-hidden="true" className="spotify-icon">
      <path fill="#1ed760" d="M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8Z" />
      <path d="M406.6 231.1c-5.2 0-8.4-1.3-12.9-3.9-71.2-42.5-198.5-52.7-280.9-29.7-3.6 1-8.1 2.6-12.9 2.6-13.2 0-23.3-10.3-23.3-23.6 0-13.6 8.4-21.3 17.4-23.9 35.2-10.3 74.6-15.2 117.5-15.2 73 0 149.5 15.2 205.4 47.8 7.8 4.5 12.9 10.7 12.9 22.6 0 13.6-11 23.3-23.2 23.3zm-31 76.2c-5.2 0-8.7-2.3-12.3-4.2-62.5-37-155.7-51.9-238.6-29.4-4.8 1.3-7.4 2.6-11.9 2.6-10.7 0-19.4-8.7-19.4-19.4s5.2-17.8 15.5-20.7c27.8-7.8 56.2-13.6 97.8-13.6 64.9 0 127.6 16.1 177 45.5 8.1 4.8 11.3 11 11.3 19.7-.1 10.8-8.5 19.5-19.4 19.5zm-26.9 65.6c-4.2 0-6.8-1.3-10.7-3.6-62.4-37.6-135-39.2-206.7-24.5-3.9 1-9 2.6-11.9 2.6-9.7 0-15.8-7.7-15.8-15.8 0-10.3 6.1-15.2 13.6-16.8 81.9-18.1 165.6-16.5 237 26.2 6.1 3.9 9.7 7.4 9.7 16.5s-7.1 15.4-15.2 15.4z" />
    </svg>
  );
}

export function CompanionMusicSection({ companion }: { companion: MusicCompanion }) {
  const queryClient = useQueryClient();
  const statusQuery = useSpotifyStatus();
  const uiStateQuery = useQuery({
    queryKey: ["ui-state"],
    queryFn: () => api.getUiState({}),
    staleTime: Infinity,
    retry: false,
  });
  const { tunedIn, isPlaying } = useCompanionTunedState(companion.music);
  const [menuOpen, setMenuOpenState] = useState(false);
  const setMenuOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setMenuOpenState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      void api.setUiState({ spotify_setup_open: resolved })
        .then(() => queryClient.invalidateQueries({ queryKey: ["ui-state"] }))
        .catch(() => undefined);
      return resolved;
    });
  };
  const restoredOpenRef = useRef(false);
  useEffect(() => {
    if (restoredOpenRef.current || !uiStateQuery.data) return;
    restoredOpenRef.current = true;
    if (!statusQuery.data?.connected && (uiStateQuery.data.spotify_setup_open || uiStateQuery.data.spotify_started_state)) {
      setMenuOpenState(true);
    }
  }, [uiStateQuery.data, statusQuery.data?.connected]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const music = companion.music;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rowRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  if (!music) return null;

  const connected = statusQuery.data?.connected === true;
  const tuneIn = async () => {
    setBusy(true);
    setError(null);
    try {
      setStoppedContextUri(null);
      const res = await api.playCompanionMusic({ companion_id: companion.id });
      if (!res.ok) {
        setError(res.error ?? "Spotify could not start that playlist.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["spotify-playback"] });
    } finally {
      setBusy(false);
    }
  };

  const chips = [music.genre, ...music.tags];
  return (
    <section ref={rowRef} className="companion-music" aria-label="Music taste">
      <div className="companion-music-header">
        <h3>Music taste</h3>
        {connected ? (
          music.playlist ? (
            <button type="button" className={`companion-music-connect spotify-tune-in-button${tunedIn ? " is-tuned-in" : ""}`} onClick={() => void tuneIn()} disabled={busy}
              aria-label={`Tune in to ${music.playlist.name} on Spotify`} title={`Tune in: ${music.playlist.name}`}>
              <SpotifyIcon /> {busy ? "Tuning in…" : tunedIn && isPlaying ? "Tuned in" : "Tune in"}
            </button>
          ) : (
            <span className="companion-music-icon" title="Spotify connected" aria-label="Spotify connected"><SpotifyIcon /></span>
          )
        ) : (
          <button
            ref={triggerRef}
            type="button"
            className="companion-music-connect"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <SpotifyIcon /> Connect Spotify
          </button>
        )}
      </div>
      {connected && chips.length > 0 && (
        <ul>
          {chips.map((chip) => (
            <li key={chip}>{chip}</li>
          ))}
        </ul>
      )}
      {error && <span className="companion-music-error" role="alert">{error}</span>}
      {menuOpen && (
        <SpotifySetupMenu
          id={menuId}
          triggerRef={triggerRef}
          menuRef={menuRef}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </section>
  );
}

export function CompanionTunedBadge({
  companionName,
  music,
  className = "",
}: {
  companionName?: string;
  music?: CompanionMusic | null;
  className?: string;
}) {
  const resolvedMusic = music !== undefined ? music : (companionName ? companionForName(companionName)?.music ?? null : null);
  const { tunedIn, isPlaying, track } = useCompanionTunedState(resolvedMusic);
  if (!tunedIn) return null;
  const label = track
    ? `Tuned in: ${track.name} — ${track.artists.join(", ")}${isPlaying ? "" : " (paused)"}`
    : `Tuned in to ${resolvedMusic?.playlist?.name ?? "Spotify"}`;
  return (
    <span className={`companion-tuned-badge${isPlaying ? " is-playing" : ""}${className ? ` ${className}` : ""}`} title={label} aria-label={label}>
      <SpotifyIcon />
    </span>
  );
}

export function CompanionMusicBanner({ companion }: { companion: MusicCompanion }) {
  const queryClient = useQueryClient();
  const { tunedIn, isPlaying, track, deviceId } = useCompanionTunedState(companion.music);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!tunedIn || !companion.music) return null;

  const run = async (work: () => Promise<{ ok: boolean; error: string | null }>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await work();
      if (!res.ok) {
        setError(res.error ?? "Spotify reported an error.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["spotify-playback"] });
    } finally {
      setBusy(false);
    }
  };

  const stopPlayback = async () => {
    const uri = companion.music?.playlist?.uri ?? null;
    setStoppedContextUri(uri);
    if (isPlaying) {
      await run(() => api.pauseSpotifyPlayback({}));
    } else {
      await queryClient.invalidateQueries({ queryKey: ["spotify-playback"] });
    }
  };

  const trackTitle = track?.name ?? companion.music.playlist?.name ?? companion.music.genre;
  const trackArtist = track?.artists?.length ? track.artists.join(", ") : companion.music.genre;

  return (
    <div className="companion-music-banner" role="region" aria-label={`${companion.name} music playback`}>
      <SpotifyIcon />
      <div className="companion-music-banner-track" title={`${trackTitle} — ${trackArtist}`}>
        <span className="companion-music-banner-title">{trackTitle}</span>
        {trackArtist && <span className="companion-music-banner-artist">· {trackArtist}</span>}
      </div>
      <div className="companion-music-banner-controls">
        <button
          type="button"
          aria-label="Previous track"
          title="Previous track"
          disabled={busy}
          onClick={() => void run(() => api.skipSpotifyTrack({ direction: "previous" }))}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6.5 5.5h2.2v13H6.5zm3.2 6.5 8.8-6.5v13z" />
          </svg>
        </button>
        {isPlaying ? (
          <button
            type="button"
            aria-label="Pause"
            title="Pause"
            disabled={busy}
            onClick={() => void run(() => api.pauseSpotifyPlayback({}))}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 5.5h3.5v13H7zm6.5 0H17v13h-3.5z" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            aria-label="Play"
            title="Play"
            disabled={busy}
            onClick={() => {
              setStoppedContextUri(null);
              void run(() => api.resumeSpotifyPlayback({ device_id: deviceId }));
            }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.5v13l10.5-6.5z" />
            </svg>
          </button>
        )}
        <button
          type="button"
          aria-label="Stop"
          title="Stop"
          disabled={busy}
          onClick={() => void stopPlayback()}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Next track"
          title="Next track"
          disabled={busy}
          onClick={() => void run(() => api.skipSpotifyTrack({ direction: "next" }))}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M15.3 5.5h2.2v13h-2.2zM6.5 18.5v-13l8.8 6.5z" />
          </svg>
        </button>
      </div>
      {error && <span className="companion-music-banner-error" role="alert">{error}</span>}
    </div>
  );
}

/**
 * Automatically adjusts Spotify playback volume based on whether the
 * currently tuned-in companion is actively working (`SPOTIFY_BUSY_VOLUME`)
 * or idle/finished (`SPOTIFY_IDLE_VOLUME`).
 */
export function useSpotifyCompanionVolumeSync({
  sessions,
  companions,
  startingCompanionName = null,
}: {
  sessions: ReadonlyArray<{ title: string; status: string; archived?: boolean; needs_you?: boolean }>;
  companions: ReadonlyArray<MusicCompanion>;
  startingCompanionName?: string | null;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useSpotifyStatus();
  const playbackQuery = useSpotifyPlayback();
  const [, setTick] = useState(0);
  useEffect(() => {
    const onStopped = () => setTick((v) => v + 1);
    window.addEventListener("muse-code-space:spotify-stopped", onStopped);
    return () => window.removeEventListener("muse-code-space:spotify-stopped", onStopped);
  }, []);

  const connected = statusQuery.data?.connected === true;
  const playback = playbackQuery.data?.playback ?? null;
  const contextUri = playback?.context_uri ?? null;
  const isPlaying = Boolean(
    connected &&
    playback?.is_playing &&
    contextUri &&
    stoppedContextUri !== contextUri,
  );
  const tunedCompanion = isPlaying && contextUri
    ? companions.find((c) => c.music?.playlist?.uri === contextUri) ?? null
    : null;
  const busy = tunedCompanion
    ? isCompanionBusyInSessions(tunedCompanion.name, sessions, startingCompanionName)
    : null;

  const lastAppliedRef = useRef<{ uri: string; busy: boolean; seq: number } | null>(null);

  useEffect(() => {
    if (!tunedCompanion || !contextUri || busy === null) {
      lastAppliedRef.current = null;
      return;
    }
    const prev = lastAppliedRef.current;
    if (prev && prev.uri === contextUri && prev.busy === busy && prev.seq === tuneInSeq) {
      return;
    }
    lastAppliedRef.current = { uri: contextUri, busy, seq: tuneInSeq };
    const volumePercent = targetCompanionVolume(busy);
    void api.setSpotifyVolume({ volume_percent: volumePercent })
      .then((res) => {
        if (res.ok) {
          void queryClient.invalidateQueries({ queryKey: ["spotify-playback"] });
        }
      })
      .catch(() => { /* best-effort volume adjustment */ });
  }, [tunedCompanion, contextUri, busy, queryClient]);
}

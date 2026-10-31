// Pure helpers for the Spotify companion-music UI (no React, no storage).
// Playback state is global to the Spotify account and is never stored
// client-side; these helpers only shape what the components render.

export const DEFAULT_SPOTIFY_REDIRECT_URI = "http://127.0.0.1:4173/";

/**
 * The exact redirect URI to register in the Spotify Developer app.
 * When the Space is loaded inside a non-HTTP custom WebView scheme (such as
 * `hatch-space://...` in the iOS app), falls back to the standard loopback
 * HTTP redirect URI with an explicit port (`http://127.0.0.1:4173/`) as
 * required by Spotify's loopback redirect URI validator.
 */
export function spotifyRedirectUri(location: { origin: string; pathname: string; href?: string }): string {
  if (typeof location.origin === "string" && /^https?:\/\//i.test(location.origin)) {
    return `${location.origin}${location.pathname || "/"}`;
  }
  return DEFAULT_SPOTIFY_REDIRECT_URI;
}

/**
 * Extract the authorization code from a pasted Spotify redirect URL (the
 * fallback when Spotify sends the user back somewhere Code Space didn't
 * load), or accept a bare code.
 */
export function extractSpotifyAuthCode(input: string): string | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    return code && code.length > 0 ? code : null;
  } catch { /* not a URL: fall through to the bare-code check */ }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Extract the OAuth `state` parameter when the user pastes a full redirect URL.
 */
export function extractSpotifyAuthState(input: string): string | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const state = url.searchParams.get("state");
    return state && state.length > 0 ? state : null;
  } catch {
    return null;
  }
}

/**
 * When running inside an iframe (hosted Space) or on iOS, open Spotify
 * authorization in a new tab/Safari rather than navigating the Space frame
 * away (which would lose the host's viewer_assertion and dropdown state).
 */
export function shouldOpenSpotifyAuthInNewTab(
  win: { parent?: unknown } | null | undefined,
  isIos: boolean,
): boolean {
  if (isIos) return true;
  if (win && win.parent !== undefined && win.parent !== win) return true;
  return false;
}

export type SpotifyControlState = "connect" | "no-device" | "ready";

/**
 * The session music control's top-level state: offer Connect when there is
 * no Spotify connection, ask for a device when connected but none is
 * available, otherwise show the playback controls.
 */
export function deriveSpotifyControlState(input: {
  connected: boolean;
  devices: readonly { id: string }[];
}): SpotifyControlState {
  if (!input.connected) return "connect";
  if (input.devices.length === 0) return "no-device";
  return "ready";
}

export const SPOTIFY_IDLE_VOLUME = 50;
export const SPOTIFY_BUSY_VOLUME = 75;

/**
 * Target Spotify volume for a tuned-in companion: quiet ambient volume when
 * the companion is idle or finished, and normal listening volume while busy.
 */
export function targetCompanionVolume(busy: boolean): number {
  return busy ? SPOTIFY_BUSY_VOLUME : SPOTIFY_IDLE_VOLUME;
}

export function isCompanionBusyInSessions(
  companionName: string,
  sessions: ReadonlyArray<{
    title: string;
    status: string;
    archived?: boolean;
    needs_you?: boolean;
  }>,
  startingCompanionName?: string | null,
): boolean {
  const key = companionName.trim().toLowerCase();
  if (!key) return false;
  if (startingCompanionName && startingCompanionName.trim().toLowerCase() === key) {
    return true;
  }
  return sessions.some(
    (s) =>
      !s.archived &&
      s.title.trim().toLowerCase() === key &&
      !s.needs_you &&
      (s.status === "queued" || s.status === "running"),
  );
}

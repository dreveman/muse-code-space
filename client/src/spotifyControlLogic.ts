// Pure helpers for the Spotify companion-music UI (no React, no storage).
// Playback state is global to the Spotify account and is never stored
// client-side; these helpers only shape what the components render.

// Security note on the fallback below: the authorization `code` lands in
// this URL's query string, so it will appear in github.com's request logs.
// That is safe because the flow is PKCE (S256): the code_verifier is
// generated server-side in the pilot (randomBytes) and held only in its
// pending-setups map — it never appears in the authorization URL or the
// redirect. Spotify only exchanges the code for tokens when presented with
// the matching verifier, so a bare code from a log is useless. Pending
// setups are single-use and expire.
export const DEFAULT_SPOTIFY_REDIRECT_URI = "https://dreveman.github.io/muse-code-space/spotify/";

/**
 * The exact redirect URI to register in the Spotify Developer app.
 * When the Space is loaded inside a non-HTTP custom WebView scheme (such as
 * `hatch-space://...` in the iOS app), falls back to the hosted HTTPS callback
 * page (`https://dreveman.github.io/muse-code-space/spotify/`) which copies the
 * Completion URL to the clipboard and guides the user back to Code Space.
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
    if (state && state.length > 0) return state;
  } catch { /* fall through */ }
  const tokens = extractSpotifyTokens(trimmed);
  return tokens?.state ?? null;
}

function decodeBase64UrlUtf8(b64url: string): string | null {
  try {
    const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
    if (typeof atob === "function") {
      return decodeURIComponent(escape(atob(padded)));
    }
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function extractSpotifyTokens(input: string): {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  state: string | null;
} | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const encoded = hashParams.get("spotify_tokens") ?? url.searchParams.get("spotify_tokens");
    if (!encoded) return null;
    const raw = decodeBase64UrlUtf8(encoded);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.access_token === "string" && parsed.access_token && typeof parsed?.refresh_token === "string" && parsed.refresh_token) {
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_in: Number(parsed.expires_in) > 0 ? Number(parsed.expires_in) : 3600,
        state: typeof parsed.state === "string" && parsed.state ? parsed.state : url.searchParams.get("state"),
      };
    }
  } catch {
    // Not a token-bundle URL.
  }
  return null;
}

export function decodeSpotifyStatePkce(state: string | null | undefined): {
  clientId: string;
  verifier: string;
} | null {
  if (typeof state !== "string") return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const raw = decodeBase64UrlUtf8(state.slice(dot + 1));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.c === "string" && parsed.c && typeof parsed?.v === "string" && parsed.v) {
      return { clientId: parsed.c, verifier: parsed.v };
    }
  } catch { /* ignore */ }
  return null;
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

// Pure helpers for the Spotify companion-music UI (no React, no storage).
// Playback state is global to the Spotify account and is never stored
// client-side; these helpers only shape what the components render.

/** The exact redirect URI to register in the Spotify Developer app. */
export function spotifyRedirectUri(location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname || "/"}`;
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

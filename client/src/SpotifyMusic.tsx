// Spotify companion music UI: the setup dialog, the companion card's
// "Music taste" section, and the session playback control.
//
// Playback state is global to the user's Spotify account (never per
// session, never stored client-side). Nothing here starts or changes
// playback except an explicit Tune in / control press.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { CompanionMusic } from "../../server/src/companionMusic";
import { deriveSpotifyControlState, extractSpotifyAuthCode, spotifyRedirectUri } from "./spotifyControlLogic";

type MusicCompanion = { id: string; name: string; music: CompanionMusic | null };

function useSpotifyStatus() {
  return useQuery({
    queryKey: ["spotify-status"],
    queryFn: () => api.getSpotifyStatus({}),
    staleTime: 5000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Setup dialog (modeled on the GitHub setup dialog): create a Spotify
// Developer app, register the exact redirect URI shown, enter the Client
// ID, approve in Spotify, land back in Code Space. If Spotify returns the
// user somewhere the callback didn't run, pasting the redirect URL into
// the same dialog completes the connection instead.
// ---------------------------------------------------------------------------

export function SpotifySetupDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const statusQuery = useSpotifyStatus();
  const connected = statusQuery.data?.connected === true;
  const [clientId, setClientId] = useState("");
  const [startedState, setStartedState] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const redirectUri = spotifyRedirectUri(window.location);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startSpotifySetup({ client_id: clientId, redirect_uri: redirectUri });
      if (!res.ok || !res.auth_url) {
        setError(res.error ?? "Could not start the Spotify connection.");
        return;
      }
      setStartedState(res.state);
      window.location.assign(res.auth_url);
    } finally {
      setBusy(false);
    }
  };

  const completeFromPaste = async () => {
    const code = extractSpotifyAuthCode(pasteValue);
    if (!code) {
      setError("Paste the full URL Spotify sent you back to (it contains a code), or the code itself.");
      return;
    }
    if (!startedState) {
      setError("Click Connect with Spotify first, approve in Spotify, then paste the redirect URL here.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.completeSpotifySetup({ code, state: startedState });
      if (!res.ok) {
        setError(res.error ?? "Spotify did not accept that code.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["spotify-status"] });
      onClose();
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="spotify-setup-title">
        <h2 id="spotify-setup-title">Connect Spotify</h2>
        {connected ? (
          <>
            <p>Spotify is connected{statusQuery.data?.account_name ? <> as <strong style={{ color: "inherit" }}>{statusQuery.data.account_name}</strong></> : ""}. Companion playlists will play on your Spotify account through Spotify Connect.</p>
            {error && <p className="confirm-dialog-error" role="alert">{error}</p>}
            <div className="confirm-dialog-actions">
              <button type="button" className="confirm-dialog-cancel" onClick={onClose} disabled={busy}>Close</button>
              <button type="button" className="confirm-dialog-delete" onClick={() => void disconnect()} disabled={busy}>
                {busy ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>Code Space plays each companion's playlist on <strong style={{ color: "inherit" }}>your</strong> Spotify account (Premium required for playback control). Create a Spotify Developer app, then connect it here:</p>
            <ol className="spotify-setup-steps">
              <li>Open <code>developer.spotify.com/dashboard</code> and create an app (name it anything, e.g. “Code Space”).</li>
              <li>In the app settings, add this exact Redirect URI:<br /><code className="spotify-redirect-uri">{redirectUri}</code></li>
              <li>Copy the app's Client ID below and click Connect. Spotify asks you to approve; you land back here connected.</li>
            </ol>
            <label className="dialog-field">
              <span>Spotify Client ID</span>
              <input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID from your Spotify app" data-autofocus disabled={busy} />
            </label>
            {startedState && (
              <label className="dialog-field">
                <span>Sent back somewhere that didn't finish? Paste the redirect URL (or code) here</span>
                <input value={pasteValue} onChange={(event) => setPasteValue(event.target.value)} placeholder="https://…/?code=…" disabled={busy} />
              </label>
            )}
            {error && <p className="confirm-dialog-error" role="alert">{error}</p>}
            <div className="confirm-dialog-actions">
              <button type="button" className="confirm-dialog-cancel" onClick={onClose} disabled={busy}>Cancel</button>
              {startedState && (
                <button type="button" className="confirm-dialog-cancel" onClick={() => void completeFromPaste()} disabled={busy}>
                  Complete with pasted code
                </button>
              )}
              <button type="button" className="confirm-dialog-primary" onClick={() => void connect()} disabled={busy || !clientId.trim()}>
                {busy ? "Connecting…" : "Connect with Spotify"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const music = companion.music;
  if (!music) return null;

  const connected = statusQuery.data?.connected === true;
  const tuneIn = async () => {
    setBusy(true);
    setError(null);
    try {
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

  const taste = [music.genre, ...music.tags, ...(music.playlist ? [music.playlist.name] : [])].join(" · ");
  return (
    <div className="companion-music-row">
      <dt>Music taste</dt>
      <dd>
        {connected ? (
          <>
            <span className="companion-music-line" title={taste}>{taste}</span>
            {music.playlist ? (
              <button type="button" className="companion-music-icon-button" onClick={() => void tuneIn()} disabled={busy}
                aria-label={`Tune in to ${music.playlist.name} on Spotify`} title={`Tune in: ${music.playlist.name}`}>
                <SpotifyIcon />
              </button>
            ) : (
              <span className="companion-music-icon" title="Spotify connected" aria-label="Spotify connected"><SpotifyIcon /></span>
            )}
          </>
        ) : (
          <button type="button" className="companion-music-connect" onClick={() => setDialogOpen(true)}>
            <SpotifyIcon /> Connect Spotify
          </button>
        )}
        {error && <span className="companion-music-error" role="alert">{error}</span>}
      </dd>
      {dialogOpen && <SpotifySetupDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session playback control. Polls playback every 10s while mounted (the
// session view mounts it only for the visible session).
// ---------------------------------------------------------------------------

export function SpotifyMusicControl() {
  const queryClient = useQueryClient();
  const statusQuery = useSpotifyStatus();
  const connected = statusQuery.data?.connected === true;
  const playbackQuery = useQuery({
    queryKey: ["spotify-playback"],
    queryFn: () => api.getSpotifyPlayback({}),
    enabled: connected,
    refetchInterval: 10_000,
    retry: false,
  });
  const devicesQuery = useQuery({
    queryKey: ["spotify-devices"],
    queryFn: () => api.getSpotifyDevices({}),
    enabled: connected,
    refetchInterval: 30_000,
    retry: false,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const devices = devicesQuery.data?.devices ?? [];
  const playback = playbackQuery.data?.playback ?? null;
  const state = deriveSpotifyControlState({ connected, devices });
  const activeDevice = devices.find((device) => device.is_active) ?? null;
  const deviceId = selectedDeviceId ?? activeDevice?.id ?? undefined;
  const shownVolume = volume ?? playback?.device?.volume_percent ?? activeDevice?.volume_percent ?? 50;

  const run = async (action: () => Promise<{ ok: boolean; error: string | null }>) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await action();
      if (!res.ok) {
        setActionError(res.error ?? "Spotify reported an error.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["spotify-playback"] });
    } finally {
      setBusy(false);
    }
  };

  if (statusQuery.data && !connected) {
    return (
      <div className="spotify-music-control">
        <button type="button" className="spotify-connect-button" onClick={() => setDialogOpen(true)}>
          <SpotifyIcon /> Connect Spotify
        </button>
        {statusQuery.data.error && <span className="spotify-music-error">{statusQuery.data.error}</span>}
        {dialogOpen && <SpotifySetupDialog onClose={() => setDialogOpen(false)} />}
      </div>
    );
  }

  const error = actionError
    ?? (playbackQuery.data && !playbackQuery.data.ok ? playbackQuery.data.error : null)
    ?? (devicesQuery.data && !devicesQuery.data.ok ? devicesQuery.data.error : null);

  return (
    <div className="spotify-music-control" aria-label="Spotify playback">
      <span className="spotify-track" title={playback?.track ? `${playback.track.name} — ${playback.track.artists.join(", ")}` : undefined}>
        {playback?.track
          ? <>{playback.track.name} <span className="spotify-track-artist">· {playback.track.artists.join(", ")}</span></>
          : state === "no-device" ? "Open Spotify on a device to play music" : "Nothing playing"}
      </span>
      <div className="spotify-controls">
        <button type="button" aria-label="Previous track" disabled={busy || state !== "ready"}
          onClick={() => void run(() => api.skipSpotifyTrack({ direction: "previous" }))}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h2.5v14H7zM19 5v14L9.5 12z" /></svg>
        </button>
        {playback?.is_playing ? (
          <button type="button" aria-label="Pause" disabled={busy || state !== "ready"}
            onClick={() => void run(() => api.pauseSpotifyPlayback({}))}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></svg>
          </button>
        ) : (
          <button type="button" aria-label="Play" disabled={busy || state !== "ready"}
            onClick={() => void run(() => api.resumeSpotifyPlayback({ device_id: deviceId }))}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          </button>
        )}
        <button type="button" aria-label="Next track" disabled={busy || state !== "ready"}
          onClick={() => void run(() => api.skipSpotifyTrack({ direction: "next" }))}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 5H17v14h-2.5zM5 5v14l9.5-7z" /></svg>
        </button>
      </div>
      <select className="spotify-device-picker" aria-label="Spotify Connect device" value={deviceId ?? ""}
        disabled={state !== "ready"} onChange={(event) => setSelectedDeviceId(event.target.value || null)}>
        {devices.length === 0 && <option value="">No devices</option>}
        {devices.map((device) => (
          <option key={device.id} value={device.id}>{device.name}{device.is_active ? " (active)" : ""}</option>
        ))}
      </select>
      <input className="spotify-volume" type="range" min={0} max={100} step={1} value={shownVolume}
        aria-label="Volume" disabled={busy || state !== "ready"}
        onChange={(event) => setVolume(Number(event.target.value))}
        onPointerUp={() => { if (volume !== null) void run(() => api.setSpotifyVolume({ volume_percent: volume })); }}
        onKeyUp={() => { if (volume !== null) void run(() => api.setSpotifyVolume({ volume_percent: volume })); }} />
      {error && <span className="spotify-music-error" role="alert">{error}</span>}
      {dialogOpen && <SpotifySetupDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}

// Run: node --test client/src/spotifyMusic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveSpotifyControlState,
  extractSpotifyAuthCode,
  extractSpotifyAuthState,
  isCompanionBusyInSessions,
  shouldOpenSpotifyAuthInNewTab,
  SPOTIFY_BUSY_VOLUME,
  SPOTIFY_IDLE_VOLUME,
  spotifyRedirectUri,
  targetCompanionVolume,
} from "./spotifyControlLogic.ts";

test("spotifyRedirectUri is the exact app origin + path to register in the Spotify app", () => {
  assert.equal(
    spotifyRedirectUri({ origin: "https://code-space.example", pathname: "/apps/space/" }),
    "https://code-space.example/apps/space/",
  );
  assert.equal(spotifyRedirectUri({ origin: "http://127.0.0.1:4173", pathname: "" }), "http://127.0.0.1:4173/");
  assert.equal(
    spotifyRedirectUri({ origin: "hatch-space://12344", pathname: "/", href: "hatch-space://12344/" }),
    "http://127.0.0.1:4173/",
  );
  assert.equal(
    spotifyRedirectUri({ origin: "null", pathname: "", href: "hatch-space://12344/?viewer_assertion=tok#top" }),
    "http://127.0.0.1:4173/",
  );
});

test("extractSpotifyAuthCode accepts a pasted redirect URL or a bare code", () => {
  assert.equal(
    extractSpotifyAuthCode("https://code-space.example/?code=ABC123&state=xyz"),
    "ABC123",
  );
  assert.equal(
    extractSpotifyAuthState("https://code-space.example/?code=ABC123&state=xyz"),
    "xyz",
  );
  assert.equal(extractSpotifyAuthState("  ABC123  "), null);
  assert.equal(extractSpotifyAuthCode("  ABC123  "), "ABC123");
  assert.equal(extractSpotifyAuthCode("https://code-space.example/?error=access_denied"), null);
  assert.equal(extractSpotifyAuthCode(""), null);
  assert.equal(extractSpotifyAuthCode("not a code at all"), null);
  const topWin = {};
  topWin.parent = topWin;
  assert.equal(shouldOpenSpotifyAuthInNewTab(topWin, false), false);
  assert.equal(shouldOpenSpotifyAuthInNewTab(topWin, true), true);
  assert.equal(shouldOpenSpotifyAuthInNewTab({ parent: {} }, false), true);
});

test("targetCompanionVolume and isCompanionBusyInSessions adjust volume for busy vs idle companions", () => {
  assert.equal(targetCompanionVolume(false), SPOTIFY_IDLE_VOLUME);
  assert.equal(targetCompanionVolume(true), SPOTIFY_BUSY_VOLUME);
  assert.ok(SPOTIFY_IDLE_VOLUME < SPOTIFY_BUSY_VOLUME, "idle volume is lower than busy volume");

  const idleSessions = [
    { title: "Poppy", status: "succeeded", archived: false, needs_you: false },
    { title: "Remy", status: "running", archived: true, needs_you: false },
  ];
  assert.equal(isCompanionBusyInSessions("Poppy", idleSessions), false);
  assert.equal(isCompanionBusyInSessions("Remy", idleSessions), false, "archived sessions are not busy");
  assert.equal(isCompanionBusyInSessions("Poppy", idleSessions, "Poppy"), true, "starting draft counts as busy");

  const busySessions = [
    { title: "Poppy", status: "running", archived: false, needs_you: false },
  ];
  assert.equal(isCompanionBusyInSessions("Poppy", busySessions), true);
  assert.equal(
    isCompanionBusyInSessions("Poppy", [{ title: "Poppy", status: "running", archived: false, needs_you: true }]),
    false,
    "waiting for user input lowers volume back to idle",
  );
});

test("music section renders genre and playlist, and Tune in needs a playlist and a connection", () => {
  const music = readFileSync(new URL("./SpotifyMusic.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(music.includes("Music taste"), "section is labelled Music taste");
  assert.ok(music.includes("Tune in"), "playlist companions get a Tune in button");
  assert.ok(music.includes("Connect Spotify"), "disconnected state offers Connect Spotify");
  assert.ok(!music.includes("SpotifyMusicControl"), "no floating top-bar playback control");
  assert.ok(!app.includes("SpotifyMusicControl"), "no floating top-bar playback control in App");
  assert.ok(!music.includes("localStorage"), "no client-side token/playback storage");
  const comp = readFileSync(new URL("./Companions.tsx", import.meta.url), "utf8");
  assert.ok(comp.includes("CompanionMusicSection"), "the companion card details render the music section");
});

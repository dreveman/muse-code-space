// Run: node --test client/src/spotifyMusic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveSpotifyControlState, extractSpotifyAuthCode, spotifyRedirectUri } from "./spotifyControlLogic.ts";

test("spotifyRedirectUri is the exact app origin + path to register in the Spotify app", () => {
  assert.equal(
    spotifyRedirectUri({ origin: "https://code-space.example", pathname: "/apps/space/" }),
    "https://code-space.example/apps/space/",
  );
  assert.equal(spotifyRedirectUri({ origin: "http://127.0.0.1:4173", pathname: "" }), "http://127.0.0.1:4173/");
});

test("extractSpotifyAuthCode accepts a pasted redirect URL or a bare code", () => {
  assert.equal(
    extractSpotifyAuthCode("https://code-space.example/?code=ABC123&state=xyz"),
    "ABC123",
  );
  assert.equal(extractSpotifyAuthCode("  ABC123  "), "ABC123");
  assert.equal(extractSpotifyAuthCode("https://code-space.example/?error=access_denied"), null);
  assert.equal(extractSpotifyAuthCode(""), null);
  assert.equal(extractSpotifyAuthCode("not a code at all"), null);
});

test("deriveSpotifyControlState distinguishes connect, no-device, and ready", () => {
  assert.equal(deriveSpotifyControlState({ connected: false, devices: [] }), "connect");
  assert.equal(deriveSpotifyControlState({ connected: true, devices: [] }), "no-device");
  assert.equal(deriveSpotifyControlState({ connected: true, devices: [{ id: "d1" }] }), "ready");
});

test("music section renders genre and playlist, and Tune in needs a playlist and a connection", () => {
  const music = readFileSync(new URL("./SpotifyMusic.tsx", import.meta.url), "utf8");
  assert.ok(music.includes("Music taste"), "section is labelled Music taste");
  assert.ok(music.includes("Tune in"), "playlist companions get a Tune in button");
  assert.ok(music.includes("Connect Spotify"), "disconnected state offers Connect Spotify");
  const comp = readFileSync(new URL("./Companions.tsx", import.meta.url), "utf8");
  assert.ok(comp.includes("CompanionMusicSection"), "the companion card details render the music section");
});

test("session control polls playback only while mounted and never stores playback in session state", () => {
  const music = readFileSync(new URL("./SpotifyMusic.tsx", import.meta.url), "utf8");
  assert.ok(music.includes("getSpotifyPlayback"), "control reads account playback");
  assert.ok(music.includes("refetchInterval: 10_000"), "10s polling while mounted");
  assert.ok(!music.includes("localStorage"), "no client-side token/playback storage");
});

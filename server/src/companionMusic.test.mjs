// Run: node --test server/src/companionMusic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { companionMusicOf, resolveCompanionPlaylist } from "./companionMusic.ts";

const catalog = JSON.parse(readFileSync(new URL("../../companions/catalog.json", import.meta.url), "utf8"));

test("every catalog companion has a music genre and at least one tag", () => {
  assert.ok(catalog.companions.length > 0);
  for (const companion of catalog.companions) {
    const music = companionMusicOf(companion);
    assert.ok(music, `${companion.id} has a valid music profile`);
    assert.ok(music.genre.length > 0, `${companion.id} genre`);
    assert.ok(music.tags.length >= 1, `${companion.id} tags`);
  }
});

test("catalog playlists have agreeing, well-formed uri and url", () => {
  let withPlaylist = 0;
  for (const companion of catalog.companions) {
    const raw = companion.music.playlist;
    if (raw === null) continue;
    withPlaylist += 1;
    assert.match(raw.uri, /^spotify:playlist:[A-Za-z0-9]+$/, companion.id);
    assert.match(raw.url, /^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+$/, companion.id);
    assert.ok(raw.url.endsWith(raw.uri.slice("spotify:playlist:".length)), `${companion.id} uri/url agree`);
    assert.ok(typeof raw.name === "string" && raw.name.length > 0, companion.id);
  }
  assert.ok(withPlaylist > 0, "at least one companion has a verified playlist");
});

test("resolveCompanionPlaylist resolves by ID and rejects unknown or playlist-less companions", () => {
  const poppy = resolveCompanionPlaylist(catalog.companions, "poppy");
  assert.equal(poppy.ok, true);
  assert.match(poppy.uri, /^spotify:playlist:/);

  assert.deepEqual(resolveCompanionPlaylist(catalog.companions, "no-such-companion"), {
    ok: false, error: "Unknown companion.",
  });

  const playlistless = catalog.companions.find((c) => c.music.playlist === null);
  assert.ok(playlistless, "fixture: a companion without a playlist exists");
  const result = resolveCompanionPlaylist(catalog.companions, playlistless.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /no playlist/);
});

test("no Spotify action accepts a client-supplied URI", () => {
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const section = actions.slice(actions.indexOf("getSpotifyStatus: defineAction({"), actions.indexOf("getSessionVcsStatus: defineAction({"));
  assert.ok(section.length > 0, "spotify actions exist");
  // No request schema in the Spotify actions accepts a URI from the client
  // (playback state's own context_uri response field is not a request, and
  // startSpotifySetup's redirect_uri is the OAuth callback, not a playlist).
  for (const name of ["playCompanionMusic", "pauseSpotifyPlayback", "resumeSpotifyPlayback", "skipSpotifyTrack", "setSpotifyVolume", "completeSpotifySetup", "disconnectSpotify"]) {
    const start = section.indexOf(`${name}: defineAction({`);
    assert.ok(start >= 0, `${name} exists`);
    const requestBlock = section.slice(start, section.indexOf("response:", start));
    assert.ok(!/uri/.test(requestBlock), `${name} never reads a URI from the request`);
  }
  const play = section.slice(section.indexOf("playCompanionMusic: defineAction({"), section.indexOf("pauseSpotifyPlayback: defineAction({"));
  assert.ok(play.includes("companion_id"), "playback is addressed by companion_id");
  assert.ok(play.includes("resolveCompanionPlaylist"), "the server resolves the URI from the catalog");
});

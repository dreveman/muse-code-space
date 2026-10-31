// Run: node --test pilot/spotify.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpotifyClient, SPOTIFY_SCOPES } from "./spotify.mjs";

function harness({ now = 1_700_000_000_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spotify-test-"));
  const configFile = join(dir, "spotify.json");
  const calls = [];
  let currentNow = now;
  const state = {
    tokenResponses: [],
    apiHandler: null,
  };
  const request = async (method, url, { headers = {}, body = null } = {}) => {
    calls.push({ method, url, headers, body });
    if (url.startsWith("https://accounts.spotify.com/")) {
      const next = state.tokenResponses.shift();
      if (!next) throw new Error("unexpected token request");
      return next;
    }
    if (state.apiHandler) return state.apiHandler(method, url, { headers, body });
    return { status: 200, json: {} };
  };
  const client = createSpotifyClient({
    configFile,
    request,
    now: () => currentNow,
    randomBytes: (n) => Buffer.alloc(n, 7),
  });
  return {
    dir, configFile, calls, state, client,
    setNow: (v) => { currentNow = v; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const START = { clientId: "client-123", redirectUri: "https://example.test/callback" };

test("setup start returns a PKCE auth URL with only the MVP scopes", async () => {
  const h = harness();
  try {
    const { auth_url, state } = await h.client.startSetup(START);
    const url = new URL(auth_url);
    assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "client-123");
    assert.equal(url.searchParams.get("redirect_uri"), START.redirectUri);
    assert.equal(url.searchParams.get("state"), state);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge").length >= 43);
    assert.deepEqual(url.searchParams.get("scope").split(" "), [...SPOTIFY_SCOPES]);
    // The auth URL must never carry the verifier itself.
    assert.ok(!auth_url.includes("code_verifier"));

    // Custom app scheme redirect URIs (e.g. hatch-space://12344/ in the iOS app) are accepted.
    const customScheme = await h.client.startSetup({
      clientId: "client-123",
      redirectUri: "hatch-space://12344/",
    });
    assert.equal(new URL(customScheme.auth_url).searchParams.get("redirect_uri"), "hatch-space://12344/");
  } finally { h.cleanup(); }
});

test("setup complete exchanges the code, writes only client_id + refresh_token at 0600", async () => {
  const h = harness();
  try {
    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } });
    h.state.apiHandler = async () => ({ status: 200, json: { display_name: "Test User" } });
    const result = await h.client.completeSetup({ code: "code-1", state });
    assert.equal(result.connected, true);
    assert.equal(result.account_name, "Test User");

    const exchange = h.calls.find((c) => c.url.includes("/api/token"));
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "code-1");
    assert.equal(form.get("redirect_uri"), START.redirectUri);
    assert.equal(form.get("client_id"), "client-123");
    assert.ok(form.get("code_verifier").length >= 43);

    const config = JSON.parse(readFileSync(h.configFile, "utf8"));
    assert.deepEqual(config, { client_id: "client-123", refresh_token: "rt-1" });
    assert.equal(statSync(h.configFile).mode & 0o777, 0o600);
    assert.ok(!readFileSync(h.configFile, "utf8").includes("at-1"), "no access token on disk");
  } finally { h.cleanup(); }
});

test("setup state is single-use and expires after 10 minutes", async () => {
  const h = harness();
  try {
    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 3600 } });
    await h.client.completeSetup({ code: "c", state });
    await assert.rejects(h.client.completeSetup({ code: "c", state }), /unknown or expired/);

    const second = await h.client.startSetup(START);
    h.setNow(1_700_000_000_000 + 10 * 60_000 + 1);
    await assert.rejects(h.client.completeSetup({ code: "c", state: second.state }), /unknown or expired/);
  } finally { h.cleanup(); }
});

test("malformed setup input fails fast and writes nothing", async () => {
  const h = harness();
  try {
    await assert.rejects(h.client.startSetup({ clientId: "", redirectUri: START.redirectUri }), /Client ID/);
    await assert.rejects(h.client.startSetup({ clientId: "x", redirectUri: "not a url" }), /redirect URI/i);
    await assert.rejects(h.client.completeSetup({ code: "", state: "s" }), /code/);
    await assert.rejects(h.client.completeSetup({ code: "c", state: "" }), /state/);
    await assert.rejects(h.client.completeSetup({ code: "c", state: "never-issued" }), /unknown or expired/);
    assert.equal(h.calls.length, 0, "no Spotify call on malformed input");
    assert.equal(existsSync(h.configFile), false);

    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 400, json: { error: "invalid_grant", error_description: "bad code" } });
    await assert.rejects(h.client.completeSetup({ code: "bad", state }), /invalid_grant|bad code/);
    assert.equal(existsSync(h.configFile), false, "nothing written when the exchange fails");
  } finally { h.cleanup(); }
});

test("access tokens are cached in memory and refreshed with 60s of slack", async () => {
  const h = harness();
  try {
    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } });
    await h.client.completeSetup({ code: "c", state });
    const tokenCalls = () => h.calls.filter((c) => c.url.includes("/api/token")).length;
    assert.equal(tokenCalls(), 1, "the setup exchange itself");

    h.state.apiHandler = async () => ({ status: 200, json: { devices: [] } });
    await h.client.devices();
    await h.client.devices();
    assert.equal(tokenCalls(), 1, "cached access token is reused");

    // Move inside the 60s slack window before expiry: next call refreshes.
    h.setNow(1_700_000_000_000 + (3600 - 30) * 1000);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at-2", expires_in: 3600 } });
    await h.client.devices();
    assert.equal(tokenCalls(), 2, "refresh grant used near expiry");
    const refresh = h.calls.filter((c) => c.url.includes("/api/token")).at(-1);
    assert.equal(new URLSearchParams(refresh.body).get("grant_type"), "refresh_token");
    assert.equal(new URLSearchParams(refresh.body).get("refresh_token"), "rt-1");
  } finally { h.cleanup(); }
});

test("a 401 refreshes once and retries once, then surfaces the error", async () => {
  const h = harness();
  try {
    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } });
    await h.client.completeSetup({ code: "c", state });

    let apiAttempts = 0;
    h.state.apiHandler = async () => {
      apiAttempts += 1;
      return apiAttempts === 1
        ? { status: 401, json: { error: { message: "The access token expired" } } }
        : { status: 200, json: { devices: [{ id: "d1" }] } };
    };
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at-2", expires_in: 3600 } });
    const devices = await h.client.devices();
    assert.equal(devices.length, 1);
    assert.equal(apiAttempts, 2, "one retry after the refresh");

    // A persistent 401 surfaces instead of looping.
    apiAttempts = 0;
    h.state.apiHandler = async () => { apiAttempts += 1; return { status: 401, json: { error: { message: "bad token" } } }; };
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at-3", expires_in: 3600 } });
    await assert.rejects(h.client.devices(), /bad token/);
    assert.equal(apiAttempts, 2, "still exactly one retry");
  } finally { h.cleanup(); }
});

test("volume is validated to 0-100 before any Spotify call", async () => {
  const h = harness();
  try {
    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 3600 } });
    await h.client.completeSetup({ code: "c", state });
    const before = h.calls.length;
    await assert.rejects(h.client.setVolume(-1), /0 and 100/);
    await assert.rejects(h.client.setVolume(101), /0 and 100/);
    await assert.rejects(h.client.setVolume(50.5), /0 and 100/);
    assert.equal(h.calls.length, before, "no Spotify call for invalid volume");
    h.state.apiHandler = async () => ({ status: 204, json: null });
    await h.client.setVolume(0);
    await h.client.setVolume(100);
  } finally { h.cleanup(); }
});

test("play falls back to an available smartphone device when no device is currently active", async () => {
  const h = harness();
  try {
    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 3600 } });
    await h.client.completeSetup({ code: "c", state });

    const playUrls = [];
    h.state.apiHandler = async (method, url) => {
      if (url.endsWith("/v1/me/player/play")) {
        playUrls.push(url);
        return { status: 404, json: { error: { message: "Player command failed: No active device found" } } };
      }
      if (url.endsWith("/v1/me/player/devices")) {
        return {
          status: 200,
          json: {
            devices: [
              { id: "mac-1", name: "MacBook", type: "Computer", is_active: false, volume_percent: 50 },
              { id: "iphone-1", name: "iPhone", type: "Smartphone", is_active: false, volume_percent: 60 },
            ],
          },
        };
      }
      if (url.includes("/v1/me/player/play?device_id=")) {
        playUrls.push(url);
        return { status: 204, json: null };
      }
      return { status: 204, json: null };
    };

    const res = await h.client.play({ contextUri: "spotify:playlist:37i9dQZF1DX8Uebhn9wzrS" });
    assert.deepEqual(res, { ok: true });
    assert.equal(playUrls.length, 2);
    assert.ok(playUrls[1].endsWith("?device_id=iphone-1"), "prefers Smartphone device when none is active");
  } finally { h.cleanup(); }
});

test("disconnect deletes the config and status reports disconnected", async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.client.status(), { connected: false });
    const { state } = await h.client.startSetup(START);
    h.state.tokenResponses.push({ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 3600 } });
    h.state.apiHandler = async () => ({ status: 200, json: { display_name: "Test User" } });
    await h.client.completeSetup({ code: "c", state });
    assert.equal((await h.client.status()).connected, true);
    await h.client.disconnect();
    assert.equal(existsSync(h.configFile), false);
    assert.deepEqual(await h.client.status(), { connected: false });
    await assert.rejects(h.client.devices(), /not connected/);
  } finally { h.cleanup(); }
});

test("browser-supplied tokens complete setup and refresh without hitting accounts.spotify.com/api/token from the pilot", async () => {
  const h = harness();
  try {
    const { state, code_verifier } = await h.client.startSetup(START);
    assert.ok(typeof code_verifier === "string" && code_verifier.length >= 43);
    h.state.apiHandler = async () => ({ status: 200, json: { display_name: "Browser User" } });

    // No tokenResponses queued: any pilot call to accounts.spotify.com/api/token would throw.
    const completed = await h.client.completeSetup({
      state,
      accessToken: "browser-at-1",
      refreshToken: "browser-rt-1",
      expiresIn: 3600,
    });
    assert.deepEqual(completed, { connected: true, account_name: "Browser User" });
    assert.equal(h.calls.filter((c) => c.url.includes("/api/token")).length, 0);

    const refreshBefore = h.client.tokenRefreshParams();
    assert.equal(refreshBefore.connected, true);
    assert.equal(refreshBefore.needs_refresh, false);
    assert.equal(refreshBefore.client_id, "client-123");
    assert.equal(refreshBefore.refresh_token, "browser-rt-1");

    // Advance into the 5-minute browser refresh window.
    h.setNow(1_700_000_000_000 + (3600 - 120) * 1000);
    assert.equal(h.client.tokenRefreshParams().needs_refresh, true);

    await h.client.updateTokens({
      accessToken: "browser-at-2",
      refreshToken: "browser-rt-2",
      expiresIn: 3600,
    });
    assert.equal(h.client.tokenRefreshParams().needs_refresh, false);
    assert.equal(h.client.tokenRefreshParams().refresh_token, "browser-rt-2");
    assert.equal(h.calls.filter((c) => c.url.includes("/api/token")).length, 0);
  } finally { h.cleanup(); }
});


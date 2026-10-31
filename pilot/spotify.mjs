// Spotify connection for companion music: Authorization Code + PKCE setup,
// an in-memory access-token cache, and Spotify Connect playback control.
//
// Mirrors githubAppSetup.mjs conventions:
//   - Validation happens before any network call; malformed input fails
//     fast with a precise error and nothing is written.
//   - The config file is written only after Spotify confirms the exchange,
//     at mode 0600, and contains only { client_id, refresh_token }.
//   - Access tokens live in memory only. Nothing secret (tokens, auth
//     codes, PKCE verifiers) is ever logged.
//   - Spotify HTTPS goes through the egress proxy / CA chain the same way
//     githubAppSetup.mjs reaches api.github.com.
//
// All HTTP goes through an injectable `request(method, url, {headers, body})`
// -> { status, json } so tests stub Spotify entirely (no live calls).

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { proxyForHost, resolveGithubCa } from "./githubAppSetup.mjs";

export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
];

const ACCOUNTS_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com";
const SETUP_STATE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SLACK_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Default transport: HTTP/1.1 over TCP/TLS, through the egress proxy when
// one is configured (same discipline as githubAppSetup.mjs).
// ---------------------------------------------------------------------------

function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, host);
    const timer = setTimeout(() => fail(new Error(`connect to ${host}:${port} timed out`)), timeoutMs);
    function fail(error) {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

function connectViaProxy(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port || 80);
    const socket = netConnect(proxyPort, proxy.hostname);
    const timer = setTimeout(() => fail(new Error("proxy CONNECT timed out")), timeoutMs);
    let buffer = Buffer.alloc(0);
    let settled = false;
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    socket.once("error", fail);
    socket.once("connect", () => {
      const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
      if (proxy.username) {
        const user = decodeURIComponent(proxy.username);
        const pass = decodeURIComponent(proxy.password ?? "");
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const statusLine = buffer.subarray(0, headEnd).toString("latin1").split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 200) return fail(new Error(`proxy CONNECT failed (${statusLine})`));
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", fail);
      socket.removeAllListeners("data");
      resolve(socket);
    });
  });
}

function tlsOver(socket, { servername, ca, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, servername, ca, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => fail(new Error("TLS handshake timed out")), timeoutMs);
    function fail(error) {
      clearTimeout(timer);
      tlsSocket.destroy();
      reject(error);
    }
    tlsSocket.once("error", fail);
    tlsSocket.once("secureConnect", () => {
      clearTimeout(timer);
      tlsSocket.removeListener("error", fail);
      resolve(tlsSocket);
    });
  });
}

function decodeChunked(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("latin1").split(";")[0], 16);
    if (Number.isNaN(size)) return null;
    if (size === 0) return Buffer.concat(parts);
    const start = lineEnd + 2;
    if (buffer.length < start + size + 2) return null;
    parts.push(buffer.subarray(start, start + size));
    offset = start + size + 2;
  }
  return null;
}

function readHttpResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => fail(new Error("timed out waiting for Spotify's response")), timeoutMs);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    function done(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    function tryParse(ended) {
      const buffer = Buffer.concat(chunks);
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        if (ended) fail(new Error("Spotify's response was incomplete"));
        return;
      }
      const headLines = buffer.subarray(0, headEnd).toString("latin1").split("\r\n");
      const status = Number((headLines[0] ?? "").split(" ")[1]);
      const headers = new Map();
      for (const line of headLines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const rest = buffer.subarray(headEnd + 4);
      if ((headers.get("transfer-encoding") ?? "").includes("chunked")) {
        const body = decodeChunked(rest);
        if (body === null) {
          if (ended) fail(new Error("Spotify's response was incomplete"));
          return;
        }
        return done({ status, body: body.toString("utf8") });
      }
      const length = Number(headers.get("content-length") ?? NaN);
      if (Number.isFinite(length)) {
        if (rest.length < length) {
          if (ended) fail(new Error("Spotify's response was incomplete"));
          return;
        }
        return done({ status, body: rest.subarray(0, length).toString("utf8") });
      }
      if (ended) return done({ status, body: rest.toString("utf8") });
    }
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      tryParse(false);
    });
    socket.on("error", fail);
    socket.on("end", () => tryParse(true));
    socket.on("close", () => tryParse(true));
  });
}

function defaultSpotifyRequest({ env, brokerCaFile } = {}) {
  const resolvedEnv = env ?? process.env;
  return async (method, urlString, { headers = {}, body = null } = {}) => {
    const url = new URL(urlString);
    const host = url.hostname;
    const port = Number(url.port || 443);
    const ca = resolveGithubCa(resolvedEnv, brokerCaFile);
    const proxy = proxyForHost(resolvedEnv, host);
    const raw = proxy
      ? await connectViaProxy(proxy, host, port, REQUEST_TIMEOUT_MS)
      : await connectTcp(host, port, REQUEST_TIMEOUT_MS);
    const socket = await tlsOver(raw, { servername: host, ca, timeoutMs: REQUEST_TIMEOUT_MS });
    const payload = body ?? "";
    const lines = [
      `${method} ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${host}`,
      "User-Agent: code-space-pilot",
      "Accept: application/json",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${Buffer.byteLength(payload)}`,
      "Connection: close",
      "",
      payload,
    ];
    socket.write(lines.join("\r\n"));
    const { status, body: text } = await readHttpResponse(socket, REQUEST_TIMEOUT_MS);
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status, json };
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function spotifyErrorMessage(status, json) {
  const message = typeof json?.error?.message === "string" && json.error.message
    ? json.error.message
    : typeof json?.error_description === "string" && json.error_description
      ? json.error_description
      : typeof json?.error === "string" && json.error
        ? json.error
        : `HTTP ${status}`;
  return `Spotify: ${message}`;
}

export function createSpotifyClient(deps = {}) {
  const configFile = deps.configFile;
  if (!configFile) throw new Error("createSpotifyClient needs a configFile");
  const request = deps.request ?? defaultSpotifyRequest(deps);
  const now = deps.now ?? (() => Date.now());
  const randomBytes = deps.randomBytes ?? ((n) => cryptoRandomBytes(n));

  const pendingFile = `${configFile}.pending`;
  const tokenCacheFile = `${configFile}.token`;
  const pendingSetups = new Map(); // state -> { verifier, clientId, redirectUri, expiresAt }
  let cachedToken = null; // { accessToken, expiresAt }
  let cachedAccountName = null;

  function loadTokenFromDisk() {
    if (cachedToken) return cachedToken;
    try {
      if (!existsSync(tokenCacheFile)) return null;
      const raw = JSON.parse(readFileSync(tokenCacheFile, "utf8"));
      if (typeof raw?.access_token === "string" && raw.access_token && typeof raw?.expires_at === "number" && raw.expires_at > now()) {
        cachedToken = { accessToken: raw.access_token, expiresAt: raw.expires_at };
        return cachedToken;
      }
    } catch { /* best-effort */ }
    return null;
  }

  function saveTokenToDisk(token) {
    try {
      if (!token) {
        rmSync(tokenCacheFile, { force: true });
        return;
      }
      mkdirSync(dirname(tokenCacheFile), { recursive: true });
      writeFileSync(tokenCacheFile, `${JSON.stringify({ access_token: token.accessToken, expires_at: token.expiresAt }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tokenCacheFile, 0o600);
    } catch { /* best-effort */ }
  }

  function loadPendingFromDisk() {
    try {
      if (!existsSync(pendingFile)) return;
      const raw = JSON.parse(readFileSync(pendingFile, "utf8"));
      if (!raw || typeof raw !== "object") return;
      const at = now();
      for (const [st, val] of Object.entries(raw)) {
        if (
          val &&
          typeof val === "object" &&
          typeof val.verifier === "string" &&
          typeof val.clientId === "string" &&
          typeof val.redirectUri === "string" &&
          typeof val.expiresAt === "number" &&
          val.expiresAt > at &&
          !pendingSetups.has(st)
        ) {
          pendingSetups.set(st, val);
        }
      }
    } catch { /* best-effort */ }
  }

  function savePendingToDisk() {
    try {
      if (pendingSetups.size === 0) {
        rmSync(pendingFile, { force: true });
        return;
      }
      mkdirSync(dirname(pendingFile), { recursive: true });
      const obj = Object.fromEntries(pendingSetups.entries());
      writeFileSync(pendingFile, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
      chmodSync(pendingFile, 0o600);
    } catch { /* best-effort */ }
  }

  function readConfig() {
    try {
      if (!existsSync(configFile)) return null;
      const parsed = JSON.parse(readFileSync(configFile, "utf8"));
      if (typeof parsed?.client_id !== "string" || !parsed.client_id) return null;
      if (typeof parsed?.refresh_token !== "string" || !parsed.refresh_token) return null;
      return { client_id: parsed.client_id, refresh_token: parsed.refresh_token };
    } catch {
      return null;
    }
  }

  function writeConfig(config) {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, `${JSON.stringify({ client_id: config.client_id, refresh_token: config.refresh_token }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configFile, 0o600);
  }

  function prunePending() {
    loadPendingFromDisk();
    const at = now();
    let changed = false;
    for (const [state, pending] of pendingSetups) {
      if (pending.expiresAt <= at) {
        pendingSetups.delete(state);
        changed = true;
      }
    }
    if (changed) savePendingToDisk();
  }

  async function tokenRequest(form) {
    const res = await request("POST", `${ACCOUNTS_BASE}/api/token`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    if (res.status < 200 || res.status >= 300 || typeof res.json?.access_token !== "string") {
      throw new Error(spotifyErrorMessage(res.status, res.json));
    }
    return res.json;
  }

  async function accessToken(forceRefresh = false) {
    const config = readConfig();
    if (!config) throw new Error("Spotify is not connected");
    const activeToken = loadTokenFromDisk();
    if (!forceRefresh && activeToken && activeToken.expiresAt - now() > TOKEN_REFRESH_SLACK_MS) {
      return activeToken.accessToken;
    }
    const json = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: config.refresh_token,
      client_id: config.client_id,
    });
    cachedToken = {
      accessToken: json.access_token,
      expiresAt: now() + Math.max(0, Number(json.expires_in) || 0) * 1000,
    };
    saveTokenToDisk(cachedToken);
    // Spotify may rotate the refresh token; persist the replacement.
    if (typeof json.refresh_token === "string" && json.refresh_token && json.refresh_token !== config.refresh_token) {
      writeConfig({ client_id: config.client_id, refresh_token: json.refresh_token });
    }
    return cachedToken.accessToken;
  }

  // One API call with the 401 discipline: refresh once, retry once, then
  // surface Spotify's error as-is (e.g. Premium restrictions).
  async function api(method, path, body = null) {
    const send = async (token) => request(method, `${API_BASE}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== null ? { "content-type": "application/json" } : {}),
      },
      body: body !== null ? JSON.stringify(body) : null,
    });
    let res = await send(await accessToken());
    if (res.status === 401) {
      cachedToken = null;
      saveTokenToDisk(null);
      res = await send(await accessToken(true));
    }
    if (res.status === 204) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(spotifyErrorMessage(res.status, res.json));
    return res.json;
  }

  async function accountName() {
    if (cachedAccountName) return cachedAccountName;
    const me = await api("GET", "/v1/me");
    cachedAccountName = typeof me?.display_name === "string" && me.display_name ? me.display_name : null;
    return cachedAccountName;
  }

  return {
    async status() {
      if (!readConfig()) return { connected: false };
      let name = null;
      try {
        name = await accountName();
      } catch { /* connected on disk; the name is best-effort */ }
      return name ? { connected: true, account_name: name } : { connected: true };
    },

    async startSetup({ clientId, redirectUri } = {}) {
      const cleanClientId = typeof clientId === "string" ? clientId.trim() : "";
      if (!cleanClientId || cleanClientId.length > 200 || /\s/.test(cleanClientId)) {
        throw new Error("Enter the Client ID from your Spotify Developer app.");
      }
      let parsedRedirect = null;
      try { parsedRedirect = new URL(typeof redirectUri === "string" ? redirectUri.trim() : ""); } catch { parsedRedirect = null; }
      const proto = parsedRedirect?.protocol?.toLowerCase() ?? "";
      const disallowedProto = proto === "javascript:" || proto === "data:" || proto === "vbscript:" || proto === "file:";
      if (!parsedRedirect || !/^[a-z][a-z0-9+.-]*:$/.test(proto) || disallowedProto || parsedRedirect.hash) {
        throw new Error("The redirect URI must be a valid URL without a fragment.");
      }
      prunePending();
      const verifier = Buffer.from(randomBytes(32)).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const nonce = Buffer.from(randomBytes(16)).toString("base64url");
      const pkceMeta = Buffer.from(JSON.stringify({ c: cleanClientId, v: verifier })).toString("base64url");
      const state = `${nonce}.${pkceMeta}`;
      pendingSetups.set(state, {
        verifier,
        clientId: cleanClientId,
        redirectUri: parsedRedirect.toString(),
        expiresAt: now() + SETUP_STATE_TTL_MS,
      });
      savePendingToDisk();
      const auth = new URL(`${ACCOUNTS_BASE}/authorize`);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("client_id", cleanClientId);
      auth.searchParams.set("redirect_uri", parsedRedirect.toString());
      auth.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
      auth.searchParams.set("state", state);
      auth.searchParams.set("code_challenge_method", "S256");
      auth.searchParams.set("code_challenge", challenge);
      return { auth_url: auth.toString(), state, code_verifier: verifier };
    },

    async completeSetup({ code, state, accessToken: providedAccessToken, refreshToken: providedRefreshToken, expiresIn: providedExpiresIn } = {}) {
      const hasProvidedTokens =
        typeof providedAccessToken === "string" && providedAccessToken.trim().length > 0 &&
        typeof providedRefreshToken === "string" && providedRefreshToken.trim().length > 0;
      const cleanCode = typeof code === "string" ? code.trim() : "";
      if (!hasProvidedTokens && (!cleanCode || cleanCode.length > 4096)) {
        throw new Error("Paste the authorization code from the Spotify redirect URL.");
      }
      const cleanState = typeof state === "string" ? state.trim() : "";
      if (!cleanState) throw new Error("Missing setup state — start the Spotify connection again.");
      prunePending();
      const pending = pendingSetups.get(cleanState);
      // Single-use: consumed whether the exchange succeeds or fails.
      pendingSetups.delete(cleanState);
      savePendingToDisk();
      if (!pending) throw new Error("That setup link is unknown or expired — start the Spotify connection again.");
      const json = hasProvidedTokens
        ? {
            access_token: providedAccessToken.trim(),
            refresh_token: providedRefreshToken.trim(),
            expires_in: Number(providedExpiresIn) > 0 ? Number(providedExpiresIn) : 3600,
          }
        : await tokenRequest({
            grant_type: "authorization_code",
            code: cleanCode,
            redirect_uri: pending.redirectUri,
            client_id: pending.clientId,
            code_verifier: pending.verifier,
          });
      if (typeof json.refresh_token !== "string" || !json.refresh_token) {
        throw new Error("Spotify did not return a refresh token — nothing was written.");
      }
      cachedToken = {
        accessToken: json.access_token,
        expiresAt: now() + Math.max(0, Number(json.expires_in) || 0) * 1000,
      };
      saveTokenToDisk(cachedToken);
      cachedAccountName = null;
      // Only a confirmed exchange writes the config.
      writeConfig({ client_id: pending.clientId, refresh_token: json.refresh_token });
      let name = null;
      try { name = await accountName(); } catch { /* connection still counts */ }
      return name ? { connected: true, account_name: name } : { connected: true };
    },

    tokenRefreshParams() {
      const config = readConfig();
      if (!config) {
        return { connected: false, needs_refresh: false, client_id: null, refresh_token: null, expires_at: null };
      }
      const active = loadTokenFromDisk();
      const needsRefresh = !active || active.expiresAt - now() <= 5 * 60_000;
      return {
        connected: true,
        needs_refresh: needsRefresh,
        client_id: config.client_id,
        refresh_token: config.refresh_token,
        expires_at: active ? active.expiresAt : null,
      };
    },

    async updateTokens({ accessToken: nextAccess, refreshToken: nextRefresh, expiresIn } = {}) {
      const config = readConfig();
      if (!config) throw new Error("Spotify is not connected");
      const cleanAccess = typeof nextAccess === "string" ? nextAccess.trim() : "";
      if (!cleanAccess) throw new Error("Missing Spotify access token.");
      const cleanRefresh = typeof nextRefresh === "string" && nextRefresh.trim() ? nextRefresh.trim() : config.refresh_token;
      cachedToken = {
        accessToken: cleanAccess,
        expiresAt: now() + Math.max(60, Number(expiresIn) || 3600) * 1000,
      };
      saveTokenToDisk(cachedToken);
      if (cleanRefresh !== config.refresh_token) {
        writeConfig({ client_id: config.client_id, refresh_token: cleanRefresh });
      }
      return { ok: true, expires_at: cachedToken.expiresAt };
    },

    async disconnect() {
      cachedToken = null;
      cachedAccountName = null;
      pendingSetups.clear();
      savePendingToDisk();
      saveTokenToDisk(null);
      rmSync(configFile, { force: true });
      return { connected: false };
    },

    async devices() {
      const json = await api("GET", "/v1/me/player/devices");
      const list = Array.isArray(json?.devices) ? json.devices : [];
      return list
        .filter((d) => d && typeof d.id === "string" && d.id)
        .map((d) => ({
          id: d.id,
          name: typeof d.name === "string" ? d.name : "Unknown device",
          type: typeof d.type === "string" ? d.type : "unknown",
          is_active: d.is_active === true,
          volume_percent: Number.isSafeInteger(d.volume_percent) ? d.volume_percent : null,
        }));
    },

    async playback() {
      const json = await api("GET", "/v1/me/player");
      if (!json) {
        return { is_playing: false, progress_ms: null, track: null, device: null, context_uri: null };
      }
      const item = json.item && typeof json.item === "object" ? json.item : null;
      const track = item && typeof item.name === "string"
        ? {
          name: item.name,
          artists: Array.isArray(item.artists) ? item.artists.map((a) => a?.name).filter((n) => typeof n === "string") : [],
          uri: typeof item.uri === "string" ? item.uri : null,
          duration_ms: Number.isSafeInteger(item.duration_ms) ? item.duration_ms : null,
        }
        : null;
      const device = json.device && typeof json.device === "object"
        ? {
          id: typeof json.device.id === "string" ? json.device.id : null,
          name: typeof json.device.name === "string" ? json.device.name : null,
          volume_percent: Number.isSafeInteger(json.device.volume_percent) ? json.device.volume_percent : null,
        }
        : null;
      return {
        is_playing: json.is_playing === true,
        progress_ms: Number.isSafeInteger(json.progress_ms) ? json.progress_ms : null,
        track,
        device,
        context_uri: typeof json.context?.uri === "string" ? json.context.uri : null,
      };
    },

    async play({ contextUri, deviceId } = {}) {
      if (typeof contextUri !== "string" || !/^spotify:(playlist|album|artist|track|show|episode):[A-Za-z0-9]+$/.test(contextUri)) {
        throw new Error("A valid Spotify context URI is required to start playback.");
      }
      const query = typeof deviceId === "string" && deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
      try {
        await api("PUT", `/v1/me/player/play${query}`, { context_uri: contextUri });
      } catch (err) {
        if (deviceId) throw err;
        const list = await this.devices().catch(() => []);
        const target =
          list.find((d) => d.is_active) ??
          list.find((d) => typeof d.type === "string" && d.type.toLowerCase() === "smartphone") ??
          list[0];
        if (!target) throw err;
        await api("PUT", `/v1/me/player/play?device_id=${encodeURIComponent(target.id)}`, { context_uri: contextUri });
      }
      return { ok: true };
    },

    async pause() {
      await api("PUT", "/v1/me/player/pause");
      return { ok: true };
    },

    async resume({ deviceId } = {}) {
      const query = typeof deviceId === "string" && deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
      try {
        await api("PUT", `/v1/me/player/play${query}`);
      } catch (err) {
        if (deviceId) throw err;
        const list = await this.devices().catch(() => []);
        const target =
          list.find((d) => d.is_active) ??
          list.find((d) => typeof d.type === "string" && d.type.toLowerCase() === "smartphone") ??
          list[0];
        if (!target) throw err;
        await api("PUT", `/v1/me/player/play?device_id=${encodeURIComponent(target.id)}`);
      }
      return { ok: true };
    },

    async next() {
      await api("POST", "/v1/me/player/next");
      return { ok: true };
    },

    async previous() {
      await api("POST", "/v1/me/player/previous");
      return { ok: true };
    },

    async setVolume(volumePercent) {
      if (!Number.isSafeInteger(volumePercent) || volumePercent < 0 || volumePercent > 100) {
        throw new Error("Volume must be a whole number between 0 and 100.");
      }
      await api("PUT", `/v1/me/player/volume?volume_percent=${volumePercent}`);
      return { ok: true };
    },

    // Exposed for the pilot route to distinguish "not connected" (409-ish
    // UX) from Spotify-side failures without string matching everywhere.
    isConnected() {
      return readConfig() !== null;
    },
  };
}

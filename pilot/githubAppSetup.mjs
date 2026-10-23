// In-process GitHub App validation + credential write for the repo picker's
// "GitHub App" setup step (POST /github-setup, step "app").
//
// This replaces a subprocess hand-off: the pilot used to spawn
// setup_github_broker.py with the private key as the child's stdin
// (execFile `input`), and that script's first step was reading stdin to
// EOF. Node's child stdio on this runtime never delivered EOF, so the
// child blocked until the exec timeout while the dialog's 10s request
// aborted with a generic "Could not connect" — the real validation
// outcome never surfaced and nothing was written. The script remains the
// right tool for a human at a terminal (its original purpose); the
// dialog path validates here instead:
//
//   1. The PEM is parsed locally (node:crypto) before any network call —
//      malformed input fails immediately with a precise error. Nothing
//      ever waits on the input's content to delimit itself.
//   2. An RS256 App JWT is signed in-process and exchanged for an
//      installation token — the same request the broker's
//      GitHubAppTokenProvider makes — through the egress proxy when one
//      is configured, with the broker's retry discipline (connect-stage
//      failures only, bounded attempts, per-attempt timeout).
//   3. Only a successful exchange writes anything: the key file and the
//      broker config (both 0600), plus the login-profile CA pin —
//      exactly what the setup script's non-interactive mode wrote.
//
// The private key is never logged, never placed in argv, and never
// written anywhere except its final destination file.

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { createPrivateKey, createSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const API_HOST = "api.github.com";
const EXCHANGE_ATTEMPTS = 3;
const EXCHANGE_TIMEOUT_MS = 10_000;
const EXCHANGE_BACKOFF_MS = [300, 1000];
const PROFILE_BEGIN = "# >>> muse-code-space github broker >>>";
const PROFILE_END = "# <<< muse-code-space github broker <<<";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function base64url(data) {
  return Buffer.from(data).toString("base64url");
}

// Parse the PEM up front: an unparseable key is a fast, precise failure.
// Returns a KeyObject; throws an Error with a user-facing message.
export function parseGithubAppPrivateKey(pem) {
  try {
    return createPrivateKey(String(pem ?? ""));
  } catch {
    throw new Error("The private key could not be parsed — paste the complete .pem file, including the BEGIN and END lines.");
  }
}

// RS256 App JWT, byte-for-byte the claims the broker's Python provider
// mints: iss = App ID (string), iat backdated 60s, exp +540s.
export function makeGithubAppJwt(appId, keyObject, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: String(appId), iat: nowSeconds - 60, exp: nowSeconds + 540 }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(keyObject);
  return `${signingInput}.${base64url(signature)}`;
}

export function proxyForHost(env, host) {
  const noProxy = String(env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (noProxy.some((entry) => entry === "*" || host === entry || host.endsWith(`.${entry}`))) return null;
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? "";
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// CA bundle for the (possibly MITM-proxied) TLS hop to GitHub, in the
// same preference order the rest of the host uses: an explicit
// SSL_CERT_FILE, the egress bundle, the broker's combined bundle
// (broker cert + system roots), else Node's default store (undefined).
export function resolveGithubCa(env, brokerCaFile) {
  const candidates = [
    env.SSL_CERT_FILE,
    "/run/hatch/egress-tls/ca-bundle.pem",
    brokerCaFile,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      try {
        return readFileSync(candidate);
      } catch { /* fall through to the next candidate */ }
    }
  }
  return undefined;
}

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

// HTTP CONNECT tunnel through the egress proxy; resolves with the raw
// socket once the proxy reports the tunnel established.
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

// Minimal HTTP/1.1 response reader: resolves once the full body (per
// Content-Length / chunked framing, or connection close) has arrived.
function readHttpResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => fail(new Error("timed out waiting for GitHub's response")), timeoutMs);
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
        if (ended) fail(new Error("GitHub's response was incomplete"));
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
          if (ended) fail(new Error("GitHub's response was incomplete"));
          return;
        }
        return done({ status, body: body.toString("utf8") });
      }
      const length = Number(headers.get("content-length") ?? NaN);
      if (Number.isFinite(length)) {
        if (rest.length < length) {
          if (ended) fail(new Error("GitHub's response was incomplete"));
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

// One token-exchange attempt: POST /app/installations/<id>/access_tokens
// with the App JWT, matching the broker provider's request. Any HTTP
// response (success or rejection) resolves; only transport failures
// throw, so the retry loop can apply the broker's discipline.
async function exchangeOnce(jwt, installationId, deps) {
  const { env, ca, apiHost, apiPort, secure, timeoutMs } = deps;
  let socket;
  if (secure) {
    const proxy = proxyForHost(env, apiHost);
    if (proxy) {
      const raw = await connectViaProxy(proxy, apiHost, apiPort, timeoutMs);
      socket = await tlsOver(raw, { servername: apiHost, ca, timeoutMs });
    } else {
      const raw = await connectTcp(apiHost, apiPort, timeoutMs);
      socket = await tlsOver(raw, { servername: apiHost, ca, timeoutMs });
    }
  } else {
    socket = await connectTcp(apiHost, apiPort, timeoutMs);
  }
  const request = [
    `POST /app/installations/${installationId}/access_tokens HTTP/1.1`,
    `Host: ${apiHost}`,
    `Authorization: Bearer ${jwt}`,
    "Accept: application/vnd.github+json",
    "User-Agent: code-space-pilot",
    "Content-Length: 0",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  socket.write(request);
  const { status, body } = await readHttpResponse(socket, timeoutMs);
  let json = null;
  try {
    json = JSON.parse(body);
  } catch { /* non-JSON stays null */ }
  return { status, json };
}

// Exchange with bounded retries on connect-stage failures only — an
// HTTP response from GitHub is an answer, never retried. Mirrors the
// broker's _urlopen_with_retry.
export async function exchangeGithubAppToken(jwt, installationId, deps = {}) {
  const resolved = {
    env: deps.env ?? process.env,
    apiHost: deps.apiHost ?? API_HOST,
    apiPort: deps.apiPort ?? 443,
    secure: deps.secure ?? true,
    timeoutMs: deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
  };
  resolved.ca = deps.ca ?? (resolved.secure ? resolveGithubCa(resolved.env, deps.brokerCaFile) : undefined);
  const attempts = deps.attempts ?? EXCHANGE_ATTEMPTS;
  const backoff = deps.backoffMs ?? EXCHANGE_BACKOFF_MS;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await (deps.sleep ?? sleep)(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1000);
    try {
      return await exchangeOnce(jwt, installationId, resolved);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not reach GitHub (${lastError instanceof Error ? lastError.message : String(lastError)})`);
}

// Pin the broker CA for login terminals (they re-export the egress CA
// after spawn) — the same idempotent marker block the setup script
// maintains in ~/.profile.
export function ensureBrokerProfileBlock(profilePath, caPath) {
  const lines = existsSync(profilePath) ? readFileSync(profilePath, "utf8").split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === PROFILE_BEGIN) skipping = true;
    if (!skipping) kept.push(line);
    if (line.trim() === PROFILE_END) skipping = false;
  }
  const block = [
    PROFILE_BEGIN,
    `export GIT_SSL_CAINFO="${caPath}"`,
    `export SSL_CERT_FILE="${caPath}"`,
    PROFILE_END,
  ];
  const out = kept.concat(kept.length > 0 && kept[kept.length - 1] !== "" ? [""] : [], block);
  writeFileSync(profilePath, `${out.join("\n")}\n`);
}

// Write the App credential exactly as the setup script's
// non-interactive mode did: key file + app-mode config, both 0600,
// and only ever called after validation succeeded.
export function writeGithubAppCredentials({ configFile, profileFile, brokerCaFile, appId, installationId, privateKey }) {
  const configDir = dirname(configFile);
  const keyPath = join(configDir, "github-app-key.pem");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(keyPath, `${String(privateKey).trim()}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const config = {
    mode: "app",
    app_id: String(appId),
    installation_id: String(installationId),
    private_key_path: keyPath,
  };
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configFile, 0o600);
  ensureBrokerProfileBlock(profileFile, brokerCaFile);
  return { configPath: configFile, keyPath };
}

// Validate the App credentials against GitHub, and on success write
// them for the broker. Returns { ok, error } — the contract the
// /github-setup handler has always used. deps are injectable for tests:
// { configFile, profileFile, brokerCaFile, env, exchange, nowSeconds }.
export async function runGithubAppSetup(appId, installationId, privateKey, deps = {}) {
  let keyObject;
  try {
    keyObject = parseGithubAppPrivateKey(privateKey);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The private key could not be parsed." };
  }
  try {
    const jwt = makeGithubAppJwt(appId, keyObject, deps.nowSeconds);
    const exchange = deps.exchange ?? ((token) => exchangeGithubAppToken(token, installationId, deps));
    const { status, json } = await exchange(jwt);
    if (status < 200 || status >= 300) {
      const message = typeof json?.message === "string" && json.message ? ` — ${json.message}` : "";
      return { ok: false, error: `GitHub App validation failed (HTTP ${status}${message}) — nothing written. Check the App ID, installation ID, and private key.` };
    }
    if (!json?.token) {
      return { ok: false, error: "GitHub App validation failed: GitHub returned no installation token — nothing written." };
    }
  } catch (error) {
    return { ok: false, error: `GitHub App validation failed: ${error instanceof Error ? error.message : String(error)} — nothing written.` };
  }
  try {
    writeGithubAppCredentials({
      configFile: deps.configFile,
      profileFile: deps.profileFile,
      brokerCaFile: deps.brokerCaFile,
      appId,
      installationId,
      privateKey,
    });
  } catch (error) {
    return { ok: false, error: `GitHub validated the credentials, but writing them failed (${error instanceof Error ? error.message : String(error)}).` };
  }
  return { ok: true, error: null };
}

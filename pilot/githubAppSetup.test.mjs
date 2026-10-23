// Run: node --test pilot/githubAppSetup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exchangeGithubAppToken,
  makeGithubAppJwt,
  parseGithubAppPrivateKey,
  proxyForHost,
  runGithubAppSetup,
} from "./githubAppSetup.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const NOW = 1_700_000_000;

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

test("makeGithubAppJwt mints a verifiable RS256 JWT with the broker's claims", () => {
  const jwt = makeGithubAppJwt("5322759", privateKey, NOW);
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(decodeSegment(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeSegment(claims), { iss: "5322759", iat: NOW - 60, exp: NOW + 540 });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${claims}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
});

test("parseGithubAppPrivateKey rejects malformed input with a precise error", () => {
  assert.equal(parseGithubAppPrivateKey(PEM).type, "private");
  assert.throws(() => parseGithubAppPrivateKey("not a key at all"), /could not be parsed/);
  assert.throws(() => parseGithubAppPrivateKey("-----BEGIN PRIVATE KEY-----\ntruncated"), /could not be parsed/);
});

test("proxyForHost honors NO_PROXY and parses the egress proxy", () => {
  const env = { HTTPS_PROXY: "http://user:pass@127.0.0.1:18080" };
  assert.equal(proxyForHost(env, "api.github.com").port, "18080");
  assert.equal(proxyForHost({ ...env, NO_PROXY: "api.github.com" }, "api.github.com"), null);
  assert.equal(proxyForHost({}, "api.github.com"), null);
});

function setupDeps(dir, exchange) {
  return {
    configFile: join(dir, "cfg", "github-broker.json"),
    profileFile: join(dir, ".profile"),
    brokerCaFile: join(dir, "github-broker-ca.pem"),
    exchange,
    nowSeconds: NOW,
  };
}

test("runGithubAppSetup writes the app credential only after a successful exchange", async () => {
  const dir = mkdtempSync(join(tmpdir(), "github-app-setup-"));
  try {
    writeFileSync(join(dir, ".profile"), "export FOO=1\n");
    let seenJwt = null;
    const deps = setupDeps(dir, async (jwt) => {
      seenJwt = jwt;
      return { status: 201, json: { token: "installation-token" } };
    });
    const result = await runGithubAppSetup("5322759", "171529589", PEM, deps);
    assert.deepEqual(result, { ok: true, error: null });
    assert.equal(seenJwt.split(".").length, 3);

    const config = JSON.parse(readFileSync(deps.configFile, "utf8"));
    assert.deepEqual(config, {
      mode: "app",
      app_id: "5322759",
      installation_id: "171529589",
      private_key_path: join(dir, "cfg", "github-app-key.pem"),
    });
    assert.equal(readFileSync(config.private_key_path, "utf8"), `${PEM.trim()}\n`);
    assert.equal(statSync(deps.configFile).mode & 0o777, 0o600);
    assert.equal(statSync(config.private_key_path).mode & 0o777, 0o600);

    // The profile CA pin is idempotent across repeat setups.
    await runGithubAppSetup("5322759", "171529589", PEM, deps);
    const profile = readFileSync(deps.profileFile, "utf8");
    assert.equal(profile.match(/muse-code-space github broker >>>/g).length, 1);
    assert.match(profile, /export FOO=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGithubAppSetup writes nothing when GitHub rejects the credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "github-app-setup-"));
  try {
    const deps = setupDeps(dir, async () => ({ status: 404, json: { message: "Not Found" } }));
    const result = await runGithubAppSetup("5322759", "171529589", PEM, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 404/);
    assert.match(result.error, /Not Found/);
    assert.match(result.error, /nothing written/);
    assert.equal(existsSync(deps.configFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGithubAppSetup fails fast on a bad key and on a tokenless response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "github-app-setup-"));
  try {
    let exchangeCalled = false;
    const deps = setupDeps(dir, async () => {
      exchangeCalled = true;
      return { status: 201, json: {} };
    });
    const badKey = await runGithubAppSetup("1", "2", "-----BEGIN PRIVATE KEY-----\ngarbage", deps);
    assert.equal(badKey.ok, false);
    assert.match(badKey.error, /could not be parsed/);
    assert.equal(exchangeCalled, false);

    const noToken = await runGithubAppSetup("1", "2", PEM, deps);
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /no installation token/);
    assert.equal(existsSync(deps.configFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("exchangeGithubAppToken posts the JWT to the installation endpoint", async () => {
  let seen = null;
  await withServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization, accept: req.headers.accept };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "tok", expires_at: "2030-01-01T00:00:00Z" }));
  }, async (port) => {
    const result = await exchangeGithubAppToken("header.claims.sig", "67890", {
      env: {}, apiHost: "127.0.0.1", apiPort: port, secure: false,
    });
    assert.equal(result.status, 201);
    assert.equal(result.json.token, "tok");
    assert.equal(seen.url, "/app/installations/67890/access_tokens");
    assert.equal(seen.authorization, "Bearer header.claims.sig");
    assert.equal(seen.accept, "application/vnd.github+json");
  });
});

test("exchangeGithubAppToken retries connect-stage failures but never HTTP answers", async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests += 1;
    if (requests === 1) return req.socket.destroy();
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "tok" }));
  }, async (port) => {
    const result = await exchangeGithubAppToken("h.c.s", "1", {
      env: {}, apiHost: "127.0.0.1", apiPort: port, secure: false, sleep: async () => {}, backoffMs: [1],
    });
    assert.equal(result.status, 201);
    assert.equal(requests, 2);
  });

  let rejected = 0;
  await withServer((req, res) => {
    rejected += 1;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  }, async (port) => {
    const result = await exchangeGithubAppToken("h.c.s", "1", {
      env: {}, apiHost: "127.0.0.1", apiPort: port, secure: false, sleep: async () => {}, backoffMs: [1],
    });
    assert.equal(result.status, 404);
    assert.equal(rejected, 1);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");

test("VM installer deploys the file viewer dependency while preserving pilot state", () => {
  assert.ok(source.includes("pilot.mjs terminals.mjs files.mjs mcp.mjs"));
  assert.ok(source.includes('mkdir -p "$RUNTIME/state"'));
  assert.ok(source.includes('RUNTIME="${HOME}/workspace/muse-code-space-pilot"'));
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "muse-code-space-pilot");
  assert.equal(lock.name, pkg.name);
  assert.ok(source.includes('SETTINGS="${HOME}/.config/muse-code-space-pilot/muse/settings.json"'));
  assert.ok(source.includes('MUSE_CODE_SPACE_PILOT_DIR=$RUNTIME') && source.includes('MUSE_CODE_SPACE_RELAY_PORT=$RELAY_PORT'));
  assert.ok(source.includes('chmod 600 "$RUNTIME/proxy.env"'), "captured proxy credentials remain private to the service user");
  assert.ok(!source.includes('rm -rf "$RUNTIME/state"'));
  assert.ok(source.indexOf('systemctl restart muse-code-space-relay.service') < source.indexOf('systemctl restart muse-code-space-pilot.service'), "installer reloads the project relay before its pilot");
  assert.ok(source.includes('check_port_owner "$RELAY_PORT" muse-code-space-relay.service') && source.includes('check_port_owner "$PILOT_PORT" muse-code-space-pilot.service'), "installer refuses ports held by another project");
  const watchdogText = readFileSync(new URL("./watchdog.sh", import.meta.url), "utf8");
  assert.ok(watchdogText.includes("muse-code-space-github-broker.service") && watchdogText.includes("broker_healthy"), "watchdog recovers the broker like relay/pilot");
  const watchdog = watchdogText;
  assert.ok(watchdog.includes('/__code_space/health'), "watchdog uses local relay liveness rather than forwarding probes upstream");
  assert.ok(watchdog.includes('MUSE_CODE_SPACE_PILOT_DIR') && watchdog.includes('muse-code-space-relay.service'));
  const pilotUnit = readFileSync(new URL('./systemd/muse-code-space-pilot.service', import.meta.url), 'utf8');
  const relayUnit = readFileSync(new URL('./systemd/muse-code-space-relay.service', import.meta.url), 'utf8');
  assert.ok(pilotUnit.includes('Wants=muse-code-space-relay.service') && pilotUnit.includes('MUSE_CODE_SPACE_PILOT_STATE_DIR=@PILOT_DIR@/state'));
  assert.ok(pilotUnit.includes('EnvironmentFile=-@PILOT_DIR@/proxy.env'), "pilot unit loads the captured proxy env so muse serve sessions inherit it");
  assert.ok(relayUnit.includes('MUSE_CODE_SPACE_RELAY_PORT=@RELAY_PORT@'));
  for (const template of [pilotUnit, relayUnit]) {
    const rendered = template.replaceAll('@PILOT_DIR@', '/home/test/workspace/muse-code-space-pilot')
      .replaceAll('@PILOT_USER@', 'test').replaceAll('@PILOT_HOME@', '/home/test')
      .replaceAll('@MUSE_BIN@', '/home/test/.local/bin/muse').replaceAll('@PILOT_PORT@', '18791')
      .replaceAll('@RELAY_PORT@', '18790');
    assert.doesNotMatch(rendered, /@[A-Z_]+@/, "all project unit placeholders render");
    assert.ok(rendered.includes('/home/test/workspace/muse-code-space-pilot'));
  }
  assert.ok(!watchdog.includes('pkill -f "muse_relay.py"'), "direct-start process matching is scoped to this runtime path");
  assert.ok(source.includes("github_broker.py"), "installer deploys the GitHub broker");
  assert.ok(source.includes("broker-provided-sentinel") && source.includes("insteadOf = https://github.com/"), "session gitconfig carries the rewrite and sentinel only");
  assert.ok(!source.includes('> "${HOME}/.gitconfig"') && !source.includes('>> "${HOME}/.gitconfig"'), "installer never writes the host gitconfig");
  const brokerUnit = readFileSync(new URL('./systemd/muse-code-space-github-broker.service', import.meta.url), 'utf8');
  assert.ok(brokerUnit.includes('EnvironmentFile=-@PILOT_DIR@/proxy.env') && brokerUnit.includes('MUSE_CODE_SPACE_GITHUB_BROKER_PORT=@BROKER_PORT@'));
  const renderedBroker = brokerUnit.replaceAll('@PILOT_DIR@', '/home/test/workspace/muse-code-space-pilot')
    .replaceAll('@PILOT_USER@', 'test').replaceAll('@PILOT_HOME@', '/home/test')
    .replaceAll('@BROKER_PORT@', '18792');
  assert.doesNotMatch(renderedBroker, /@[A-Z_]+@/, "broker unit placeholders render");
});

test("install generates broker session files and leaves ~/.gitconfig byte-identical", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcs-install-gh-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  // npm is only invoked to sync pilot deps; stub it (deps are irrelevant here).
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const hostGitconfig = "[user]\n\tname = Host User\n";
  writeFileSync(join(home, ".gitconfig"), hostGitconfig);
  const freePort = async () => {
    const s = createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return String(p);
  };
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`,
    MUSE_CODE_SPACE_RELAY_PORT: await freePort(), MUSE_CODE_SPACE_PILOT_PORT: await freePort(),
    MUSE_CODE_SPACE_GITHUB_BROKER_PORT: await freePort(), MUSE_CODE_SPACE_MUSE_BIN: "/bin/true" };
  const result = spawnSync("bash", [new URL("./install.sh", import.meta.url).pathname, "--no-enable", "--no-cron"],
    { env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const runtime = join(home, "workspace", "muse-code-space-pilot");
  const gitconfig = readFileSync(join(runtime, "gitconfig"), "utf8");
  assert.ok(gitconfig.includes("insteadOf = https://github.com/") && gitconfig.includes("broker-provided-sentinel"));
  assert.ok(!gitconfig.includes("ghp_") && !gitconfig.includes("github_pat_"), "no real token shape in the gitconfig");
  const hosts = readFileSync(join(runtime, "gh-config", "hosts.yml"), "utf8");
  assert.ok(hosts.includes("api_host: 127.0.0.1:") && hosts.includes("oauth_token: broker-provided-sentinel"));
  assert.ok(existsSync(join(runtime, "github-broker-cert.pem")) && existsSync(join(runtime, "github_broker.py")));
  assert.ok(existsSync(join(runtime, "setup_github_broker.py")) && existsSync(join(runtime, "setup-github-broker")), "setup script installed");
  assert.equal(readFileSync(join(home, ".gitconfig"), "utf8"), hostGitconfig, "host gitconfig untouched");
  // The generated gitconfig must actually parse and serve the sentinel.
  const genv = { ...process.env, GIT_CONFIG_GLOBAL: join(runtime, "gitconfig"), GIT_TERMINAL_PROMPT: "0" };
  const rewrite = spawnSync("git", ["config", "--get-regexp", "url\\..*\\.insteadof"], { env: genv, encoding: "utf8" });
  assert.equal(rewrite.status, 0, rewrite.stderr);
  assert.ok(rewrite.stdout.includes("https://github.com/"), rewrite.stdout);
  const brokerPort = /127\.0\.0\.1:(\d+)/.exec(gitconfig)[1];
  const cred = spawnSync("git", ["credential", "fill"], { env: genv, encoding: "utf8",
    input: `url=https://127.0.0.1:${brokerPort}/octo/hello.git\n\n` });
  assert.equal(cred.status, 0, cred.stderr);
  assert.match(cred.stdout, /username=x-access-token/);
  assert.match(cred.stdout, /password=broker-provided-sentinel/);
  // The rewrite must produce a valid broker URL (trailing slash matters):
  // with no broker listening, git must fail against 127.0.0.1:<port>/...
  const lsRemote = spawnSync("git", ["ls-remote", "https://github.com/octo/hello.git", "HEAD"],
    { env: { ...genv, https_proxy: "", HTTPS_PROXY: "", http_proxy: "", HTTP_PROXY: "" }, encoding: "utf8", timeout: 15000 });
  assert.notEqual(lsRemote.status, 0);
  assert.ok(lsRemote.stderr.includes(`127.0.0.1:${brokerPort}/octo/hello.git`), lsRemote.stderr);
});

test("fresh installer refuses another process's relay port before creating runtime state", async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  const home = mkdtempSync(join(tmpdir(), "mcs-installer-port-"));
  try {
    const result = spawnSync("bash", [new URL("./install.sh", import.meta.url).pathname, "--no-enable", "--no-cron"], {
      env: { ...process.env, HOME: home, MUSE_CODE_SPACE_RELAY_PORT: String(port), MUSE_CODE_SPACE_PILOT_PORT: "18791", MUSE_CODE_SPACE_MUSE_BIN: "/bin/true" },
      encoding: "utf8", timeout: 8000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /already in use/);
    assert.equal(existsSync(join(home, "workspace", "muse-code-space-pilot")), false, "preflight rejects before mutating state");
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

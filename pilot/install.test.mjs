import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
  const watchdog = readFileSync(new URL("./watchdog.sh", import.meta.url), "utf8");
  assert.ok(watchdog.includes('/__code_space/health'), "watchdog uses local relay liveness rather than forwarding probes upstream");
  assert.ok(watchdog.includes('MUSE_CODE_SPACE_PILOT_DIR') && watchdog.includes('muse-code-space-relay.service'));
  const pilotUnit = readFileSync(new URL('./systemd/muse-code-space-pilot.service', import.meta.url), 'utf8');
  const relayUnit = readFileSync(new URL('./systemd/muse-code-space-relay.service', import.meta.url), 'utf8');
  assert.ok(pilotUnit.includes('Wants=muse-code-space-relay.service') && pilotUnit.includes('MUSE_CODE_SPACE_PILOT_STATE_DIR=@PILOT_DIR@/state'));
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

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import museCodeSpaceExtension, {
  deriveAutomaticSummary,
  formatInboxPrompt,
  formatPublicWebUrl,
  formatStartupNotice,
  loadInboxCursor,
  resolveExtensionConfig,
  saveInboxCursor,
} from "./index.ts";

const extDir = path.dirname(fileURLToPath(import.meta.url));
const devServerSource = readFileSync(path.join(extDir, "../../dev/server.ts"), "utf8");
const rootPkg = JSON.parse(readFileSync(path.join(extDir, "../../package.json"), "utf8"));

test("package.json declares the Pi extension for pi install git:...", () => {
  assert.deepEqual(rootPkg.pi?.extensions, ["./extensions/muse-code-space/index.ts"]);
});

test("extension registers all muse_code_space_* tools and /code-space command", () => {
  const registeredTools = [];
  const registeredCommands = [];
  const registeredEvents = [];

  museCodeSpaceExtension({
    on(event) {
      registeredEvents.push(event);
      return () => {};
    },
    registerTool(tool) {
      registeredTools.push(tool.name);
    },
    registerCommand(name) {
      registeredCommands.push(name);
    },
    sendMessage() {},
  });

  assert.deepEqual(registeredTools, [
    "muse_code_space_status",
    "muse_code_space_list_tasks",
    "muse_code_space_read_task",
    "muse_code_space_send_message",
    "muse_code_space_start_task",
    "muse_code_space_update_task",
  ]);
  assert.ok(registeredTools.every((name) => name.startsWith("muse_code_space_")));
  assert.deepEqual(registeredCommands, ["code-space"]);
  assert.ok(registeredEvents.includes("session_start"));
  assert.ok(registeredEvents.includes("session_shutdown"));
});

test("resolveExtensionConfig mints a durable web token and formats http/https URLs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "code-space-ext-test-"));
  try {
    const cfg = resolveExtensionConfig({
      MUSE_CODE_SPACE_STATE_DIR: dir,
      MUSE_CODE_SPACE_PUBLIC_HOST: "workstation.example.com",
      MUSE_CODE_SPACE_PORT: "8443",
      MUSE_CODE_SPACE_ASSISTANT_NAME: "Jolly",
      MUSE_CODE_SPACE_USER_NAME: "Alex",
    });
    assert.ok(cfg.webToken.length >= 16, "auto-generates a web token");
    assert.equal(
      formatPublicWebUrl(cfg),
      `http://workstation.example.com:8443/?token=${encodeURIComponent(cfg.webToken)}`,
    );

    // Second load reuses the persisted token.
    const cfg2 = resolveExtensionConfig({
      MUSE_CODE_SPACE_STATE_DIR: dir,
      MUSE_CODE_SPACE_PUBLIC_HOST: "workstation.example.com",
      MUSE_CODE_SPACE_PORT: "8443",
    });
    assert.equal(cfg2.webToken, cfg.webToken);

    // With a TLS PEM file present, URL switches to https://
    const pemFile = path.join(dir, "cert.pem");
    writeFileSync(pemFile, "dummy");
    const cfgTls = resolveExtensionConfig({
      MUSE_CODE_SPACE_STATE_DIR: dir,
      MUSE_CODE_SPACE_PUBLIC_HOST: "workstation.example.com",
      MUSE_CODE_SPACE_PORT: "8443",
      MUSE_CODE_SPACE_TLS_PEM: pemFile,
    });
    assert.ok(formatPublicWebUrl(cfgTls).startsWith("https://workstation.example.com:8443/?token="));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inbox cursor persistence and message formatting work cleanly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "code-space-cursor-test-"));
  try {
    const cursorFile = path.join(dir, "inbox-cursor.json");
    assert.equal(loadInboxCursor(cursorFile), 0);
    saveInboxCursor(cursorFile, 12);
    assert.equal(loadInboxCursor(cursorFile), 12);

    const prompt = formatInboxPrompt({
      seq: 12,
      from: "Poppy",
      text: "Tests are green, ready for review.",
    });
    assert.ok(prompt.includes("Poppy"));
    assert.ok(prompt.includes("muse_code_space_send_message"));
    assert.equal(deriveAutomaticSummary("Fix mobile layout\nMore details"), "Fix mobile layout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatStartupNotice explains clearly when pilot or web server fails to start", () => {
  const ok = formatStartupNotice({
    pilotUp: true,
    webUp: true,
    webUrl: "http://host:4173/",
    pilotUrl: "http://127.0.0.1:18791",
    stateDir: "/tmp/state",
  });
  assert.equal(ok.level, "info");
  assert.equal(ok.message, "Muse Code Space ready: http://host:4173/");

  const pilotDown = formatStartupNotice({
    pilotUp: false,
    webUp: true,
    webUrl: "http://host:4173/",
    pilotUrl: "http://127.0.0.1:18791",
    stateDir: "/tmp/state",
    pilotError: "sandbox_apply: Operation not permitted",
  });
  assert.equal(pilotDown.level, "warning");
  assert.ok(pilotDown.message.includes("pilot failed to start (sandbox_apply: Operation not permitted)"));
  assert.ok(pilotDown.message.includes("/tmp/state/pilot.log"));
});

test("dev/server.ts supports optional TLS and token cookie authentication", () => {
  assert.ok(devServerSource.includes("MUSE_CODE_SPACE_TLS_PEM"));
  assert.ok(devServerSource.includes("MUSE_CODE_SPACE_WEB_TOKEN"));
  assert.ok(devServerSource.includes("muse_code_space_token"));
});

/**
 * Muse Code Space — Pi Extension
 *
 * Allows a Pi coding-agent session on a host to act as the Muse Assistant
 * for a local Muse Code Space instance while serving the Code Space Web UI
 * directly from that host.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface PiToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: TParams, ctx?: unknown) => Promise<PiToolResult>;
}

export interface PiCommandContext {
  hasUI?: boolean;
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export interface PiExtensionAPI {
  on: (event: string, handler: (event: unknown, ctx: PiCommandContext) => unknown) => () => void;
  registerTool: <TParams = Record<string, unknown>>(tool: PiToolDefinition<TParams>) => void;
  registerCommand: (
    name: string,
    spec: {
      description: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void> | void;
    },
  ) => void;
  sendMessage: (
    message: { customType: string; content: string; display?: boolean },
    options?: { triggerTurn?: boolean },
  ) => void;
}

export type CodeSpaceExtensionConfig = {
  repoRoot: string;
  stateDir: string;
  pilotUrl: string;
  pilotPort: number;
  webHost: string;
  webPort: number;
  publicHost: string;
  tlsPem: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
  webToken: string;
  assistantName: string;
  assistantColor: string | null;
  assistantAvatarPath: string | null;
  profilePath: string | null;
  userName: string | null;
  autoStart: boolean;
};

const BUILTIN_COMPANIONS: Record<string, { id: string; name: string }> = {
  poppy: { id: "poppy", name: "Poppy" },
  remy: { id: "remy", name: "Remy" },
  tilly: { id: "tilly", name: "Tilly" },
  nova: { id: "nova", name: "Nova" },
  sage: { id: "sage", name: "Sage" },
};

function chooseWritableStateDir(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  repoRoot: string,
): string {
  const candidates = [
    env.MUSE_CODE_SPACE_STATE_DIR?.trim(),
    path.join(homeDir, ".local", "share", "muse-code-space"),
    path.join(repoRoot, ".dev", "code-space-ext"),
    path.join(os.tmpdir(), "muse-code-space"),
  ].filter((c): c is string => Boolean(c));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const probe = path.join(dir, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, "ok", { mode: 0o600 });
      fs.unlinkSync(probe);
      return dir;
    } catch {
      // Try next candidate if sandboxed.
    }
  }
  return candidates[0]!;
}

export function resolveExtensionConfig(env: NodeJS.ProcessEnv = process.env): CodeSpaceExtensionConfig {
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = env.MUSE_CODE_SPACE_ROOT?.trim() || path.resolve(extDir, "../..");
  const homeDir = env.HOME?.trim() || os.homedir();
  const stateDir = chooseWritableStateDir(env, homeDir, repoRoot);

  const pilotPort = Number(env.MUSE_CODE_SPACE_PILOT_PORT ?? 18791);
  const pilotUrl = (env.MUSE_CODE_SPACE_PILOT_URL?.trim() || `http://127.0.0.1:${pilotPort}`).replace(/\/+$/, "");
  const webPort = Number(env.MUSE_CODE_SPACE_PORT ?? env.MUSE_CODE_SPACE_DEV_PORT ?? 4173);
  const webHost = env.MUSE_CODE_SPACE_HOST?.trim() || env.MUSE_CODE_SPACE_DEV_HOST?.trim() || "::";
  const publicHost = env.MUSE_CODE_SPACE_PUBLIC_HOST?.trim() || os.hostname() || "127.0.0.1";

  const tlsPem = env.MUSE_CODE_SPACE_TLS_PEM?.trim() || null;
  const tlsCert = env.MUSE_CODE_SPACE_TLS_CERT?.trim() || tlsPem;
  const tlsKey = env.MUSE_CODE_SPACE_TLS_KEY?.trim() || tlsPem;

  const tokenFile = path.join(stateDir, "web-token");
  let webToken = "";
  if (env.MUSE_CODE_SPACE_WEB_TOKEN !== undefined) {
    webToken = env.MUSE_CODE_SPACE_WEB_TOKEN.trim();
  } else {
    try {
      webToken = fs.readFileSync(tokenFile, "utf8").trim();
    } catch {
      webToken = "";
    }
    if (!webToken) {
      webToken = crypto.randomBytes(24).toString("base64url");
      try {
        fs.writeFileSync(tokenFile, `${webToken}\n`, { mode: 0o600 });
      } catch {
        // Ignore write error on read-only filesystems.
      }
    }
  }

  const assistantName = env.MUSE_CODE_SPACE_ASSISTANT_NAME?.trim() || "Jolly";
  const assistantColor = env.MUSE_CODE_SPACE_ASSISTANT_COLOR?.trim() || null;
  const assistantAvatarPath = env.MUSE_CODE_SPACE_ASSISTANT_AVATAR?.trim() || null;
  const profilePath = env.MUSE_CODE_SPACE_ASSISTANT_PROFILE?.trim() || null;
  const rawUser = env.MUSE_CODE_SPACE_USER_NAME?.trim() || env.USER?.trim() || os.userInfo().username || null;
  const userName = rawUser ? rawUser.slice(0, 40) : null;
  const autoStart = env.MUSE_CODE_SPACE_AUTO_START === "true" || env.MUSE_CODE_SPACE_AUTO_START === "1";

  return {
    repoRoot,
    stateDir,
    pilotUrl,
    pilotPort,
    webHost,
    webPort,
    publicHost,
    tlsPem,
    tlsCert,
    tlsKey,
    webToken,
    assistantName,
    assistantColor,
    assistantAvatarPath,
    profilePath,
    userName,
    autoStart,
  };
}

export function encodeAvatarFileToDataUrl(filePath: string): string {
  const resolved = path.resolve(filePath);
  const bytes = fs.readFileSync(resolved);
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) {
    throw new Error("Avatar image must be non-empty and at most 256 KiB.");
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : null;
  if (!mime) {
    throw new Error("Avatar image must be a .png, .jpg/.jpeg, or .webp file.");
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function buildIdentityPayloadFromConfig(cfg: CodeSpaceExtensionConfig): {
  name?: string;
  color?: string;
  avatar_data_url?: string | null;
  user_name?: string | null;
} {
  if (cfg.profilePath && fs.existsSync(cfg.profilePath)) {
    const raw = JSON.parse(fs.readFileSync(cfg.profilePath, "utf8")) as {
      name?: string;
      color?: string;
      avatar_path?: string | null;
      avatar_data_url?: string | null;
      user_name?: string | null;
    };
    let avatarDataUrl: string | null | undefined = raw.avatar_data_url;
    if (raw.avatar_path !== undefined) {
      avatarDataUrl =
        raw.avatar_path === null
          ? null
          : encodeAvatarFileToDataUrl(path.resolve(path.dirname(cfg.profilePath), raw.avatar_path));
    }
    return {
      ...(raw.name?.trim() ? { name: raw.name.trim() } : { name: cfg.assistantName }),
      ...(raw.color?.trim() ? { color: raw.color.trim() } : {}),
      ...(avatarDataUrl !== undefined ? { avatar_data_url: avatarDataUrl } : {}),
      ...(raw.user_name !== undefined ? { user_name: raw.user_name } : cfg.userName ? { user_name: cfg.userName } : {}),
    };
  }
  return {
    name: cfg.assistantName,
    ...(cfg.assistantColor ? { color: cfg.assistantColor } : {}),
    ...(cfg.assistantAvatarPath ? { avatar_data_url: encodeAvatarFileToDataUrl(cfg.assistantAvatarPath) } : {}),
    ...(cfg.userName ? { user_name: cfg.userName } : {}),
  };
}

export function formatPublicWebUrl(cfg: CodeSpaceExtensionConfig): string {
  const hasTls = Boolean(cfg.tlsCert && cfg.tlsKey && fs.existsSync(cfg.tlsCert) && fs.existsSync(cfg.tlsKey));
  const scheme = hasTls ? "https" : "http";
  const base = `${scheme}://${cfg.publicHost}:${cfg.webPort}/`;
  return cfg.webToken ? `${base}?token=${encodeURIComponent(cfg.webToken)}` : base;
}

export function formatLocalActionUrl(cfg: CodeSpaceExtensionConfig): string {
  const hasTls = Boolean(cfg.tlsCert && cfg.tlsKey && fs.existsSync(cfg.tlsCert) && fs.existsSync(cfg.tlsKey));
  const scheme = hasTls ? "https" : "http";
  return `${scheme}://127.0.0.1:${cfg.webPort}/actions`;
}

export async function invokeCodeSpaceAction<T = unknown>(
  cfg: CodeSpaceExtensionConfig,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const url = formatLocalActionUrl(cfg);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.webToken ? { authorization: `Bearer ${cfg.webToken}` } : {}),
    },
    body: JSON.stringify({
      action,
      args,
      actionCallId: `pi-ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { data?: T; error?: unknown };
  if (!res.ok || body.error) {
    throw new Error(typeof body.error === "string" ? body.error : `Action ${action} failed (${res.status})`);
  }
  return body.data as T;
}

export function loadInboxCursor(cursorFile: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorFile, "utf8")) as { cursor?: unknown };
    return typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor) ? parsed.cursor : 0;
  } catch {
    return 0;
  }
}

export function parseEnvFileText(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2) ||
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function parseInlineEnvTokens(tokens: readonly string[]): Record<string, string | null> {
  const updates: Record<string, string | null> = {};
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = token.slice(eq + 1).trim();
    if (
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2) ||
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    updates[key] = val === "" ? null : val;
  }
  return updates;
}

export function loadPersistedPilotEnv(stateDir: string, homeDir = os.homedir()): Record<string, string> {
  const merged: Record<string, string> = {};
  const candidates = [
    path.join(homeDir, ".config", "muse-code-space", "env"),
    path.join(stateDir, "pilot.env"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        Object.assign(merged, parseEnvFileText(fs.readFileSync(file, "utf8")));
      }
    } catch {
      // ignore unreadable env files
    }
  }
  return merged;
}

export function updatePersistedPilotEnv(
  stateDir: string,
  updates: Record<string, string | null>,
): Record<string, string> {
  const envFile = path.join(stateDir, "pilot.env");
  let current: Record<string, string> = {};
  try {
    if (fs.existsSync(envFile)) {
      current = parseEnvFileText(fs.readFileSync(envFile, "utf8"));
    }
  } catch {
    current = {};
  }
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) {
      delete current[k];
    } else {
      current[k] = v;
    }
  }
  const lines = Object.entries(current).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  try {
    fs.writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  } catch {
    // ignore write failures
  }
  return current;
}

export function saveInboxCursor(cursorFile: string, cursor: number): void {
  try {
    const tmp = `${cursorFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, cursorFile);
  } catch {
    // Ignore cursor write errors.
  }
}

export function formatInboxPrompt(msg: {
  seq: number;
  from: string;
  text: string;
}): string {
  return [
    `[Muse Code Space message #${msg.seq} from ${msg.from}]`,
    msg.text.trim(),
    "",
    `Reply to ${msg.from} with the \`muse_code_space_send_message\` tool (to: "${msg.from}").`,
  ].join("\n");
}

export function formatSummaryRequestPrompt(session: {
  id: string;
  title: string;
  prompt: string;
  latest_output?: string | null;
}): string {
  const lines = [
    `[Muse Code Space — Task summary needed for ${session.title} (task_id: "${session.id}")]`,
    `Initial prompt: ${session.prompt.trim().slice(0, 600)}`,
  ];
  if (session.latest_output?.trim()) {
    lines.push(`Latest progress: ${session.latest_output.trim().slice(0, 600)}`);
  }
  lines.push(
    "",
    `Write a concise summary (at most 100 characters, never a status like "Thinking") describing the requested work and progress, and save it using \`muse_code_space_update_task\` with \`task_id: "${session.id}"\` and \`summary\`.`,
  );
  return lines.join("\n");
}

export function readLastLogError(logPath: string): string | null {
  try {
    if (!fs.existsSync(logPath)) return null;
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("at "));
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
      const line = lines[i]!;
      if (/error|failed|not permitted|refused|exception/i.test(line)) {
        return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "").slice(0, 180);
      }
    }
    return lines.at(-1)?.slice(0, 180) ?? null;
  } catch {
    return null;
  }
}

export function formatStartupNotice(status: {
  pilotUp: boolean;
  webUp: boolean;
  webUrl: string;
  pilotUrl: string;
  stateDir: string;
  pilotError?: string | null;
  webError?: string | null;
}): { message: string; level: "info" | "warning" | "error" } {
  if (status.webUp && status.pilotUp) {
    return {
      level: "info",
      message: `Muse Code Space ready: ${status.webUrl}`,
    };
  }
  if (status.webUp && !status.pilotUp) {
    const reason = status.pilotError || `unreachable at ${status.pilotUrl}`;
    return {
      level: "warning",
      message: `Muse Code Space: pilot failed to start (${reason}). Web UI is up at ${status.webUrl} — see ${path.join(status.stateDir, "pilot.log")}`,
    };
  }
  if (!status.webUp && status.pilotUp) {
    const reason = status.webError || "web server unreachable";
    return {
      level: "error",
      message: `Muse Code Space: web server failed to start (${reason}) — see ${path.join(status.stateDir, "web.log")}`,
    };
  }
  const pilotReason = status.pilotError || "down";
  const webReason = status.webError || "down";
  return {
    level: "error",
    message: `Muse Code Space failed to start — pilot: ${pilotReason}; web: ${webReason} (logs in ${status.stateDir})`,
  };
}

export function resolveBunRuntime(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): { command: string; env: Record<string, string> } {
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const homeDir = env.HOME?.trim() || os.homedir();
  const candidates = [
    env.BUN_BIN?.trim(),
    ...pathDirs.map((dir) => path.join(dir, "bun")),
    path.join(homeDir, ".bun", "bin", "bun"),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { command: candidate, env: {} };
    } catch {
      // try next candidate
    }
  }

  // Prefer the unwrapped `.real` binary when Pi is installed behind a wrapper
  // binary (`<dir>/pi` -> `<dir>/pi.real`), because the wrapper injects CLI
  // flags (`--extension ...`) that would otherwise be passed to Bun.
  const resolvedExec = (() => {
    try {
      return fs.realpathSync(execPath);
    } catch {
      return execPath;
    }
  })();

  const realCandidates = [
    `${resolvedExec}.real`,
    `${execPath}.real`,
    ...pathDirs.map((dir) => {
      const piPath = path.join(dir, "pi");
      try {
        return `${fs.realpathSync(piPath)}.real`;
      } catch {
        return `${piPath}.real`;
      }
    }),
  ];

  for (const realBin of realCandidates) {
    try {
      fs.accessSync(realBin, fs.constants.X_OK);
      return { command: realBin, env: { BUN_BE_BUN: "1" } };
    } catch {
      // try next candidate
    }
  }

  return { command: resolvedExec, env: { BUN_BE_BUN: "1" } };
}

function findExecutableInPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

export function resolvePilotJsRuntime(
  bunRuntime: { command: string; env: Record<string, string> },
  env: NodeJS.ProcessEnv = process.env,
): { command: string; env: Record<string, string> } {
  const nodeBin = findExecutableInPath("node", env);
  if (nodeBin) {
    try {
      const check = spawnSync(
        nodeBin,
        ["-e", "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"],
        { timeout: 2000, stdio: "ignore" },
      );
      if (check.status === 0) {
        return { command: nodeBin, env: {} };
      }
    } catch {
      // fall back to bunRuntime
    }
  }
  return bunRuntime;
}

function runBunInstall(
  cwd: string,
  bunRuntime: { command: string; env: Record<string, string> },
  customEnv: Record<string, string>,
  logFd: number,
): void {
  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    ...customEnv,
    ...bunRuntime.env,
  };
  const first = spawnSync(bunRuntime.command, ["install"], {
    cwd,
    env: baseEnv as NodeJS.ProcessEnv,
    stdio: ["ignore", logFd, logFd],
  });
  if (first.status === 0) return;

  // If an outer launcher set a loopback-only HTTP(S)_PROXY that blocks package
  // registries (403) and the user did not explicitly set a proxy in customEnv,
  // retry without the loopback proxy variables (and via `with-proxy` if present).
  const proxyVal = baseEnv.HTTPS_PROXY || baseEnv.https_proxy || baseEnv.HTTP_PROXY || baseEnv.http_proxy || "";
  const hasCustomProxy = Boolean(
    customEnv.HTTPS_PROXY || customEnv.https_proxy || customEnv.HTTP_PROXY || customEnv.http_proxy,
  );
  if (!hasCustomProxy && /(?:localhost|127\.0\.0\.1)/i.test(proxyVal)) {
    const cleanEnv = { ...baseEnv };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
      delete cleanEnv[k];
    }
    const withProxyBin = findExecutableInPath("with-proxy", process.env);
    if (withProxyBin) {
      const viaWrapper = spawnSync(withProxyBin, [bunRuntime.command, "install"], {
        cwd,
        env: cleanEnv as NodeJS.ProcessEnv,
        stdio: ["ignore", logFd, logFd],
      });
      if (viaWrapper.status === 0) return;
    }
    spawnSync(bunRuntime.command, ["install"], {
      cwd,
      env: cleanEnv as NodeJS.ProcessEnv,
      stdio: ["ignore", logFd, logFd],
    });
  }
}

function buildFallbackSpaceSdkTarball(stateDir: string): string {
  const tgzPath = path.join(stateDir, "space-sdk-fallback-v2.tgz");
  if (fs.existsSync(tgzPath)) return tgzPath;
  const pkgRoot = path.join(stateDir, "space-sdk-fallback-v2");
  const distDir = path.join(pkgRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(
    path.join(pkgRoot, "package.json"),
    JSON.stringify(
      {
        name: "@hatch/space-sdk",
        version: "0.14.0",
        type: "module",
        exports: {
          ".": "./dist/index.js",
          "./client": "./dist/client.js",
          "./styles.css": "./styles.css",
        },
        dependencies: {
          "bun-plugin-tailwind": "0.0.15",
          zod: "4.4.3",
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(pkgRoot, "styles.css"),
    [
      ":root {",
      "  color-scheme: light dark;",
      "  --twsa-safe-area-inset-top: env(safe-area-inset-top, 0px);",
      "  --twsa-safe-area-inset-right: env(safe-area-inset-right, 0px);",
      "  --twsa-safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);",
      "  --twsa-safe-area-inset-left: env(safe-area-inset-left, 0px);",
      "}",
      "html, [data-generated-space-root] { height: 100%; min-height: 100%; }",
      "[data-generated-space-root] { inset: 0; overflow: auto; position: fixed; scrollbar-width: none; }",
      ".hatch-space-root[data-hatch-space-root] {",
      "  --hatch-space-bottom-padding: calc(var(--bottom-padding, 0px) + env(safe-area-inset-bottom, 0px));",
      "  box-sizing: border-box;",
      "  min-height: calc(100dvh + var(--header-height, 0px) + var(--hatch-space-bottom-padding));",
      "  padding-top: var(--header-height, 0px);",
      "  padding-bottom: var(--hatch-space-bottom-padding);",
      "}",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(distDir, "index.js"),
    [
      'import { z } from "zod";',
      "export { z };",
      'export const ACTION_BRAND = "@hatch/space-sdk/action/v1";',
      'export const PRIVILEGED_CONTRACT_BRAND = "@hatch/space-sdk/privileged-contract/v1";',
      'export const PRIVILEGED_HANDLERS_FORMAT = "hatch-space-privileged-handlers-v1";',
      "export function defineAction(spec) { return { ...spec, __brand: ACTION_BRAND }; }",
      'export function isAction(v) { return Boolean(v && typeof v === "object" && "handler" in v && "request" in v); }',
      "export function definePrivilegedContracts(specs) {",
      "  const out = {};",
      "  for (const [name, spec] of Object.entries(specs)) out[name] = { __brand: PRIVILEGED_CONTRACT_BRAND, name, ...spec };",
      "  return out;",
      "}",
      "export function definePrivilegedHandlers(contracts, handlers) {",
      "  const entries = [];",
      "  for (const [name, handler] of Object.entries(handlers)) {",
      "    if (handler && contracts[name]) entries.push({ contract: contracts[name], handler });",
      "  }",
      "  return { format: PRIVILEGED_HANDLERS_FORMAT, entries };",
      "}",
      'export function isPrivilegedHandlers(v) { return Boolean(v && typeof v === "object" && v.format === PRIVILEGED_HANDLERS_FORMAT); }',
      "export function createPrivilegedExecutor(transport) {",
      "  return { executePrivileged(contract, args) { return transport(contract, args); } };",
      "}",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(distDir, "client.js"),
    [
      'import "../styles.css";',
      'import { createElement } from "react";',
      'import { QueryClient } from "@tanstack/react-query";',
      "export const spaceQueryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } });",
      "export function SafeAreaTopScrim({ variant = 'gradient', backgroundColor = 'var(--bg)', zIndex = 40, className, style, ...props }) {",
      "  return createElement('div', { ...props, 'aria-hidden': true, className, style: { ...style, position: 'fixed', top: 0, left: 0, right: 0, zIndex, pointerEvents: 'none', height: 'var(--twsa-safe-area-inset-top)', backgroundColor } });",
      "}",
      "export function bytesToBase64(bytes) {",
      "  let bin = '';",
      "  const chunk = 0x8000;",
      "  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));",
      "  return btoa(bin);",
      "}",
      "export async function fileToBase64(file) {",
      "  const buf = new Uint8Array(await file.arrayBuffer());",
      "  return { dataBase64: bytesToBase64(buf), mimeType: file.type || 'application/octet-stream', filename: file.name, sizeBytes: file.size };",
      "}",
      "export function createActionClient(options = {}) {",
      "  const endpoint = options.endpoint ?? './actions';",
      "  const fetchImpl = options.fetch ?? globalThis.fetch;",
      "  return new Proxy({}, {",
      "    get(_t, name) {",
      "      if (typeof name !== 'string' || name === 'then' || name === 'catch' || name === 'finally') return undefined;",
      "      return async (args) => {",
      "        const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, args: args ?? {} }) });",
      "        const body = await res.json();",
      "        if (!res.ok || (body && body.error)) throw new Error(String(body?.error ?? res.status));",
      "        return body.data;",
      "      };",
      "    }",
      "  });",
      "}",
    ].join("\n"),
  );

  spawnSync("tar", ["-czf", tgzPath, "-C", pkgRoot, "."], { stdio: "ignore" });
  return tgzPath;
}

function ensureRepoDependencies(
  repoRoot: string,
  stateDir: string,
  bunRuntime: { command: string; env: Record<string, string> },
  customEnv: Record<string, string>,
  logFd: number,
): void {
  const sdkModuleDir = path.join(repoRoot, "node_modules", "@hatch", "space-sdk");
  const reactModuleDir = path.join(repoRoot, "node_modules", "react");
  const tailwindPluginDir = path.join(repoRoot, "node_modules", "bun-plugin-tailwind");
  if (fs.existsSync(sdkModuleDir) && fs.existsSync(reactModuleDir) && fs.existsSync(tailwindPluginDir)) return;

  const pkgJsonPath = path.join(repoRoot, "package.json");
  const bunLockPath = path.join(repoRoot, "bun.lock");
  if (!fs.existsSync(pkgJsonPath)) return;

  const origPkg = fs.readFileSync(pkgJsonPath, "utf8");
  const origLock = fs.existsSync(bunLockPath) ? fs.readFileSync(bunLockPath, "utf8") : null;
  const hatchTgz = "/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz";
  const needsFallbackSdk = !fs.existsSync(hatchTgz);

  try {
    if (needsFallbackSdk) {
      const fallbackTgz = buildFallbackSpaceSdkTarball(stateDir);
      const patchedPkg = origPkg.replaceAll(`file:${hatchTgz}`, `file:${fallbackTgz}`);
      fs.writeFileSync(pkgJsonPath, patchedPkg);
      if (origLock !== null) {
        const patchedLock = origLock.replaceAll(`file:${hatchTgz}`, `file:${fallbackTgz}`);
        fs.writeFileSync(bunLockPath, patchedLock);
      }
    }
    runBunInstall(repoRoot, bunRuntime, customEnv, logFd);
  } finally {
    if (needsFallbackSdk) {
      try {
        fs.writeFileSync(pkgJsonPath, origPkg);
        if (origLock !== null) fs.writeFileSync(bunLockPath, origLock);
      } catch {
        // ignore restore error
      }
    }
  }
}

async function isHttpReachable(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function museCodeSpaceExtension(pi: PiExtensionAPI) {
  const cfg = resolveExtensionConfig();
  const cursorFile = path.join(cfg.stateDir, "inbox-cursor.json");
  let spawnedPilot: ChildProcess | null = null;
  let spawnedWeb: ChildProcess | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let identitySynced = false;
  const requestedSummaries = new Map<string, number>();

  const checkServicesRunning = async (): Promise<{ pilotUp: boolean; webUp: boolean }> => {
    const pilotUp = await isHttpReachable(`${cfg.pilotUrl}/health`);
    const webCheckUrl = formatLocalActionUrl(cfg).replace(/\/actions$/, "/");
    const authHeaders = cfg.webToken ? { authorization: `Bearer ${cfg.webToken}` } : undefined;
    const webUp = await isHttpReachable(webCheckUrl, authHeaders);
    return { pilotUp, webUp };
  };

  const ensureServicesRunning = async (forceStart = false): Promise<{ pilotUp: boolean; webUp: boolean }> => {
    const shouldStart = forceStart || cfg.autoStart;
    const customEnv = loadPersistedPilotEnv(cfg.stateDir);
    const bunRuntime = resolveBunRuntime(process.env);
    let pilotUp = await isHttpReachable(`${cfg.pilotUrl}/health`);
    if (!pilotUp && shouldStart) {
      const pilotDir = path.join(cfg.repoRoot, "pilot");
      const pilotScript = path.join(pilotDir, "pilot.mjs");
      if (fs.existsSync(pilotScript)) {
        const pilotStateDir = path.join(cfg.stateDir, "pilot-state");
        fs.mkdirSync(pilotStateDir, { recursive: true, mode: 0o700 });
        const logPath = path.join(cfg.stateDir, "pilot.log");
        const logFd = fs.openSync(logPath, "w");
        const sdkDir = path.join(pilotDir, "node_modules", "@muse-code", "sdk");
        if (!fs.existsSync(sdkDir)) {
          runBunInstall(pilotDir, bunRuntime, customEnv, logFd);
        }
        const pilotRuntime = resolvePilotJsRuntime(bunRuntime, process.env);
        try {
          spawnedPilot = spawn(pilotRuntime.command, [pilotScript], {
            cwd: cfg.repoRoot,
            env: {
              ...process.env,
              ...customEnv,
              ...pilotRuntime.env,
              MUSE_CODE_SPACE_PILOT_PORT: String(cfg.pilotPort),
              MUSE_CODE_SPACE_RELAY_URL: customEnv.MUSE_CODE_SPACE_RELAY_URL ?? process.env.MUSE_CODE_SPACE_RELAY_URL ?? "none",
              MUSE_CODE_SPACE_PILOT_STATE_DIR: pilotStateDir,
              ...(cfg.userName ? { MUSE_CODE_SPACE_USER_NAME: cfg.userName } : {}),
            },
            stdio: ["ignore", logFd, logFd],
            detached: true,
          });
          spawnedPilot.on("error", (err) => {
            try {
              fs.appendFileSync(logPath, `spawn error: ${err.message}\n`);
            } catch {}
          });
          spawnedPilot.unref();
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 300));
            pilotUp = await isHttpReachable(`${cfg.pilotUrl}/health`);
            if (pilotUp) break;
          }
        } catch (err) {
          try {
            fs.appendFileSync(logPath, `spawn error: ${err instanceof Error ? err.message : String(err)}\n`);
          } catch {}
        }
      }
    }

    const webCheckUrl = formatLocalActionUrl(cfg).replace(/\/actions$/, "/");
    const authHeaders = cfg.webToken ? { authorization: `Bearer ${cfg.webToken}` } : undefined;
    let webUp = await isHttpReachable(webCheckUrl, authHeaders);
    if (!webUp && shouldStart) {
      const serverScript = path.join(cfg.repoRoot, "dev", "server.ts");
      if (fs.existsSync(serverScript)) {
        const webDir = path.join(cfg.stateDir, "web-build");
        const dbPath = path.join(cfg.stateDir, "app.db");
        fs.mkdirSync(webDir, { recursive: true, mode: 0o700 });
        const logPath = path.join(cfg.stateDir, "web.log");
        const logFd = fs.openSync(logPath, "w");
        ensureRepoDependencies(cfg.repoRoot, cfg.stateDir, bunRuntime, customEnv, logFd);
        try {
          spawnedWeb = spawn(bunRuntime.command, [serverScript], {
            cwd: cfg.repoRoot,
            env: {
              ...process.env,
              ...customEnv,
              ...bunRuntime.env,
              MUSE_CODE_SPACE_PILOT_URL: cfg.pilotUrl,
              MUSE_CODE_SPACE_DEV_HOST: cfg.webHost,
              MUSE_CODE_SPACE_DEV_PORT: String(cfg.webPort),
              MUSE_CODE_SPACE_DEV_DIR: webDir,
              MUSE_CODE_SPACE_DEV_DB: dbPath,
              MUSE_CODE_SPACE_WEB_TOKEN: cfg.webToken,
              ...(cfg.tlsCert ? { MUSE_CODE_SPACE_TLS_CERT: cfg.tlsCert } : {}),
              ...(cfg.tlsKey ? { MUSE_CODE_SPACE_TLS_KEY: cfg.tlsKey } : {}),
            },
            stdio: ["ignore", logFd, logFd],
            detached: true,
          });
          spawnedWeb.on("error", (err) => {
            try {
              fs.appendFileSync(logPath, `spawn error: ${err.message}\n`);
            } catch {}
          });
          spawnedWeb.unref();
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 350));
            webUp = await isHttpReachable(webCheckUrl, authHeaders);
            if (webUp) break;
          }
        } catch (err) {
          try {
            fs.appendFileSync(logPath, `spawn error: ${err instanceof Error ? err.message : String(err)}\n`);
          } catch {}
        }
      }
    }

    return { pilotUp, webUp };
  };

  const syncModelsFromPilot = async (): Promise<void> => {
    try {
      const res = await fetch(`${cfg.pilotUrl}/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const catalog = (await res.json()) as { models?: Array<{ modelId?: string; displayLabel?: string }> };
      const models = (catalog.models ?? [])
        .filter((m) => m.modelId)
        .map((m) => ({ id: m.modelId!, display_name: m.displayLabel || m.modelId! }));
      if (models.length > 0) {
        await invokeCodeSpaceAction(cfg, "syncModels", { models });
      }
    } catch {
      // ignore
    }
  };

  const startPolling = () => {
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void syncIdentityAndPollInbox();
      }, 3000);
    }
  };

  const requireRunningOrThrow = async (): Promise<void> => {
    const { pilotUp, webUp } = await checkServicesRunning();
    if (!pilotUp || !webUp) {
      throw new Error(
        "Muse Code Space is not running on this host. Run `/code-space start` to launch the pilot and web server.",
      );
    }
  };

  const syncIdentityAndPollInbox = async () => {
    if (polling) return;
    polling = true;
    try {
      const { pilotUp, webUp } = await checkServicesRunning();
      if (!pilotUp || !webUp) return;
      if (!identitySynced) {
        try {
          const payload = buildIdentityPayloadFromConfig(cfg);
          await invokeCodeSpaceAction(cfg, "setAssistantIdentity", payload);
          identitySynced = true;
        } catch {
          // Will retry on next tick when web/pilot are up.
        }
      }

      // Check for incoming messages addressed to the Muse assistant.
      const since = loadInboxCursor(cursorFile);
      let inbox = await invokeCodeSpaceAction<{
        ok: boolean;
        messages: Array<{
          seq: number;
          at: string;
          from: string;
          text: string;
        }>;
        latest: number;
        error: string | null;
      }>(cfg, "readMuseMessages", { since });

      if (inbox?.ok && typeof inbox.latest === "number" && inbox.latest < since) {
        saveInboxCursor(cursorFile, 0);
        inbox = await invokeCodeSpaceAction(cfg, "readMuseMessages", { since: 0 });
      }

      if (inbox?.ok && Array.isArray(inbox.messages) && inbox.messages.length > 0) {
        for (const msg of inbox.messages) {
          saveInboxCursor(cursorFile, msg.seq);
          pi.sendMessage(
            {
              customType: "muse-code-space-inbox",
              content: formatInboxPrompt(msg),
              display: true,
            },
            { triggerTurn: true },
          );
        }
      }

      // Sync pilot events and ask the Pi agent to supply missing task summaries.
      const list = await invokeCodeSpaceAction<{
        sessions: Array<{
          id: string;
          title: string;
          status: string;
          archived: boolean;
          prompt: string;
          session_summary: string | null;
          output_count: number;
          latest_output: string | null;
        }>;
      }>(cfg, "listSessions", { limit: 50 });

      const now = Date.now();
      for (const session of list?.sessions ?? []) {
        if (!session.archived && (session.status === "queued" || session.status === "running")) {
          try {
            await invokeCodeSpaceAction(cfg, "syncPilotEvents", { session_id: session.id });
          } catch {
            // ignore
          }
        }
        if (session.session_summary?.trim()) {
          requestedSummaries.delete(session.id);
          continue;
        }
        const hasContext = Boolean(session.prompt?.trim()) && (session.output_count > 0 || session.status === "succeeded");
        const lastAskedAt = requestedSummaries.get(session.id) ?? 0;
        // Throttle summary requests per session (10 minutes, matching watchdog lease)
        if (!session.archived && hasContext && now - lastAskedAt > 10 * 60_000) {
          requestedSummaries.set(session.id, now);
          pi.sendMessage(
            {
              customType: "muse-code-space-summary",
              content: formatSummaryRequestPrompt(session),
              display: true,
            },
            { triggerTurn: true },
          );
          // Request at most one missing summary per poll cycle.
          break;
        }
      }
    } catch {
      // Transient connectivity errors are retried on the next poll.
    } finally {
      polling = false;
    }
  };

  // ---- Register Tools (muse_code_space_*) ----

  pi.registerTool({
    name: "muse_code_space_status",
    label: "Code Space Status",
    description:
      "Check the status of the local Muse Code Space web interface, pilot daemon, assistant identity, and active companion tasks on this host.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const { pilotUp, webUp } = await checkServicesRunning();
      const webUrl = formatPublicWebUrl(cfg);
      let activeCount = 0;
      let totalCount = 0;
      if (webUp) {
        try {
          const list = await invokeCodeSpaceAction<{
            sessions: Array<{ archived: boolean }>;
            active_count: number;
          }>(cfg, "listSessions", { limit: 100 });
          activeCount = list.active_count;
          totalCount = list.sessions.length;
        } catch {
          // ignore
        }
      }
      const details = {
        webUrl,
        pilotUrl: cfg.pilotUrl,
        pilotUp,
        webUp,
        assistantName: cfg.assistantName,
        userName: cfg.userName,
        activeCount,
        totalCount,
      };
      const text = [
        `Status: ${webUp && pilotUp ? "running" : "stopped (run /code-space start to launch)"}`,
        `Web UI URL: ${webUrl}`,
        `Web Server: ${webUp ? "running" : "down"}`,
        `Pilot (${cfg.pilotUrl}): ${pilotUp ? "running" : "down"}`,
        `Assistant Identity: @${cfg.assistantName}${cfg.userName ? ` (user: ${cfg.userName})` : ""}`,
        `Companion Tasks: ${activeCount} active (${totalCount} total)`,
      ].join("\n");
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerTool<{ include_archived?: boolean }>({
    name: "muse_code_space_list_tasks",
    label: "List Code Space Tasks",
    description:
      "List companion tasks in Muse Code Space on this host, including companion name, task ID, status, summary, and workspace path.",
    parameters: {
      type: "object",
      properties: {
        include_archived: {
          type: "boolean",
          description: "Include archived (past) tasks as well as active tasks (default false).",
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params) {
      await requireRunningOrThrow();
      const data = await invokeCodeSpaceAction<{
        sessions: Array<{
          id: string;
          title: string;
          status: string;
          archived: boolean;
          session_summary: string | null;
          prompt: string;
          workspace_root: string;
          updated_at: string;
        }>;
      }>(cfg, "listSessions", { limit: 100 });
      const filtered = (data.sessions ?? []).filter((s) => params.include_archived || !s.archived);
      if (filtered.length === 0) {
        return {
          content: [{ type: "text", text: "No companion tasks found." }],
          details: { tasks: [] },
        };
      }
      const lines = filtered.map((s) => {
        const summary = s.session_summary?.trim() || s.prompt.replace(/\s+/g, " ").trim().slice(0, 100);
        return `- ${s.title} (${s.id}) [${s.archived ? "archived" : s.status}]: ${summary} — ${s.workspace_root}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { tasks: filtered },
      };
    },
  });

  pi.registerTool<{ task_id: string; event_limit?: number }>({
    name: "muse_code_space_read_task",
    label: "Read Code Space Task",
    description: "Read the details and recent transcript events of a Muse Code Space companion task by task ID.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The session/task ID from muse_code_space_list_tasks." },
        event_limit: {
          type: "number",
          description: "Maximum number of recent transcript events to return (default 40).",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await requireRunningOrThrow();
      try {
        await invokeCodeSpaceAction(cfg, "syncPilotEvents", { session_id: params.task_id });
      } catch {
        // ignore
      }
      const limit = Math.max(1, Math.min(200, Math.floor(params.event_limit ?? 40)));
      const data = await invokeCodeSpaceAction<{
        session: {
          id: string;
          title: string;
          status: string;
          session_summary: string | null;
          workspace_root: string;
        } | null;
        events: Array<{
          id: number;
          kind: string;
          content: string;
          created_at: string;
        }>;
      }>(cfg, "getSession", { id: params.task_id, event_limit: limit });
      if (!data.session) {
        return {
          content: [{ type: "text", text: `Task not found: ${params.task_id}` }],
          details: undefined,
          isError: true,
        };
      }
      const tail = data.events.slice(-limit);
      const formattedEvents = tail
        .map((e) => `[${e.kind}] ${e.content.slice(0, 600)}`)
        .join("\n\n");
      const text = [
        `Companion: ${data.session.title} (${data.session.id})`,
        `Status: ${data.session.status}`,
        `Summary: ${data.session.session_summary ?? "(none)"}`,
        `Workspace: ${data.session.workspace_root}`,
        "",
        formattedEvents || "(No transcript events yet.)",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { session: data.session, eventCount: tail.length },
      };
    },
  });

  pi.registerTool<{ to: string; message: string }>({
    name: "muse_code_space_send_message",
    label: "Message Code Space Companion",
    description:
      "Send a message as the Muse Assistant into an active Code Space companion conversation (by companion name such as 'Poppy' or by task ID). Wakes the companion to process your message.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient companion name (e.g. 'Poppy', 'Remy') or session/task ID.",
        },
        message: {
          type: "string",
          description: "Message content to send to the companion.",
        },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await requireRunningOrThrow();
      const res = await invokeCodeSpaceAction<{
        ok: boolean;
        to: string | null;
        queued: boolean;
        error: string | null;
      }>(cfg, "sendAgentMessage", {
        to: params.to,
        text: params.message,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Failed to send message: ${res.error ?? "unknown error"}` }],
          details: res,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Sent message to ${res.to ?? params.to}${res.queued ? " [queued for next turn]" : ""}.`,
          },
        ],
        details: res,
      };
    },
  });

  pi.registerTool<{
    companion: string;
    prompt: string;
    workspace_root?: string;
    repo?: string;
    summary?: string;
  }>({
    name: "muse_code_space_start_task",
    label: "Start Code Space Companion Task",
    description:
      "Start a new companion task in Muse Code Space on this host with a chosen companion (e.g. Poppy, Remy, Tilly, Nova, Sage), initial prompt, and optional workspace path under ~/workspace or GitHub repo (owner/repo).",
    parameters: {
      type: "object",
      properties: {
        companion: {
          type: "string",
          description: "Companion name or ID (Poppy, Remy, Tilly, Nova, Sage).",
        },
        prompt: {
          type: "string",
          description: "Initial task instructions for the companion.",
        },
        workspace_root: {
          type: "string",
          description:
            "Optional path under ~/workspace (e.g. '~/workspace/code/my-task'). Defaults to a generated '~/workspace/code/...' path.",
        },
        repo: {
          type: "string",
          description: "Optional GitHub repository to clone ('owner/repo').",
        },
        summary: {
          type: "string",
          description: "Optional short task title/summary.",
        },
      },
      required: ["companion", "prompt"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await requireRunningOrThrow();
      const key = params.companion.trim().toLowerCase();
      const match = BUILTIN_COMPANIONS[key] ?? { id: key, name: params.companion.trim() };
      const sessionId = crypto.randomUUID();
      const shortToken = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${sessionId.slice(0, 6)}`;
      const defaultWorkspace = `~/workspace/code/${shortToken}`;
      const rawWorkspace = params.workspace_root?.trim();
      const workspaceRoot =
        rawWorkspace && (rawWorkspace.startsWith("~/workspace") || rawWorkspace.includes("/workspace/"))
          ? rawWorkspace
          : defaultWorkspace;
      const created = await invokeCodeSpaceAction<{
        ok: boolean;
        id: string | null;
        start_status: string | null;
        error: string | null;
      }>(cfg, "createSession", {
        session_id: sessionId,
        title: match.name,
        prompt: params.prompt,
        workspaceRoot,
        ...(params.repo?.trim() ? { repo: params.repo.trim() } : {}),
      });
      if (!created.ok || !created.id) {
        return {
          content: [{ type: "text", text: `Failed to start task: ${created.error ?? "unknown error"}` }],
          details: created,
          isError: true,
        };
      }
      if (params.summary?.trim()) {
        await invokeCodeSpaceAction(cfg, "setSessionSummary", {
          id: created.id,
          summary: params.summary.trim(),
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `Started ${match.name} on task ${created.id} in ${workspaceRoot} (status: ${created.start_status ?? "started"}).`,
          },
        ],
        details: { sessionId: created.id, companion: match.name, workspaceRoot, startStatus: created.start_status },
      };
    },
  });

  pi.registerTool<{
    task_id: string;
    summary?: string;
    archived?: boolean;
    compact_context?: boolean;
  }>({
    name: "muse_code_space_update_task",
    label: "Update Code Space Task",
    description:
      "Update a companion task's summary, archive/restore state, or compact its conversation context.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The session/task ID." },
        summary: { type: "string", description: "New short summary for the task." },
        archived: { type: "boolean", description: "Set true to archive or false to restore." },
        compact_context: { type: "boolean", description: "Set true to compact the task's context window." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      await requireRunningOrThrow();
      const updates: string[] = [];
      if (params.summary !== undefined) {
        const res = await invokeCodeSpaceAction<{ ok: boolean; error: string | null }>(cfg, "setSessionSummary", {
          id: params.task_id,
          summary: params.summary.trim() || null,
        });
        if (!res.ok) throw new Error(res.error ?? "Failed to update summary");
        updates.push("summary updated");
      }
      if (params.archived !== undefined) {
        const res = await invokeCodeSpaceAction<{ ok: boolean; error: string | null }>(cfg, "setSessionArchived", {
          id: params.task_id,
          archived: params.archived,
        });
        if (!res.ok) throw new Error(res.error ?? "Failed to update archive state");
        updates.push(params.archived ? "archived" : "restored");
      }
      if (params.compact_context) {
        const res = await invokeCodeSpaceAction<{ ok: boolean; error: string | null }>(cfg, "compactContext", {
          session_id: params.task_id,
        });
        if (!res.ok) throw new Error(res.error ?? "Failed to compact context");
        updates.push("context compacted");
      }
      return {
        content: [
          {
            type: "text",
            text: `Task ${params.task_id}: ${updates.join(", ") || "no changes requested"}.`,
          },
        ],
        details: { taskId: params.task_id, updates },
      };
    },
  });

  pi.registerTool<{
    name?: string;
    user_name?: string | null;
    color?: string;
    avatar_path?: string | null;
    avatar_data_url?: string | null;
  }>({
    name: "muse_code_space_set_identity",
    label: "Set Code Space Assistant Identity",
    description:
      "Read or update the Muse Assistant identity and user name shown in Muse Code Space (assistant name for @ mentions, #rrggbb theme color, avatar image path or data URL, and the user's name for the Welcome Card greeting). Omit all fields to read the current identity.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Assistant display name shown in @ mentions and message cards (1–40 chars, e.g. 'Jolly').",
        },
        user_name: {
          type: ["string", "null"],
          description: "The user's own name for the Welcome Card greeting (1–40 chars, or null to clear).",
        },
        color: {
          type: "string",
          description: "Assistant theme color in #rrggbb hex format (e.g. '#d0e4fc').",
        },
        avatar_path: {
          type: ["string", "null"],
          description: "Path to a local .png, .jpg, or .webp image file (<= 256 KiB) to use as the assistant avatar, or null to clear.",
        },
        avatar_data_url: {
          type: ["string", "null"],
          description: "Data URL ('data:image/png;base64,...') for the assistant avatar, or null to clear.",
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params) {
      await requireRunningOrThrow();
      const hasUpdates =
        params.name !== undefined ||
        params.user_name !== undefined ||
        params.color !== undefined ||
        params.avatar_path !== undefined ||
        params.avatar_data_url !== undefined;

      if (!hasUpdates) {
        const current = await invokeCodeSpaceAction<{
          ok: boolean;
          name: string | null;
          color: string | null;
          avatar_data_url: string | null;
          user_name: string | null;
          error: string | null;
        }>(cfg, "getAssistantIdentity", {});
        if (!current.ok) throw new Error(current.error ?? "Failed to read assistant identity");
        return {
          content: [
            {
              type: "text",
              text: [
                `Assistant name: ${current.name ?? "(unset)"}`,
                `User name: ${current.user_name ?? "(unset)"}`,
                `Color: ${current.color ?? "(unset)"}`,
                `Avatar: ${current.avatar_data_url ? `set (${current.avatar_data_url.length} chars)` : "none"}`,
              ].join("\n"),
            },
          ],
          details: current,
        };
      }

      let avatarDataUrl = params.avatar_data_url;
      if (params.avatar_path !== undefined) {
        avatarDataUrl = params.avatar_path === null ? null : encodeAvatarFileToDataUrl(params.avatar_path);
      }
      const payload: Record<string, unknown> = {};
      if (params.name !== undefined) payload.name = params.name.trim();
      if (params.user_name !== undefined) payload.user_name = params.user_name === null ? null : params.user_name.trim();
      if (params.color !== undefined) payload.color = params.color.trim();
      if (avatarDataUrl !== undefined) payload.avatar_data_url = avatarDataUrl;

      const updated = await invokeCodeSpaceAction<{
        ok: boolean;
        name: string | null;
        color: string | null;
        avatar_data_url: string | null;
        user_name: string | null;
        error: string | null;
      }>(cfg, "setAssistantIdentity", payload);
      if (!updated.ok) throw new Error(updated.error ?? "Failed to update assistant identity");
      if (updated.name) cfg.assistantName = updated.name;
      if (updated.user_name !== undefined) cfg.userName = updated.user_name;
      identitySynced = true;

      return {
        content: [
          {
            type: "text",
            text: `Updated assistant identity: @${updated.name ?? cfg.assistantName}${updated.user_name ? `, user: ${updated.user_name}` : ""}, color: ${updated.color ?? "default"}, avatar: ${updated.avatar_data_url ? "set" : "none"}.`,
          },
        ],
        details: updated,
      };
    },
  });

  // ---- Register /code-space Command ----

  pi.registerCommand("code-space", {
    description: "Manage Muse Code Space: /code-space start [KEY=VALUE ...] | stop | restart [KEY=VALUE ...] | env [KEY=VALUE ...] | status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1);

      if (sub === "env") {
        const updates = parseInlineEnvTokens(rest);
        if (Object.keys(updates).length > 0) {
          updatePersistedPilotEnv(cfg.stateDir, updates);
        }
        const merged = loadPersistedPilotEnv(cfg.stateDir);
        const keys = Object.keys(merged);
        ctx.ui.notify(
          keys.length > 0
            ? `Pilot env (${path.join(cfg.stateDir, "pilot.env")}): ${keys.map((k) => `${k}=${merged[k]}`).join(", ")}`
            : `No custom pilot env vars set in ${path.join(cfg.stateDir, "pilot.env")}. Usage: /code-space env KEY=VALUE`,
          "info",
        );
        return;
      }

      if (sub === "stop") {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        spawnedWeb?.kill();
        spawnedPilot?.kill();
        ctx.ui.notify("Stopped Muse Code Space background polling and spawned services.", "info");
        return;
      }
      if (sub === "start" || sub === "restart") {
        const updates = parseInlineEnvTokens(rest);
        if (Object.keys(updates).length > 0) {
          updatePersistedPilotEnv(cfg.stateDir, updates);
        }
        if (sub === "restart" || Object.keys(updates).length > 0) {
          spawnedWeb?.kill();
          spawnedPilot?.kill();
          identitySynced = false;
        }
        const { pilotUp, webUp } = await ensureServicesRunning(true);
        if (pilotUp && webUp) {
          await syncModelsFromPilot();
          startPolling();
          void syncIdentityAndPollInbox();
        }
        const notice = formatStartupNotice({
          pilotUp,
          webUp,
          webUrl: formatPublicWebUrl(cfg),
          pilotUrl: cfg.pilotUrl,
          stateDir: cfg.stateDir,
          pilotError: pilotUp ? null : readLastLogError(path.join(cfg.stateDir, "pilot.log")),
          webError: webUp ? null : readLastLogError(path.join(cfg.stateDir, "web.log")),
        });
        ctx.ui.notify(notice.message, notice.level);
        return;
      }

      const { pilotUp, webUp } = await checkServicesRunning();
      if (!pilotUp && !webUp) {
        ctx.ui.notify("Muse Code Space is stopped. Run `/code-space start` to launch the pilot and web UI.", "info");
        return;
      }
      if (pilotUp && webUp) {
        startPolling();
        void syncIdentityAndPollInbox();
      }
      const notice = formatStartupNotice({
        pilotUp,
        webUp,
        webUrl: formatPublicWebUrl(cfg),
        pilotUrl: cfg.pilotUrl,
        stateDir: cfg.stateDir,
        pilotError: pilotUp ? null : readLastLogError(path.join(cfg.stateDir, "pilot.log")),
        webError: webUp ? null : readLastLogError(path.join(cfg.stateDir, "web.log")),
      });
      ctx.ui.notify(notice.message, notice.level);
    },
  });

  // ---- Lifecycle Hooks ----

  pi.on("session_start", async (_event, ctx) => {
    if (!cfg.autoStart) {
      // Attach quietly if services are already running on this host; otherwise
      // stay completely idle until the user runs `/code-space start`.
      const { pilotUp, webUp } = await checkServicesRunning();
      if (pilotUp && webUp) {
        startPolling();
        void syncIdentityAndPollInbox();
      }
      return;
    }
    const { pilotUp, webUp } = await ensureServicesRunning(true);
    if (pilotUp && webUp) {
      startPolling();
      void syncIdentityAndPollInbox();
    }
    if (ctx?.hasUI) {
      const notice = formatStartupNotice({
        pilotUp,
        webUp,
        webUrl: formatPublicWebUrl(cfg),
        pilotUrl: cfg.pilotUrl,
        stateDir: cfg.stateDir,
        pilotError: pilotUp ? null : readLastLogError(path.join(cfg.stateDir, "pilot.log")),
        webError: webUp ? null : readLastLogError(path.join(cfg.stateDir, "web.log")),
      });
      ctx.ui.notify(notice.message, notice.level);
    }
  });

  pi.on("session_shutdown", () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

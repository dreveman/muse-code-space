import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyColorMode,
  applyUiTheme,
  COLOR_MODE_KEY,
  detectIosDevice,
  loadColorMode,
  loadUiTheme,
  parseColorMode,
  parseUiTheme,
  resolveColorMode,
  resolveUiTheme,
  UI_THEME_KEY,
} from "./colorMode.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(dir, "App.tsx"), "utf8");
const main = readFileSync(join(dir, "main.tsx"), "utf8");
const menu = readFileSync(join(dir, "WireDebug.tsx"), "utf8");
const css = readFileSync(join(dir, "theme.css"), "utf8");

test("color mode defaults to system and resolves explicit overrides independently of the OS", () => {
  assert.equal(parseColorMode(null), "system");
  assert.equal(parseColorMode("unexpected"), "system");
  assert.equal(parseColorMode("light"), "light");
  assert.equal(parseColorMode("dark"), "dark");
  assert.equal(resolveColorMode("system", false), "light");
  assert.equal(resolveColorMode("system", true), "dark");
  assert.equal(resolveColorMode("light", true), "light");
  assert.equal(resolveColorMode("dark", false), "dark");
});

test("ui theme defaults to system, detects iOS devices, and resolves explicit overrides", () => {
  assert.equal(parseUiTheme(null), "system");
  assert.equal(parseUiTheme("unexpected"), "system");
  assert.equal(parseUiTheme("web"), "web");
  assert.equal(parseUiTheme("liquid-glass"), "liquid-glass");
  assert.equal(detectIosDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
  assert.equal(detectIosDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" }), true);
  assert.equal(detectIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(detectIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 }), false);
  assert.equal(detectIosDevice({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), false);
  assert.equal(resolveUiTheme("system", false), "web");
  assert.equal(resolveUiTheme("system", true), "liquid-glass");
  assert.equal(resolveUiTheme("web", true), "web");
  assert.equal(resolveUiTheme("liquid-glass", false), "liquid-glass");

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  let saved = null;
  globalThis.window = {
    localStorage: {
      getItem: (key) => key === UI_THEME_KEY ? saved : null,
      setItem: (key, val) => { if (key === UI_THEME_KEY) saved = val; },
    },
  };
  globalThis.document = { documentElement: { dataset: {} } };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
  });
  try {
    assert.equal(loadUiTheme(), "system");
    applyUiTheme(loadUiTheme());
    assert.equal(document.documentElement.dataset.uiTheme, "liquid-glass");
    applyUiTheme("web");
    assert.equal(loadUiTheme(), "web");
    assert.equal(document.documentElement.dataset.uiTheme, "web");
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

test("color mode restores browser preference and applies it to the root element", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let saved = "light";
  let systemIsDark = true;
  globalThis.window = {
    localStorage: { getItem: (key) => key === COLOR_MODE_KEY ? saved : null },
    matchMedia: () => ({ matches: systemIsDark }),
  };
  globalThis.document = { documentElement: { dataset: {} } };
  try {
    assert.equal(loadColorMode(), "light");
    applyColorMode(loadColorMode());
    assert.equal(document.documentElement.dataset.colorMode, "light", "saved light beats dark OS");
    saved = "system";
    applyColorMode(loadColorMode());
    assert.equal(document.documentElement.dataset.colorMode, "dark");
    systemIsDark = false;
    applyColorMode(loadColorMode());
    assert.equal(document.documentElement.dataset.colorMode, "light");
    saved = "dark";
    applyColorMode(loadColorMode());
    assert.equal(document.documentElement.dataset.colorMode, "dark", "saved dark beats light OS");
    Object.defineProperty(window, "localStorage", { get() { throw new Error("storage blocked"); } });
    assert.equal(loadColorMode(), "system", "blocked browser storage uses system default");
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test("menu exposes both saved view preferences and an accessible three-way color selector", () => {
  assert.ok(app.includes('EXPAND_TOOLS_KEY = "muse-code-space:expand-tools"'));
  assert.ok(app.includes('checked: expandTools') && app.includes('setExpandTools((value) => !value)'));
  assert.ok(app.includes('window.localStorage.setItem(EXPAND_TOOLS_KEY, String(expandTools))'));
  assert.ok(app.includes('colorMode={colorMode}') && app.includes('setColorMode(mode)'));
  assert.ok(app.includes('systemTheme.addEventListener("change", updateSystemMode)'));
  assert.ok(app.includes('systemTheme.removeEventListener("change", updateSystemMode)'));
  assert.ok(main.includes('applyColorMode(loadColorMode());'), "apply the saved palette before rendering");
  assert.ok(menu.includes('role="group" aria-label="Color mode"'));
  assert.ok(menu.includes('role={action.radio ? "menuitemradio"'));
  for (const option of ['value: "system"', 'value: "light"', 'value: "dark"']) assert.ok(menu.includes(option));
  assert.ok(menu.includes('checked: colorMode === option.value'));
  assert.ok(menu.includes('if (action.checked === undefined) onDone();'), "checkbox and radio toggles keep the menu open");
});

test("tool previews expand with the preference, remain individually collapsible, never auto-fetch full output", () => {
  assert.ok(app.includes('const [expanded, setExpanded] = useState(expandedByDefault)'));
  assert.ok(app.includes('setExpanded(expandedByDefault)'), "toggling preference updates existing rows");
  assert.ok(app.includes('setExpanded(!expanded)'), "manual per-row toggle still works");
  assert.ok(app.includes('expandedByDefault={expandTools}'));
  assert.ok(app.includes('lines.slice(0, TOOL_PREVIEW_LINES)') && app.includes('onClick={() => showAll ? setShowAll(false) : void showEverything()}'));
  assert.ok(!app.includes('if (expandedByDefault) void showEverything()'), "do not fetch on auto-expansion");
});

test("all app, transcript, wire-log, and terminal palettes follow the resolved mode", () => {
  assert.ok(!css.includes('@media (prefers-color-scheme:'), "OS media queries must not override the chosen mode");
  for (const selector of [
    ':root[data-color-mode="dark"] {',
    ':root[data-color-mode="dark"] .session-row.selected',
    ':root[data-color-mode="dark"] .agent-message-peer',
    ':root[data-color-mode="light"] .transcript',
    ':root[data-color-mode="light"] .wire-debug-popovers',
    ':root[data-color-mode="light"] .side-panel',
    ':root[data-color-mode="light"] .terminal-panel-term.wterm',
  ]) assert.ok(css.includes(selector), `missing resolved-mode palette: ${selector}`);
});

test("dark transcript cards and input invert together while the light palette stays light", () => {
  const darkTranscript = css.match(/^\.transcript\s*\{[^}]*\}/m)?.[0] ?? "";
  const lightTranscript = css.match(/^:root\[data-color-mode="light"\] \.transcript\s*\{[^}]*\}/m)?.[0] ?? "";
  const token = (block, name) => block.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1];
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
    const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const contrast = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };
  const darkBg = token(darkTranscript, "terminal-user-bg");
  const darkText = token(darkTranscript, "terminal-user");
  assert.ok(darkBg && darkText && contrast(darkBg, darkText) > 7, "dark prompt/tool/message cards need light, readable text");
  assert.ok(contrast(token(lightTranscript, "terminal-user-bg"), token(lightTranscript, "terminal-user")) > 7, "keep the light palette legible");
  for (const selector of ['.output-event.user', '.output-event.tool', '.output-event.agents', '.output-event.message']) {
    assert.ok(css.includes(selector), `missing transcript surface: ${selector}`);
  }
  assert.ok(css.includes(':root[data-color-mode="dark"] .output-event.stdout { background: var(--terminal-surface); }'), "agent replies use a dark surface");
  assert.ok(css.includes(':root[data-color-mode="dark"] .output-event.message.muse-incoming'), "assistant messages must not use a pale blue card");
  const composer = css.match(/^:root\[data-color-mode="dark"\] \.terminal-composer\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.ok(composer.includes('background: var(--surface-strong)') && composer.includes('--terminal-text: var(--text)'), "input and controls use sidebar dark colors");
  assert.ok(css.includes(':root[data-color-mode="dark"] .agent-mention-menu,') && css.includes(':root[data-color-mode="dark"] .companion-menu'), "input popovers also invert");
});

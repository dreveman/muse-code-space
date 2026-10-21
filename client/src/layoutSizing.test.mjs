import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  chatWidthBounds, clampChatShare, clampSidebarWidth, DEFAULT_CHAT_SHARE,
  DEFAULT_SIDEBAR_WIDTH, loadPaneSizes, PANE_SIZES_KEY, savePaneSizes, sidebarWidthBounds,
} from "./layoutSizing.ts";

const dir = dirname(fileURLToPath(import.meta.url));

test("sidebar clamps to leave room for the detail view at desktop sizes", () => {
  assert.deepEqual(sidebarWidthBounds(780), { min: 244, max: 339 });
  assert.deepEqual(sidebarWidthBounds(1400), { min: 244, max: 560 });
  assert.equal(clampSidebarWidth(9999, 780), 339);
  assert.equal(clampSidebarWidth(0, 1400), 244);
  assert.equal(clampSidebarWidth(NaN, 1400), DEFAULT_SIDEBAR_WIDTH);
});

test("chat/terminal bounds preserve usable minimums as desktop width shrinks", () => {
  assert.deepEqual(chatWidthBounds(801), { min: 280, max: 560 });
  assert.deepEqual(chatWidthBounds(441), { min: 220, max: 220 });
  assert.equal(clampChatShare(0.01, 801), 280 / 800);
  assert.equal(clampChatShare(0.99, 801), 560 / 800);
  assert.equal(clampChatShare(NaN, 801), DEFAULT_CHAT_SHARE);
  assert.equal(clampChatShare(0.9, 441), 0.5);
});

test("saved sizes survive reload, corrupted or blocked storage falls back safely", () => {
  const values = new Map();
  globalThis.window = { localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } };
  savePaneSizes({ sidebarWidth: 445, chatShare: 0.6 });
  assert.equal(values.has(PANE_SIZES_KEY), true);
  assert.deepEqual(loadPaneSizes(1300), { sidebarWidth: 445, chatShare: 0.6 });
  values.set(PANE_SIZES_KEY, '{broken');
  assert.deepEqual(loadPaneSizes(1300), { sidebarWidth: DEFAULT_SIDEBAR_WIDTH, chatShare: DEFAULT_CHAT_SHARE });
  values.set(PANE_SIZES_KEY, JSON.stringify({ sidebarWidth: 9999, chatShare: 9999 }));
  assert.deepEqual(loadPaneSizes(780), { sidebarWidth: 339, chatShare: 0.5 });
  globalThis.window = { localStorage: { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } } };
  assert.deepEqual(loadPaneSizes(1300), { sidebarWidth: DEFAULT_SIDEBAR_WIDTH, chatShare: DEFAULT_CHAT_SHARE });
  assert.doesNotThrow(() => savePaneSizes({ sidebarWidth: 316, chatShare: 0.5 }));
  delete globalThis.window;
});

test("dividers support mouse/touch dragging and keyboard resizing only on desktop", () => {
  const divider = readFileSync(join(dir, "PaneDivider.tsx"), "utf8");
  const css = readFileSync(join(dir, "theme.css"), "utf8");
  assert.ok(divider.includes('role="separator"') && divider.includes('aria-orientation="vertical"'));
  for (const text of ["setPointerCapture", "onPointerMove", "onPointerCancel", "ArrowLeft", "ArrowRight", 'case "Home"', 'case "End"']) {
    assert.ok(divider.includes(text), text);
  }
  assert.ok(/\.pane-divider\s*\{\s*display:\s*none/.test(css), "hidden by default on mobile");
  assert.ok(/\.pane-divider.dragging\s*\{[^}]*background:\s*var\(--border-strong\)[^}]*box-shadow:[^}]*var\(--border-strong\)/.test(css), "only dragging thickens the line in neutral gray");
  assert.ok(!/\.pane-divider:hover(?:,|\s*\{)[^}]*box-shadow/.test(css), "hover shows only the grab icon; the line stays the same");
  assert.ok(/@media \(min-width: 780px\)[\s\S]*?\.pane-divider\s*\{\s*display:\s*block/.test(css), "visible on desktop");
  assert.ok(css.includes('grid-template-columns: clamp(min(280px, calc((100% - 1px) / 2))'), "chat size clamped when viewport shrinks");
});

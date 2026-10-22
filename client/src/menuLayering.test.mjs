// Run: node --test client/src/menuLayering.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const theme = readFileSync(path.join(root, "theme.css"), "utf8");
const companions = readFileSync(path.join(root, "companions.css"), "utf8");

function zIndexOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{[^}]*?z-index:\\s*(\\d+)`).exec(css);
  return match ? Number(match[1]) : null;
}

test("composer-anchored menus lift their prompt above the floating buttons", () => {
  const toolbarZ = zIndexOf(theme, ".chat-floating-toolbar");
  const navZ = zIndexOf(companions, ".companion-card-navigation");
  assert.equal(toolbarZ, 4, "floating conversation toolbar stacking is as expected");
  assert.equal(navZ, 3, "companion prev/next navigation stacking is as expected");

  const lift = /\.terminal-prompt:has\(([^)]*)\)\s*\{\s*z-index:\s*(\d+)/.exec(theme);
  assert.ok(lift, "an open composer menu lifts the whole terminal-prompt stacking context");
  for (const menu of [".repo-menu", ".companion-menu", ".agent-mention-menu"]) {
    assert.ok(lift[1].includes(menu), `prompt lift covers ${menu}`);
  }
  assert.ok(Number(lift[2]) > toolbarZ, "lifted prompt paints above the floating toolbar");
  assert.ok(Number(lift[2]) > navZ, "lifted prompt paints above the companion prev/next buttons");
  assert.ok(Number(lift[2]) < 60, "lifted prompt stays below modal dialog backdrops");
});

test("the prompt's resting z-index stays below the floating buttons", () => {
  // Only an open menu may lift the composer; at rest the floating toolbar
  // and companion navigation keep painting above it.
  assert.equal(zIndexOf(theme, ".terminal-prompt"), 2);
});

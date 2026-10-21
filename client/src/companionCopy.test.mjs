import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("shell, composer, accessibility and menu copy call Code Space agents companions", () => {
  const app = read("./App.tsx");
  const menu = read("./WireDebug.tsx");
  const mentions = read("./AgentMentionMenu.tsx");
  const files = read("./SidePanel.tsx");
  assert.ok(app.includes('aria-label="Code companions"'));
  assert.ok(app.includes('aria-label="Filter"'));
  for (const label of ["Pick a companion", "Select a task", "Rename task", "Archive task", "Restore task", "Delete task"]) assert.ok(app.includes(label), label);
  assert.ok(menu.includes('aria-label="Companion menu"') && files.includes('title="Open companion artifact"'));
  assert.ok(mentions.includes('aria-label="Mention a companion"'));
});

test("list_agents remains a protocol-shaped tool, not rebranded", () => {
  const app = read("./App.tsx");
  const adapters = read("./toolPresentation.ts");
  assert.ok(app.includes('aria-label="Agents you can message"'));
  assert.ok(adapters.includes('mcp__code_space__list_agents') && adapters.includes('"Listing agents"'));
});

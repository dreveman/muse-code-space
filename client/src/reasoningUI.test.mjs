import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(dir, "App.tsx"), "utf8");
const css = readFileSync(join(dir, "theme.css"), "utf8");
const menu = readFileSync(join(dir, "WireDebug.tsx"), "utf8");

test("reasoning visibility is a live, persisted hamburger-menu view preference", () => {
  assert.ok(app.includes('SHOW_REASONING_KEY = "muse-code-space:show-reasoning"'));
  assert.ok(app.includes('key: "reasoning"') && app.includes('checked: showReasoning'));
  assert.ok(app.includes('onActivate: () => setShowReasoning((visible) => !visible)'));
  assert.ok(app.includes('return [...viewMenuActions, ...actions]'), "Past agents have the same view toggles");
  assert.ok(app.includes('actions={viewMenuActions}'), "view toggles remain available without a selected agent");
  assert.ok(menu.includes('action.checked === undefined ? "menuitem" : "menuitemcheckbox"'));
  assert.ok(menu.includes('aria-checked={action.checked}'));
  assert.ok(app.includes('showReasoning ? transcriptEvents : transcriptEvents.filter((event) => event.kind !== "thinking")'));
  assert.ok(!/api\.(createSession|continueSession|sendInput)\([\s\S]{0,180}showReasoning/.test(app), "visibility never changes start/turn requests");
});

test("thinking looks like normal output, but italic and dim, and empty updates do not render", () => {
  assert.ok(app.includes('if (event.kind === "thinking" && !content.trim()) return null'));
  assert.ok(/event.kind === "thinking" \? \(\s*<>\s*<Markdown text=\{content\}/.test(app));
  assert.ok(app.includes('reasoningDisplay(event.content)'), "old and new summaries separate stored truncation metadata from the text");
  assert.ok(app.includes('<div className="message-time" role="note" aria-label="Reasoning summary truncated" title="Reasoning summary truncated">...</div>'), "three dots are visible in result timestamp styling, with an accessible explanation");
  assert.ok(!css.includes(".reasoning-truncation-note"), "ellipsis uses the unmodified timestamp style");
  assert.ok(/\.output-event\.thinking\s*\{[^}]*color:\s*var\(--terminal-dim\);[^}]*font-style:\s*italic/.test(css));
});

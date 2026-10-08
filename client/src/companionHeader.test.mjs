import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

test("companion header has the reference's team pill, title and supporting line", () => {
  const header = app.match(/<header className="command-bar">[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.ok(header.includes('className="command-bar-eyebrow">THE CODING TEAM</span>'));
  assert.ok(header.includes('<h1>Code Companions</h1>'));
  assert.ok(header.includes('Specialized code helpers that work for you and your assistant'));
  assert.ok(!header.includes('<button'), "choose a companion instead of explicitly creating a task");
  assert.ok(css.includes('.command-bar-eyebrow { grid-column: 1; grid-row: 1;') && css.includes('border-radius: 999px; background: var(--text); color: var(--bg);'), "theme-aware pill");
  assert.ok(css.includes('.command-bar-description { grid-column: 1 / -1; grid-row: 3;'), "subtitle gets the full sidebar width");
});

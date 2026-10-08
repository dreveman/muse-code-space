// Chat controls float over the transcript; metadata belongs in the sidebar.
// Run: node --test client/src/workspaceHeader.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const css = readFileSync(path.join(root, "theme.css"), "utf8");

test("chat has no status, name or directory header", () => {
  assert.ok(!app.includes('className="detail-header"'));
  assert.ok(!app.includes('WorkspaceCopyButton'));
  assert.ok(!app.includes('headerPathBelow'));
});

test("chat controls float within the transcript column", () => {
  const chat = app.indexOf('id="agent-chat"');
  const controls = app.indexOf('className="chat-floating-toolbar"', chat);
  const body = app.indexOf('ref={terminalBodyRef}', chat);
  assert.ok(chat < controls && controls < body);
  assert.ok(/\.chat-floating-toolbar\s*\{[^}]*position:\s*absolute/.test(css));
  assert.ok(/#agent-chat\s*\{[^}]*position:\s*relative/.test(css));
});

test("floating controls leave the contents clickable", () => {
  assert.ok(/\.chat-floating-toolbar\s*\{[^}]*pointer-events:\s*none/.test(css));
  assert.ok(/\.chat-floating-actions\s*\{[^}]*pointer-events:\s*auto/.test(css));
});

test("the first transcript message starts clear of the floating companion", () => {
  assert.ok(/#agent-chat > \.terminal-body\s*\{[^}]*padding-top:\s*112px/.test(css));
  assert.ok(app.includes('onScroll={(event) => {'));
  assert.ok(app.includes('followTranscriptRef.current = transcriptAtBottom(event.currentTarget)'));
});

test("terminal, session menu and mobile back remain available", () => {
  assert.ok(app.includes('<NewTerminalButton onOpen={() => openTerminalTab(detailSession.id)} />'));
  assert.ok(app.includes('actions={sessionMenuActions(selectedSession ?? detailSession)}'));
  assert.ok(app.includes('aria-label="Back to companions"'));
  assert.ok(css.includes('.chat-floating-toolbar .mobile-back-button { pointer-events: auto; }'));
});

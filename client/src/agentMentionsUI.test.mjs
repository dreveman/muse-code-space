import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(dir, "App.tsx"), "utf8");
const css = readFileSync(join(dir, "theme.css"), "utf8");
const menu = readFileSync(join(dir, "AgentMentionMenu.tsx"), "utf8");

test("both composers autocomplete @agent names from the pilot's directory", () => {
  assert.equal((app.match(/<AgentMentionMenu agents=\{mentionMatches\}/g) ?? []).length, 2);
  assert.equal((app.match(/if \(handleMentionKeyDown\(event\)\) return;/g) ?? []).length, 2);
  assert.ok(app.includes('queryFn: () => api.listAgents({})'));
  assert.ok(app.includes('sessions.filter((session) => session.pilot_session_id && !session.archived)'), "offline suggestions use cached agents");
  assert.ok(app.includes('pilotId: mentionSender?.pilot_session_id ?? null') && app.includes('name: mentionSender?.title ?? null'), "self is excluded even when the pilot uses a different id");
  assert.ok(app.includes('mentionAgentsQuery.data?.assistant_name?.trim() || "Jolly"'), "assistant avatar name comes from the pilot, falling back to Jolly");
  assert.ok(menu.includes(' (your Muse assistant)'), "assistant suggestion is distinguished from agents");
  assert.ok(/\.agent-mention-menu\s*\{[^}]*position:\s*absolute[^}]*width:\s*280px;[^}]*max-width:\s*calc\(100% - 16px\)/.test(css), "suggestions are compact and fit within either composer");
  assert.ok(menu.includes('role="listbox"') && menu.includes('role="option"'));
});

test("choosing a suggestion doesn't submit and normal prompts stay user-authored", () => {
  assert.ok(app.includes('if (event.key === "ArrowDown" || event.key === "ArrowUp")'));
  assert.ok(app.includes('event.key === "Enter" || event.key === "Tab"'));
  assert.ok(app.includes('suppressMentionKeyUpRef.current = true'));
  assert.ok(app.includes('const message: QueuedMessage = { kind: "message", sessionId: detailSession.id, content }'), "the original prompt is submitted by the selected agent");
  assert.ok(!app.includes('api.sendAgentMessage({'), "the browser must not impersonate the agent as Muse");
});

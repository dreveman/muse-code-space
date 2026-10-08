import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAgentListOutput } from "./agentListOutput.ts";

test("list_agents formats peer names, busy status and the current assistant avatar", () => {
  assert.deepEqual(parseAgentListOutput('You are "milo". You can message:\n- juno\n- pip (busy)\n- Jolly — your Muse assistant'), {
    self: "milo",
    agents: [
      { name: "juno", busy: false, assistant: false },
      { name: "pip", busy: true, assistant: false },
      { name: "Jolly", busy: false, assistant: true },
    ],
  });
  assert.equal(parseAgentListOutput('You are "milo". You can message:\n- Aria — your Muse assistant').agents[0].name, "Aria");
});

test("previously saved muse-alias rows display the avatar name, not muse", () => {
  const old = parseAgentListOutput('You are "milo". You can message:\n- muse — Jolly, the user\'s Muse assistant');
  assert.equal(old.self, "milo");
  assert.deepEqual(old.agents, [
    { name: "Jolly", busy: false, assistant: true },
  ]);
});

test("unrecognized or oversized results fall back to the raw transcript", () => {
  for (const text of ['other format', 'You are "milo". You can message:\n- ', 'You are "milo". You can message:\n  juno', 'x'.repeat(20001)]) {
    assert.equal(parseAgentListOutput(text), null);
  }
});

test("list view reuses From/To name colors and has actual bullet entries", () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
  assert.ok(app.includes('You are <span className="agent-message-peer" style={agentColorStyle(list.self)}>{displayAgentName(list.self)}</span>. You can message:'));
  assert.ok(app.includes('className="agent-message-peer" style={agentColorStyle(agent.name)}'));
  assert.ok(app.includes('className="agent-message-muse" style={assistantColorStyle(undefined)}'));
  assert.ok(app.includes('className="agent-list-tool-bullet"'));
  assert.ok(css.includes('.agent-list-tool-row {'));
});

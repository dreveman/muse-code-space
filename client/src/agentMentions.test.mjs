import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionAtCursor, completeMention, matchingAgents } from "./agentMentions.ts";

test("@ completion starts at a word boundary and follows the caret, not emails", () => {
  assert.deepEqual(mentionAtCursor("Send @pi a message", 8), { start: 5, end: 8, query: "pi" });
  assert.deepEqual(mentionAtCursor("(@pip)", 4), { start: 1, end: 5, query: "pi" });
  assert.deepEqual(mentionAtCursor("Hello @", 7), { start: 6, end: 7, query: "" });
  assert.equal(mentionAtCursor("foo@pip.com", 7), null);
  assert.equal(mentionAtCursor("Send @pip a message", 10), null); // cursor after space
  assert.equal(mentionAtCursor("hi @pip", 100), null);
});

test("selection replaces the mention, keeps the request, and supports multiword names", () => {
  assert.deepEqual(completeMention("Send @pi a message", 8, "pip"), { text: "Send @pip a message", cursor: 10 });
  assert.deepEqual(completeMention("Send @pi", 8, "Pip"), { text: "Send @Pip ", cursor: 10 });
  assert.deepEqual(completeMention("Send @mi to review", 8, "My Agent"), { text: 'Send @"My Agent" to review', cursor: 17 });
  assert.equal(completeMention("Send @mi", 8, 'My "Agent"').text, 'Send @"My \\"Agent\\"" ');
  assert.equal(completeMention("email foo@pi", 12, "pip"), null);
});

test("suggestions only include available matching agents, never the sender", () => {
  const agents = [
    { name: "pip", session_id: "pip-id", busy: false },
    { name: "Pippa", session_id: "pippa-id", busy: true },
    { name: "pip", session_id: "duplicate", busy: false },
    { name: "Beta", session_id: "beta-id", busy: false },
  ];
  assert.deepEqual(matchingAgents(agents, "PI", { id: "pippa-id", pilotId: null, name: "Pippa" }).map((a) => a.name), ["pip"]);
  assert.deepEqual(matchingAgents(agents, "pi", { id: "pip-id", pilotId: null, name: "pip" }).map((a) => a.name), ["Pippa"]);
  assert.deepEqual(matchingAgents([
    { name: "Alpha", session_id: "backend-alpha", busy: true },
    { name: "pip", session_id: "backend-pip", busy: false },
    { name: "Jolly", session_id: "muse", busy: false, assistant: true },
  ], "", { id: "app-alpha", pilotId: "backend-alpha", name: "alpha" }).map((a) => a.name), ["Jolly", "pip"], "pilot session ID and canonical name both exclude self");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentNameHue, displayAgentName, messagePeerHue } from "./agentColor.ts";

test("display names are capitalized without changing Muse's routing identity", () => {
  assert.equal(displayAgentName("jolly"), "Jolly");
  assert.equal(displayAgentName("pip 2"), "Pip 2");
  assert.equal(displayAgentName("two-word_agent"), "Two-Word_Agent");
  assert.equal(displayAgentName("McFly"), "McFly", "preserve existing intentional capitalization");
});

test("message chips use the displayed agent name, even across workspaces and renames", () => {
  const agents = [
    { id: "app-pip", pilot_session_id: "pilot-pip", title: "pip", workspace_root: "/workspace/first" },
    { id: "app-juno", pilot_session_id: "pilot-juno", title: "juno", workspace_root: "/workspace/second" },
  ];
  assert.equal(messagePeerHue({ name: "pip", sessionId: "pilot-pip" }, agents), agentNameHue("Pip"));
  assert.equal(messagePeerHue({ name: "PIP", sessionId: "other-session" }, agents), agentNameHue("Pip"), "another Pip has the same hue");
  assert.equal(messagePeerHue({ name: "juno", sessionId: "pilot-juno" }, agents), agentNameHue("Juno"));
  assert.notEqual(messagePeerHue({ name: "pip", sessionId: "pilot-pip" }, agents), messagePeerHue({ name: "juno", sessionId: "pilot-juno" }, agents));
  assert.equal(messagePeerHue({ name: "old name", sessionId: "pilot-pip" }, agents), agentNameHue("old name"), "historical chips keep their displayed name's color after a rename");
  assert.equal(messagePeerHue({ name: "JUNO" }, agents), agentNameHue("juno"), "older messages without IDs use their name");
  assert.equal(messagePeerHue({ name: "departed agent" }, agents), agentNameHue("departed agent"), "deleted agents use their own name");
  assert.equal(messagePeerHue({ name: "", sessionId: "pilot-pip" }, agents), agentNameHue("pip"), "nameless legacy rows can recover the current agent name");
});

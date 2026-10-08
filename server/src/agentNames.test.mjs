import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_NAMES, RESERVED_AGENT_NAMES, isReservedAgentName, pickAgentName } from "./agentNames.ts";

test("hands out names in order; Jolly and Muse are reserved for the assistant", () => {
  assert.equal(pickAgentName([]), "Pip");
  assert.equal(pickAgentName(["Pip"]), "Juno");
  assert.equal(pickAgentName(["pip", "JUNO"]), "Milo", "taken names compare case-insensitively");
  assert.ok(!AGENT_NAMES.some((n) => isReservedAgentName(n)), "no reserved name in the list");
  for (const name of ["Jolly", "jolly", "Muse", "@muse"]) assert.equal(isReservedAgentName(name), true, name);
  assert.deepEqual([...RESERVED_AGENT_NAMES], ["muse", "jolly"]);
});

test("unique names; numbered once every base name is taken", () => {
  assert.equal(new Set(AGENT_NAMES.map((n) => n.toLowerCase())).size, AGENT_NAMES.length, "no duplicates in the list");
  assert.equal(pickAgentName(AGENT_NAMES), "Pip 2");
  assert.equal(pickAgentName([...AGENT_NAMES, "Pip 2"]), "Juno 2");
});

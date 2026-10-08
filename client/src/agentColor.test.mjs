import { test } from "node:test";
import assert from "node:assert/strict";
import { agentNameHue, displayAgentName } from "./agentColor.ts";

test("canonical lowercase names are capitalized for display without changing the identity", () => {
  for (const [identity, display] of [["pip", "Pip"], ["juno", "Juno"], ["Pip", "Pip"], ["pip 2", "Pip 2"]]) {
    assert.equal(displayAgentName(identity), display);
    assert.equal(agentNameHue(displayAgentName(identity)), agentNameHue(identity));
  }
});

test("an agent's name, not its workspace, determines its hue", () => {
  assert.equal(agentNameHue("Pip"), agentNameHue("pip"));
  assert.equal(agentNameHue(" Pip "), agentNameHue("PIP"));
  assert.equal(agentNameHue("Pip   2"), agentNameHue("pip 2"));
  assert.equal(agentNameHue("Ｐｉｐ"), agentNameHue("Pip"), "Unicode display variants share an identity");
  for (const name of ["", "Pip", "Juno", "Milo", "Lumi", "Pip 2", "A custom agent"]) {
    const hue = agentNameHue(name);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${name} → ${hue}`);
  }
});

test("different common names and numbered agents are visually distinguishable", () => {
  const pip = agentNameHue("Pip");
  assert.notEqual(pip, agentNameHue("Juno"));
  assert.notEqual(pip, agentNameHue("Pip 2"));
  assert.notEqual(agentNameHue("Juno"), agentNameHue("Milo"));
});

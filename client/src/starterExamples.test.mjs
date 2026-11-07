import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STARTER_EXAMPLES,
  buildStarterPrompt,
  resolveStarterExamplesForAvailableCompanions,
  stripStarterInstructions,
} from "./starterExamples.ts";
import { sessionTaskTitle } from "./sessionList.ts";

const sampleRoster = [
  { id: "poppy", name: "Poppy" },
  { id: "remy", name: "Remy" },
  { id: "tilly", name: "Tilly" },
  { id: "nova", name: "Nova" },
  { id: "sage", name: "Sage" },
];

test("resolveStarterExamplesForAvailableCompanions assigns Nova, Poppy, and Tilly when available and falls back when busy", () => {
  const full = resolveStarterExamplesForAvailableCompanions(sampleRoster, "Jolly");
  assert.equal(full.length, 3);
  assert.equal(full[0].label, "Build a game with Nova");
  assert.equal(full[1].label, "Build a trip overview page with Poppy");
  assert.equal(full[2].label, "Build a dynamic shopping list with Tilly");

  // If Nova is busy on an active task, the game example falls back to another available companion
  const withoutNova = sampleRoster.filter((c) => c.id !== "nova");
  const fallback = resolveStarterExamplesForAvailableCompanions(withoutNova, "Jolly");
  assert.equal(fallback.length, 3);
  assert.notEqual(fallback[0].companion.id, "nova");
  assert.equal(fallback[1].companion.id, "poppy");
  assert.equal(fallback[2].companion.id, "tilly");
});

test("buildStarterPrompt injects full playbook while stripStarterInstructions and sessionTaskTitle keep user text clean", () => {
  for (const example of STARTER_EXAMPLES) {
    const prompt = buildStarterPrompt(example, "Jolly");
    assert.ok(prompt.includes("<code-space-starter-instructions>"));
    assert.ok(prompt.includes("STEP 1 — NOTIFY JOLLY FIRST (`mcp__code_space__SendMessageToMuseAssistant`)"));
    assert.ok(prompt.includes("keep an eye on your session and unblock or give you a kick if you get stuck"));
    assert.ok(prompt.includes("mcp__code_space__AskUserRichForm"));
    assert.ok(prompt.includes("mcp__code_space__StartPreview"));
    assert.ok(prompt.includes("mcp__code_space__SendMessageToMuseAssistant"));
    assert.equal(stripStarterInstructions(prompt), example.visiblePrompt);
    assert.equal(
      sessionTaskTitle({ session_summary: null, prompt }),
      example.visiblePrompt,
    );
  }
});

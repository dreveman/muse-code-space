// Picker choices belong to the selected agent (or unsent draft), not to
// the whole App. Existing agents persist model/effort immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const actions = readFileSync(path.join(root, "../../server/src/actions.ts"), "utf8");

test("both composers show companion controls instead of model and effort pickers", () => {
  assert.equal((app.match(/<CompanionMenu/g) ?? []).length, 2);
  assert.ok(!app.includes("ModelEffortMenu"));
  assert.ok(!app.includes("choosePreference"));
  assert.ok(!app.includes("model_id: queued.model"), "the client cannot override the roster model");
  assert.ok(app.includes('storedPreference?.reasoning_effort ?? companionEffort ?? "high"'));
});

test("handoffs keep the task and use the selected companion's defaults", () => {
  assert.ok(app.includes("api.assignAgent({ id, agent_id: companionId })"));
  const action = actions.slice(actions.indexOf("assignAgent: defineAction({"), actions.indexOf("upsertSession: defineAction({"));
  assert.ok(action.includes("title: companion.name, modelId, requestedModelId: modelId, reasoningEffort: effort"));
  assert.ok(action.includes('session.status === "running" || session.status === "queued"'));
  assert.ok(action.includes("companionIsFreeCondition(session.id, companion.name)"), "checks availability again when saving");
  assert.ok(!action.includes("updatedAt:") && !action.includes("workspaceRoot:") && !action.includes(".insert(schema.outputEvents)"));
});

test("first sends use server-selected agent defaults", () => {
  assert.ok(!app.includes("model_id: queued.model") && !app.includes("reasoning_effort: queued.effort"));
  const create = actions.slice(actions.indexOf("createSession: defineAction({"), actions.indexOf("deleteSession: defineAction({"));
  assert.ok(create.includes("resolveCompanionModel(ctx, agent, models)") && create.includes("reasoningEffort: effort"));
  assert.ok(create.includes("reasoningEffortSchema.parse(agent.effort)"));
});

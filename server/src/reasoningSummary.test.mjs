import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pilotReasoningSummary } from "./pilotEvents.ts";
const root = dirname(fileURLToPath(import.meta.url));

test("only Muse's summary parts are displayed, never raw model text", () => {
  const item = { kind: "reasoning", status: "completed", summary: ["Inspect the files.", "Run the tests."], text: "PRIVATE_RAW_REASONING_MUST_NOT_BE_SHOWN" };
  assert.equal(pilotReasoningSummary(item), "Inspect the files.\n\nRun the tests.");
  assert.equal(pilotReasoningSummary({ ...item, summary: [] }), "");
  assert.equal(pilotReasoningSummary({ ...item, truncated: true }), "Inspect the files.\n\nRun the tests.\n\n(Reasoning summary truncated by Muse.)");
  assert.equal(pilotReasoningSummary({ kind: "toolCall", summary: ["Ignore"] }), null);
});

test("reasoning updates one stable transcript row without advancing activity or unread status", () => {
  const actions = readFileSync(join(root, "actions.ts"), "utf8");
  const branch = actions.slice(actions.indexOf('if (event.item?.kind === "reasoning")'), actions.indexOf('// Agent-to-agent work', actions.indexOf('if (event.item?.kind === "reasoning")')));
  assert.ok(branch.includes('eq(schema.outputEvents.itemId, itemId)'));
  assert.ok(branch.includes('kind: "thinking", content, itemId'));
  assert.ok(!branch.includes("recordActivity(") && !branch.includes("outputChanges +="));
  const visibility = readFileSync(join(root, "transcriptVisibility.ts"), "utf8");
  assert.ok(visibility.includes('event.kind !== "thinking"'));
});

test("migration retains event identities, tool details and indexes while allowing thinking", () => {
  const migration = readFileSync(join(root, "../../drizzle/0019_add_reasoning_summaries.sql"), "utf8");
  for (const required of ["'thinking'", "tool_details", "SELECT id, session_id, kind, content, created_at, item_id, started_at, finished_at, tool_details", "CREATE INDEX output_events_session_id_idx", "CREATE INDEX output_events_item_idx"]) {
    assert.ok(migration.includes(required), required);
  }
});

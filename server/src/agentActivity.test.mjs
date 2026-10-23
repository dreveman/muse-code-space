// `updated_at` is the last prompt/reply, not an "action was polled" clock.
// This checks the write sites that used to move agents around simply by
// selecting them, renaming or restoring them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, "actions.ts"), "utf8");
const migration = readFileSync(path.join(root, "../../drizzle/0015_add_agent_attention_and_restore.sql"), "utf8");
const summaryMigration = readFileSync(path.join(root, "../../drizzle/0023_unify_session_summary.sql"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("polling updates last activity only for real replies or agent messages", () => {
  const sync = section("syncPilotEvents: defineAction({", "finishSession: defineAction({");
  assert.ok(sync.includes('event.item?.kind === "agentMessage") recordActivity(itemAt)'), "agent reply advances activity");
  assert.ok(sync.includes("recordActivity(messageAt)"), "incoming and outgoing agent messages advance activity");
  assert.ok(sync.includes("recordActivity(event.at ? new Date(event.at) : new Date())"), "a question to the user is activity");
  assert.ok(sync.includes("...(activityAt ? { updatedAt: activityAt } : {})"), "empty polls leave the timestamp unchanged");
  assert.ok(!sync.includes("updatedAt: new Date()"), "selection polling must never bump activity");
});

test("metadata edits and status changes don't bump last activity", () => {
  for (const [start, end] of [
    ["setSessionProject: defineAction({", "listCustomCompanions: defineAction({"],
    ["setSessionSummary: defineAction({", "assignAgent: defineAction({"],
    ["setSessionArchived: defineAction({", "assignAgent: defineAction({"],
    ["assignAgent: defineAction({", "upsertSession: defineAction({"],
    ["finishSession: defineAction({", "getWireDebug: defineAction({"],
  ]) {
    assert.ok(!section(start, end).includes("updatedAt:"), start);
  }
  assert.ok(source.includes('args.kind === "user" || args.kind === "stdout" ? { updatedAt: now } : {}'), "legacy output advances only for a prompt/reply");
});

test("a missing summary is normal and adding one does not change last activity", () => {
  const actions = section("setSessionSummary: defineAction({", "assignAgent: defineAction({");
  assert.ok(actions.includes('summary: z.string().max(1000).nullable()'), "nullable input can clear a summary");
  assert.ok(actions.includes('args.summary?.replace(/\\s+/g, " ").trim() || null'), "empty input becomes absent");
  assert.ok(actions.includes('.set({ sessionSummary: summary })'), "only the optional summary is written");
  assert.ok(actions.includes('error: "Session not found"'), "unknown companions are not created implicitly");
  const responses = section("const sessionResponseSchema", "const eventResponseSchema");
  assert.ok(responses.includes("session_summary: z.string().nullable()"), "reads always return agent summary or null");
  assert.ok(source.includes("session_summary: row.sessionSummary"), "list and detail reads expose the dedicated column");
  assert.ok(summaryMigration.includes("RENAME COLUMN `agent_summary` TO `session_summary`"), "agent description has its own nullable column");
  assert.ok(!summaryMigration.includes("COALESCE(`summary`"), "run results are not used as session descriptions");
});

test("migration repairs old inflated timestamps and restore is separate", () => {
  assert.ok(migration.includes("MAX(`created_at`)"));
  assert.ok(migration.includes("'user', 'stdout', 'message'"));
  assert.ok(migration.includes("restored_at") && migration.includes("needs_user_input"));
  const archived = section("setSessionArchived: defineAction({", "assignAgent: defineAction({");
  assert.ok(archived.includes("restoredAt: args.archived ? null : session.archived ? now : session.restoredAt"));
});

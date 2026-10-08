import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const actions = readFileSync(join(root, "actions.ts"), "utf8");
const schema = readFileSync(join(root, "schema.ts"), "utf8");
const migration = readFileSync(join(root, "../../drizzle/0017_add_output_attention.sql"), "utf8");
const section = (start, end) => actions.slice(actions.indexOf(start), actions.indexOf(end, actions.indexOf(start)));

test("unread output and seen watermarks are separate durable metadata", () => {
  assert.ok(schema.includes('outputRevision: integer("output_revision").notNull().default(0)'));
  assert.ok(schema.includes('seenOutputRevision: integer("seen_output_revision").notNull().default(0)'));
  assert.ok(migration.includes('ADD `output_revision` integer NOT NULL DEFAULT 0'));
  assert.ok(migration.includes('ADD `seen_output_revision` integer NOT NULL DEFAULT 0'));
  assert.ok(!migration.includes('UPDATE `sessions`'), "don't mark historical transcripts unread at upgrade");
  assert.ok(actions.includes('output_revision: row.outputRevision') && actions.includes('seen_output_revision: row.seenOutputRevision'));
});

test("marking read is monotonic, bounded by the current output, and does not change updated_at", () => {
  const mark = section("markAgentSeen: defineAction({", "listProjects: defineAction({");
  assert.ok(mark.includes('sql`max(${schema.sessions.seenOutputRevision}, min(${schema.sessions.outputRevision}, ${args.output_revision}))`'));
  assert.ok(!mark.includes("updatedAt:"));
  const get = section("getSession: defineAction({", "markAgentSeen: defineAction({");
  assert.ok(get.includes('.orderBy(desc(schema.outputEvents.id))') && get.includes('events.reverse()'), "the actual transcript bottom contains the newest output");
});

test("new visible output and in-place tool updates advance a revision, not polls or user prompts", () => {
  const sync = section("syncPilotEvents: defineAction({", "finishSession: defineAction({");
  assert.ok(sync.includes('existing.content !== toolContent || existing.toolDetails !== toolDetails || (!running && !existing.finishedAt)'), "tool output/completion is a new revision even at the same event id");
  assert.ok(sync.includes('outputRevision: sql`${schema.sessions.outputRevision} + ${outputChanges}`'), "only outputChanges advance the revision");
  const append = section("appendOutput: defineAction({", "sendInput: defineAction({");
  assert.ok(append.includes('countsAsUnread(args) ? { outputRevision: sql`${schema.sessions.outputRevision} + 1` }'));
});

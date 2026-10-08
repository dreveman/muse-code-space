import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolDetails, toolDetailsFromItem } from "./toolDetails.ts";
const root = dirname(fileURLToPath(import.meta.url));

test("tool revisions keep verbatim arguments and visible output alongside the compact label", () => {
  const item = { kind: "toolCall", status: "completed", tool: "bash", args: '{"command":"echo TEST"}',
    visibleOutput: "TEST\nsecond line", truncated: true, failureReason: null,
    outputRef: { id: "out-1", byteLen: 900, availability: "available", mediaType: "text/plain" } };
  const details = toolDetailsFromItem(item);
  assert.equal(details.args, item.args);
  assert.equal(details.output, item.visibleOutput);
  assert.equal(details.outputRef.id, "out-1");
  assert.deepEqual(parseToolDetails(JSON.stringify(details)), details);
  const edit = toolDetailsFromItem({ ...item, tool: "edit_file", patchRef: { id: "patch-1", kind: "tool_patch", byteLen: 241, availability: "available", mediaType: "application/json" }, patchSummary: { files: 1, added: 2, removed: 1 } });
  assert.equal(parseToolDetails(JSON.stringify(edit)).patchRef.kind, "tool_patch");
  assert.deepEqual(edit.patchSummary, { files: 1, added: 2, removed: 1 });
  const olderJson = parseToolDetails(JSON.stringify({ args: "{}", output: null, failureReason: null, truncated: false, outputRef: null }));
  assert.equal(olderJson.tool, null);
  assert.equal(olderJson.patchRef, null);
  assert.equal(parseToolDetails(null), null);
  assert.equal(parseToolDetails("bad json"), null);
});

test("tool details migration leaves legacy rows null and full reads use DB-stored refs", () => {
  const migration = readFileSync(join(root, "../../drizzle/0018_add_tool_details.sql"), "utf8");
  const actions = readFileSync(join(root, "actions.ts"), "utf8");
  assert.ok(migration.includes('ALTER TABLE `output_events` ADD `tool_details` text'));
  assert.ok(actions.includes('toolDetails = JSON.stringify(toolDetailsFromItem(event.item))'));
  assert.ok(actions.includes('const details = parseToolDetails(event?.toolDetails ?? null)'));
  assert.ok(actions.includes('args.source === "patch" ? details?.patchRef : details?.outputRef'));
  assert.ok(actions.includes('ref.kind !== "tool_patch" || ref.mediaType !== "application/json" || ref.byteLen > 4 * 1024 * 1024'));
  assert.ok(actions.includes('eq(schema.outputEvents.sessionId, args.session_id)'));
  assert.ok(actions.includes('body: JSON.stringify({ itemId: event.itemId, outputRef: ref.id'));
});

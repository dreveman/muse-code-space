import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const pilot = readFileSync(new URL("../../pilot/pilot.mjs", import.meta.url), "utf8");

test("file tab action binds owner, app session and saved pilot session before a read-only request", () => {
  const body = actions.slice(actions.indexOf("readSessionFile: defineAction({"), actions.indexOf("openTerminal: defineAction({"));
  assert.ok(body.includes('terminalAccessError(ctx.viewer, "file")'));
  assert.ok(body.includes("eq(schema.sessions.id, args.session_id)"));
  assert.ok(body.includes("if (!session?.pilotSessionId)"));
  assert.ok(body.includes("/sessions/${encodeURIComponent(session.pilotSessionId)}/files/read"));
  assert.ok(body.includes('method: "POST", body: JSON.stringify({ path: args.path })'));
  assert.ok(body.includes('error.message.trim() === "not found"') && body.includes('Restart the service to enable file tabs.'), "older services report an actionable version mismatch, not a mysterious 404");
  assert.ok(!body.includes("readFileSync") && !body.includes("writeFileSync"));
  assert.ok(pilot.includes("readWorkspaceFile(entry.meta.workspaceRoot, body.path)"), "the browser cannot choose a workspace root");
});

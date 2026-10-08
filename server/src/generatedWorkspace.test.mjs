import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isGeneratedWorkspaceRoot, shortWorkspaceToken } from "./generatedWorkspace.ts";
const root = "/home/hatch/workspace";

test("only a matching short auto-generated workspace is subject to collision checks", () => {
  assert.ok(isGeneratedWorkspaceRoot("manual-12345-a1b2c3d4e5f6", `${root}/code/a1b2c3d4e5f6`, root));
  for (const [id, path] of [
    ["manual-12345-a1b2c3d4e5f6", `${root}/code/a1b2c3d4e5f7`],
    ["manual-12345-a1b2c3d4e5f6", `${root}/a1b2c3d4e5f6`], // saved old path remains custom
    ["manual-12345-a1b2c3d4e5f6", `${root}/projects/a1b2c3d4e5f6`],
    ["manual-12345-a1b2c3d4e5f6", `${root}/muse-sessions/manual-12345-a1b2c3d4e5f6`],
    ["custom", `${root}/code/a1b2c3d4e5f6`],
  ]) assert.ok(!isGeneratedWorkspaceRoot(id, path, root));
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.ok(actions.includes("isGeneratedWorkspaceRoot(args.session_id, workspace.path, WORKSPACE_ROOT)"));
  assert.ok(actions.includes("eq(schema.sessions.workspaceRoot, workspace.path)"));
  assert.ok(actions.includes("generatedWorkspace: row.workspaceRoot === null || isGeneratedWorkspaceRoot(row.id, row.workspaceRoot, WORKSPACE_ROOT)"));
  assert.ok(actions.includes('return `${WORKSPACE_ROOT}/code/${shortWorkspaceToken(sessionId)}`'), "only null rows use the short fallback");
  assert.match(shortWorkspaceToken('old-session'), /^[0-9a-f]{12}$/);
  assert.equal(shortWorkspaceToken('old-session'), shortWorkspaceToken('old-session'));
  assert.notEqual(shortWorkspaceToken('old-session'), shortWorkspaceToken('different-session'));
  assert.ok(actions.includes('workspaceRoot: row.workspaceRoot ?? defaultWorkspaceRoot(row.id)'), "saved older/custom paths take precedence over the new default");
  const pilot = readFileSync(new URL("../../pilot/pilot.mjs", import.meta.url), "utf8");
  assert.ok(pilot.includes('meta?.workspaceRoot ?? defaultWorkspacePath(meta?.appSessionId ?? id)'), "pilot recovery retains the recorded path");
});

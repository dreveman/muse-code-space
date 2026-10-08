import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { confirmedWritePath, ownedArtifactPaths } from "./ownedArtifacts.ts";
import { parseToolDetails } from "./toolDetails.ts";
const root = "/workspace/agent-id";
const details = (path, content, outputPath = `${root}/${path}`, extra = {}) => ({
  tool: "write_file", status: "completed", args: JSON.stringify({ path, content }),
  output: `wrote ${Buffer.byteLength(content)} bytes to ${outputPath}`,
  failureReason: null, truncated: false, outputRef: null, patchRef: null, patchSummary: null, ...extra,
});
const row = (item) => ({ toolDetails: JSON.stringify(item) });

test("only a byte- and path-confirmed write owns a safe relative workspace file", () => {
  assert.equal(confirmedWritePath(details("src/hello.ts", "hi\n"), root), "src/hello.ts");
  assert.equal(confirmedWritePath(details(`${root}/src/hello.ts`, "hi\n", `${root}/src/hello.ts`), root), "src/hello.ts");
  for (const bad of [
    details("src/hello.ts", "hi\n", `${root}/other.ts`),
    details("src/hello.ts", "hi\n", `${root}/src/hello.ts`, { output: "wrote 10 bytes to src/hello.ts" }),
    details("../secret", "x"), details("/elsewhere/file.ts", "x"),
    details("src/hello.ts", "x", `${root}/src/hello.ts`, { status: "failed" }),
    details("src/hello.ts", "x", `${root}/src/hello.ts`, { truncated: true }),
    details("src/hello.ts", "x", `${root}/src/hello.ts`, { tool: "read_file" }),
    details("src/hello.ts", "x", `${root}/src/hello.ts`, { tool: "edit_file" }),
  ]) assert.equal(confirmedWritePath(bad, root), null);
});

test("durable tool rows dedupe newest writes and never infer ownership from reads or edits", () => {
  const rows = [row(details("src/new.ts", "new")), row(details("src/old.ts", "old")),
    row(details("src/new.ts", "earlier")), row(details("read.ts", "x", `${root}/read.ts`, {tool:"read_file"})),
    row(details("edit.ts", "x", `${root}/edit.ts`, {tool:"edit_file"})), {toolDetails:"not-json"}];
  assert.deepEqual(ownedArtifactPaths(rows, root, parseToolDetails), ["src/new.ts", "src/old.ts"]);
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.ok(actions.includes('listOwnedArtifacts: defineAction({'));
  assert.ok(actions.includes('isNotNull(schema.outputEvents.toolDetails)'));
  assert.ok(actions.includes('terminalAccessError(ctx.viewer, "file")'));
});

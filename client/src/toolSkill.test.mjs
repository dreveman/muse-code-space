import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { skillPreviewForTool, toolPresentation } from "./toolPresentation.ts";

const SKILL = ["---", "name: demo-review", "description: Review a change for correctness.", "---", "", "# Demo review", "", "Check the diff, then run the tests.", "", "| Step | Check |", "| --- | --- |", "| 1 | Tests |"].join("\n");
const details = (tool, args, output, status = "completed") => ({ tool, status, args, output,
  failureReason: null, truncated: false, outputRef: null, patchRef: null, patchSummary: null });
const ctx = (d) => ({ label: `${d.tool} · old label`, details: d, running: d.status === "inProgress", workspaceRoot: "/tmp/session" });

test("read_skill parses frontmatter and body from a verified skill document", () => {
  const d = details("read_skill", '{"name":"bundled:demo-review"}', SKILL);
  const preview = skillPreviewForTool(d);
  assert.equal(preview.name, "demo-review");
  assert.equal(preview.scope, "bundled");
  assert.equal(preview.description, "Review a change for correctness.");
  assert.ok(preview.body.startsWith("# Demo review"));
  assert.equal(preview.lines, 7);
});

test("read_skill without frontmatter still renders the body", () => {
  const preview = skillPreviewForTool(details("read_skill", '{"name":"demo"}', "# Demo\n\nBody text."));
  assert.equal(preview.name, "demo");
  assert.equal(preview.scope, null);
  assert.equal(preview.description, null);
  assert.equal(preview.body, "# Demo\n\nBody text.");
});

test("read_skill preview fails closed on unverified input", () => {
  assert.equal(skillPreviewForTool(details("read_skill", '{"name":"demo"}', "")), null, "empty output");
  assert.equal(skillPreviewForTool(details("read_skill", '{"name":"demo"}', SKILL, "failed")), null, "failed reads");
  assert.equal(skillPreviewForTool(details("read_skill", '{broken', SKILL)), null, "bad args");
  assert.equal(skillPreviewForTool(details("read_skill", '{"name":""}', SKILL)), null, "missing skill name");
  assert.equal(skillPreviewForTool(details("read_file", '{"name":"demo"}', SKILL)), null, "other tools");
});

test("read_skill gets a friendly label, skill view and size metric", () => {
  const d = details("read_skill", '{"name":"bundled:demo-review"}', SKILL);
  const done = toolPresentation(ctx(d));
  assert.equal(done.adapterId, "skill");
  assert.equal(done.name, "Read skill");
  assert.equal(done.detail, "bundled:demo-review");
  assert.equal(done.view, "skill");
  assert.equal(done.showDuration, false);
  assert.equal(done.metric, "7 lines");
  assert.equal(toolPresentation(ctx({ ...d, status: "inProgress" })).name, "Reading skill");
});

test("the skill view renders Markdown in the tool row", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("skillPreviewForTool(displayDetails)"));
  assert.ok(app.includes("<Markdown text={skillBody}"), "skill body renders as Markdown, not raw text");
  assert.ok(app.includes("!skillPreview"), "raw output is suppressed when the skill view renders");
});

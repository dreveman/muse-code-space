import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { todosPreviewForTool, toolPresentation } from "./toolPresentation.ts";

const ARGS = JSON.stringify({ todos: [
  { text: "Inspect the diff", status: "completed" },
  { text: "Add the parser", status: "completed" },
  { text: "Wire the view", status: "in_progress" },
  { text: "Run the tests", status: "pending" },
  { text: "Write release notes", status: "cancelled" },
] });
const details = (tool, args, status = "completed", failureReason = null) => ({ tool, status, args,
  output: "ok", failureReason, truncated: false, outputRef: null, patchRef: null, patchSummary: null });
const ctx = (d) => ({ label: `${d.tool} · old label`, details: d, running: d.status === "inProgress", workspaceRoot: "/tmp/session" });

test("write_todos parses the full plan from its args", () => {
  const preview = todosPreviewForTool(details("write_todos", ARGS));
  assert.equal(preview.total, 5);
  assert.equal(preview.done, 2);
  assert.equal(preview.active?.text, "Wire the view");
  assert.deepEqual(preview.items.map((item) => item.status), ["completed", "completed", "in_progress", "pending", "cancelled"]);
});

test("write_todos renders from args while the call is still running", () => {
  const preview = todosPreviewForTool(details("write_todos", ARGS, "inProgress"));
  assert.equal(preview.total, 5, "the plan being written is already meaningful");
});

test("write_todos preview fails closed on unverified input", () => {
  assert.equal(todosPreviewForTool(details("write_todos", ARGS, "failed", "nope")), null, "failed calls");
  assert.equal(todosPreviewForTool(details("write_todos", "{broken")), null, "bad args");
  assert.equal(todosPreviewForTool(details("write_todos", '{"todos":[]}')), null, "empty plan");
  assert.equal(todosPreviewForTool(details("write_todos", '{"todos":[{"text":"x","status":"doing"}]}')), null, "unknown status");
  assert.equal(todosPreviewForTool(details("write_todos", '{"todos":[{"status":"pending"}]}')), null, "missing text");
  assert.equal(todosPreviewForTool(details("read_file", ARGS)), null, "other tools");
});

test("write_todos gets a friendly label, active detail and progress metric", () => {
  const done = toolPresentation(ctx(details("write_todos", ARGS)));
  assert.equal(done.adapterId, "todos");
  assert.equal(done.name, "Updated plan");
  assert.equal(done.detail, "Wire the view");
  assert.equal(done.view, "todos");
  assert.equal(done.showDuration, false);
  assert.equal(done.metric, "2/5 done");
  assert.equal(toolPresentation(ctx(details("write_todos", ARGS, "inProgress"))).name, "Updating plan");
  assert.equal(toolPresentation(ctx(details("write_todos", ARGS, "failed", "nope"))).name, "Plan update failed");
});

test("the todos view renders a checklist in the tool row", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("./RenderedToolTodos.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(app.includes("todosPreviewForTool(displayDetails)") && app.includes("<ToolTodosView preview={todosPreview}"));
  assert.ok(component.includes("tool-todos-item") && component.includes("in_progress"), "checklist rows are keyed by status");
  assert.ok(css.includes(".tool-todos-item.is-completed") && css.includes(".tool-todos-item.is-active"));
});

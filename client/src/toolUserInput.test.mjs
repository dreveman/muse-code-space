// Tests for the formatted request_user_input tool view.
// Run: node --test client/src/toolUserInput.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toolPresentation, userInputPreviewForTool } from "./toolPresentation.ts";

const ARGS = JSON.stringify({
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "How much should we change?",
      selection: { mode: "single" },
      options: [
        { label: "Small fix", description: "Only the reported issue" },
        { label: "Full pass", description: "Include nearby cleanup", preview: { format: "markdown", content: "More files touched." } },
      ],
    },
    {
      id: "checks",
      header: "Checks",
      question: "Which checks should run?",
      selection: { mode: "multiple", minSelections: 1, maxSelections: 2 },
      options: [{ label: "Unit tests" }, { label: "Typecheck" }, { label: "Browser pass" }],
    },
    {
      id: "notes",
      header: "Notes",
      question: "Anything else?",
      selection: { mode: "single" },
      options: [],
    },
  ],
});
const OUTPUT = JSON.stringify({
  answers: [
    { questionId: "scope", selectedLabel: "Full pass" },
    { questionId: "checks", selectedLabels: ["Unit tests", "Typecheck"] },
    { questionId: "notes", freeText: "Keep it Friday-friendly.", note: "No rush" },
  ],
});
const details = (tool, args, status = "completed", output = OUTPUT, failureReason = null) => ({
  tool, status, args, output, failureReason, truncated: false, outputRef: null, patchRef: null, patchSummary: null,
});
const ctx = (d) => ({ label: `${d.tool} · old label`, details: d, running: d.status === "inProgress", workspaceRoot: "/tmp/session" });

test("request_user_input parses questions, options and answers from the tool call", () => {
  const preview = userInputPreviewForTool(details("request_user_input", ARGS));
  assert.equal(preview.total, 3);
  assert.equal(preview.answered, 3);
  assert.equal(preview.questions[0].header, "Scope");
  assert.equal(preview.questions[0].mode, "single");
  assert.equal(preview.questions[0].options[1].preview, "More files touched.");
  assert.deepEqual(preview.questions[0].answer, { labels: ["Full pass"], freeText: null, note: null });
  assert.deepEqual(preview.questions[1].answer.labels, ["Unit tests", "Typecheck"]);
  assert.equal(preview.questions[2].answer.freeText, "Keep it Friday-friendly.");
  assert.equal(preview.questions[2].answer.note, "No rush");
});

test("request_user_input renders from args while the call is still waiting", () => {
  const preview = userInputPreviewForTool(details("request_user_input", ARGS, "inProgress", ""));
  assert.equal(preview.total, 3);
  assert.equal(preview.answered, 0);
  assert.equal(preview.questions[0].answer, null);
});

test("request_user_input accepts a bare answers array as output", () => {
  const preview = userInputPreviewForTool(details("request_user_input", ARGS, "completed",
    JSON.stringify([{ questionId: "scope", selectedLabels: ["Small fix"] }])));
  assert.equal(preview.answered, 1);
  assert.deepEqual(preview.questions[0].answer.labels, ["Small fix"]);
});

test("request_user_input preview fails closed on unverified input", () => {
  assert.equal(userInputPreviewForTool(details("request_user_input", ARGS, "failed", OUTPUT, "nope")), null, "failed calls");
  assert.equal(userInputPreviewForTool(details("request_user_input", "{broken")), null, "bad args");
  assert.equal(userInputPreviewForTool(details("request_user_input", '{"questions":[]}')), null, "no questions");
  assert.equal(userInputPreviewForTool(details("request_user_input", '{"questions":[{"question":"Missing id"}]}')), null, "missing id");
  assert.equal(userInputPreviewForTool(details("request_user_input", '{"questions":[{"id":"q","question":"Q?","selection":{"mode":"ranked"}}]}')), null, "unknown mode");
  assert.equal(userInputPreviewForTool(details("request_user_input", '{"questions":[{"id":"q","question":"Q?","options":[{"description":"no label"}]}]}')), null, "option without label");
  assert.equal(userInputPreviewForTool(details("read_file", ARGS)), null, "other tools");
});

test("request_user_input gets a friendly label, first-question detail and answer metric", () => {
  const done = toolPresentation(ctx(details("request_user_input", ARGS)));
  assert.equal(done.adapterId, "user-input");
  assert.equal(done.name, "Asked you");
  assert.equal(done.detail, "Scope");
  assert.equal(done.view, "user-input");
  assert.equal(done.metric, "3/3 answered");
  const waiting = toolPresentation(ctx(details("request_user_input", ARGS, "inProgress", "")));
  assert.equal(waiting.name, "Asking you");
  assert.equal(waiting.metric, "3 questions");
  assert.equal(toolPresentation(ctx(details("request_user_input", ARGS, "failed", "", "nope"))).name, "Question failed");
});

test("the user-input view renders questions and answers in the tool row", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("./RenderedToolUserInput.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(app.includes("userInputPreviewForTool(displayDetails)") && app.includes("<ToolUserInputView preview={userInputPreview}"));
  assert.ok(component.includes("tool-user-input-option is-selected") || component.includes("is-selected"), "answered options are marked");
  assert.ok(component.includes("Your answer"), "free-text answers are labelled");
  assert.ok(css.includes(".tool-user-input-question") && css.includes(".tool-user-input-option.is-selected"));
});

// Agent-to-agent work in the transcript: workflow/subagent items become one
// live agents row (server) that the UI renders and keeps syncing (client).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pilotAgentsRow, pilotItemText, pilotSystemText } from "../../server/src/pilotEvents.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");

test("real muse 1.4 child updates: labels carry over, progress steps are 'running', terminal is the outcome", async () => {
  const { workflowMessageText } = await import("../../server/src/pilotEvents.ts");
  const first = pilotAgentsRow({ kind: "workflow", status: "inProgress", entryId: "alpha-beta parallel", workflowRunId: "r", children: [
    { childId: "a", attempt: 1, status: "scheduled", label: "alpha" },
  ] });
  assert.deepEqual(first.children.map((c) => [c.label, c.status, c.phase]), [["alpha", "running", "scheduled"]]);
  const later = pilotAgentsRow({ kind: "workflow", status: "inProgress", children: [
    { childId: "a", attempt: 1, status: "usage" },
    { childId: "b", attempt: 1, status: "started" },
  ] }, first);
  assert.deepEqual(later.children.map((c) => [c.label, c.status]), [["alpha", "running"], ["helper 2", "running"]], "label carried over; usage/started still running");
  assert.equal(later.workflowRunId, "r", "run id carried over");
  const done = pilotAgentsRow({ kind: "workflow", status: "completed", children: [
    { childId: "a", attempt: 1, status: "terminal", terminal: "completed", durationMs: 1324 },
    { childId: "b", attempt: 1, status: "terminal", terminal: "failed", durationMs: 99 },
  ], message: '<workflow-launch-reconciled>{"type":"workflow_launch_reconciled","final_summary":{"status":"completed","summary":"ALPHA\\nBETA"},"latest_failure":null}</workflow-launch-reconciled>' }, later);
  assert.deepEqual(done.children.map((c) => [c.label, c.status, c.durationMs]), [["alpha", "completed", 1324], ["helper 2", "failed", 99]]);
  assert.equal(done.message, "ALPHA\nBETA", "the envelope's final summary, not raw JSON");
  assert.equal(workflowMessageText("plain text"), "plain text");
  assert.equal(workflowMessageText('<x>{"final_summary":null,"latest_failure":{"message":"boom"}}</x>'), "boom");
});

test("a workflow item becomes an agents row; latest attempt per child", () => {
  const row = pilotAgentsRow({
    kind: "workflow", status: "inProgress", entryId: "Alpha Beta parallel", workflowRunId: "run-1",
    children: [
      { childId: "a", attempt: 1, label: "alpha", status: "failed" },
      { childId: "a", attempt: 2, label: "alpha", status: "running", phase: "model" },
      { childId: "b", attempt: 1, label: "beta", status: "completed", durationMs: 2900 },
    ],
  });
  assert.equal(row.kind, "workflow");
  assert.equal(row.title, "Alpha Beta parallel");
  assert.equal(row.workflowRunId, "run-1");
  assert.deepEqual(row.children.map((c) => [c.id, c.attempt, c.status, c.durationMs]), [["a", 2, "running", null], ["b", 1, "completed", 2900]]);
  assert.equal(pilotItemText({ kind: "workflow", status: "completed", fallbackText: "Workflow: x" }), null, "no duplicate text line");
});

test("a subagent item becomes an agents row with its result", () => {
  const row = pilotAgentsRow({ kind: "subagent", status: "completed", objective: "Check the tests", subagentId: "s-1", result: { summary: "All green" } });
  assert.deepEqual([row.kind, row.title, row.subagentId, row.message], ["subagent", "Check the tests", "s-1", "All green"]);
  assert.equal(pilotAgentsRow({ kind: "toolCall", status: "completed" }), null);
});

test("host-started turns are announced in the transcript", () => {
  assert.match(pilotSystemText({ seq: 1, type: "host_turn_started" }), /continued on its own/);
});

test("the UI renders agents rows and keeps syncing while agents run", () => {
  assert.ok(app.includes('event.kind === "agents" ? ('), "transcript renders agents rows");
  assert.ok(app.includes("const liveWork = !detailSession?.archived && (sessionActive || agentsRunning);"));
  assert.ok(/\}, \[selectedId, queuedSessionId, liveWork\]\);/.test(app), "sync loop runs while agents run and while another task has a queued prompt");
  const block = readFileSync(path.join(root, "AgentsEvent.tsx"), "utf8");
  assert.ok(block.includes("api.cancelWorkflow("), "Stop control");
  assert.ok(!block.includes("readAgentResult"), "no subagent/readResult (it's a steering command for the agent)");
});

test("agent messages render with their sender; Muse is unmistakable", () => {
  assert.ok(app.includes('event.kind === "message" ? ('), "transcript renders message rows");
  const component = app.slice(app.indexOf("function MessageEvent("), app.indexOf("// Keep the sidebar selection and chat header"));
  assert.ok(component.includes('<AssistantMessageAvatar source={assistantAvatar} />') && component.includes("your Muse assistant"), "assistant messages use only the Muse mark, without the Code >");
  assert.ok(component.includes("{displayAgentName(peer.name)}"), "From/To labels capitalize agent names");
  assert.ok(component.includes("messagePeerHue(peer, agents)"), "the peer name chip uses its name-derived hue");
  assert.ok(component.includes('<article className={`output-event message'), "the message surface sits on the full-width transcript row");
  assert.ok(app.includes("{!markOnly && <path fill=\"#0082FB\""), "the blue > path is omitted from mark-only icons");
  assert.ok(app.includes("<CompanionMenu"), "composer controls belong to the companion");
  assert.ok(component.includes("assistantColorStyle(peer.color)"), "in the assistant's theme color");
  assert.ok(component.includes('message.direction === "in" ? "From" : "To"'));
  const css = readFileSync(path.join(root, "theme.css"), "utf8");
  const messageCss = css.slice(css.indexOf("/* From/To messages"), css.indexOf(".agents-block {"));
  assert.ok(/\.output-event\.message\s*\{[^}]*background:\s*var\(--terminal-user-bg\)/.test(messageCss), "all message rows use the manual-prompt surface");
  const promptToolGap = css.match(/\.output-event\.user \+ \.output-event\.tool\s*\{\s*margin-top:\s*(\d+)px/)?.[1];
  const messageGap = messageCss.match(/\.output-event\.message \+ \.output-event:not\(\.message\)\s*\{\s*margin-top:\s*(\d+)px/)?.[1];
  assert.equal(messageGap, promptToolGap, "message rows use the same gap as a user prompt followed by a tool");
  assert.ok(messageCss.includes(".output-event + .output-event.message,"), "gap also precedes a message, but not the first row");
  assert.ok(/\.output-event\.message\.muse-incoming\s*\{[^}]*var\(--assistant-color/.test(messageCss), "only incoming assistant messages use its blue color");
  assert.ok(!/box-shadow:|border-left:/.test(messageCss), "messages have no colored left highlight");
  assert.ok(/\.agent-message\s*\{[^}]*display:\s*grid;[^}]*\}/.test(messageCss), "message content has no extra inner padding");
  const actions = readFileSync(path.join(root, "../../server/src/actions.ts"), "utf8");
  assert.ok(actions.includes("sessionId: event.from.sessionId") && actions.includes("sessionId: event.to.sessionId"), "message rows retain pilot identities to match colors after renames");
  for (const action of ["sendAgentMessage: defineAction", "listAgents: defineAction", "readMuseMessages: defineAction"]) assert.ok(actions.includes(action), action);
  assert.ok(actions.includes('JSON.stringify({ from: "muse", to: args.to, text: args.text })'), "the app's messages are sent as Muse");
});

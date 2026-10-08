import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_PREVIEW_LINES, hasStoredOutputBeyondView, toolTranscriptLines } from "./toolTranscript.ts";
const root = dirname(fileURLToPath(import.meta.url));

const details = (output, truncated = false) => ({
  args: JSON.stringify({ command: "echo TEST" }), output, truncated, failureReason: null,
  outputRef: { id: "ref-1", byteLen: 5000, availability: "available", mediaType: "text/plain" },
});

test("tool transcript includes complete arguments and a bounded initial preview", () => {
  const lines = toolTranscriptLines(details(Array.from({ length: 32 }, (_, i) => `line ${i + 1}`).join("\n")), false);
  assert.ok(lines.join("\n").includes('"command": "echo TEST"'));
  assert.ok(toolTranscriptLines(details("ok"), false, null, true).join("\n").includes('{"command":"echo TEST"}'), "global raw mode keeps verbatim arguments");
  assert.ok(lines.includes("line 32"), "all visible lines are retained for explicit expansion");
  assert.equal(TOOL_PREVIEW_LINES, 12);
  assert.equal(lines.slice(0, TOOL_PREVIEW_LINES).length, 12);
  assert.ok(hasStoredOutputBeyondView(details("short output", true), null), "truncated stored output needs an explicit fetch");
  assert.equal(hasStoredOutputBeyondView(details("short output", true), "all the bytes"), false);
});

test("legacy calls and unavailable stored bytes explain the gap instead of claiming full output", () => {
  assert.match(toolTranscriptLines(null, false).join(""), /not recorded/);
  const unavailable = { ...details("first lines", true), outputRef: { ...details("").outputRef, availability: "missing" } };
  assert.ok(toolTranscriptLines(unavailable, false).join("\n").includes("full bytes are unavailable"));
  assert.equal(hasStoredOutputBeyondView(unavailable, null), false);
  assert.ok(toolTranscriptLines({ ...details(null), outputRef: null }, true).join("\n").includes("waiting for output"));
});

test("tool UI has a separate row button, bounded preview, and explicit show-all control", () => {
  const app = readFileSync(join(root, "App.tsx"), "utf8");
  const css = readFileSync(join(root, "theme.css"), "utf8");
  assert.ok(app.includes('className="tool-row tool-trigger"') && app.includes('aria-expanded={expanded}'));
  assert.ok(app.includes('lines.slice(0, TOOL_PREVIEW_LINES)') && app.includes('"Show all output"'));
  assert.ok(app.includes('api.readToolOutputPage({ session_id: sessionId, event_id: eventId, offset_bytes: offset, source: "output" })'));
  assert.ok(/\.tool-trigger:hover[^}]*background:\s*color-mix/.test(css), "the inner row, not its whole output box, highlights");
  assert.ok(/\.tool-trigger\s*\{[^}]*width:\s*calc\(100% \+ 20px\);\s*margin:\s*-5px -10px;\s*padding:\s*5px 10px/.test(css), "the inset button gains 2px horizontally and 1px vertically");
  const toolShade = Number(css.match(/\.output-event\.tool\s*\{[^}]*black (\d+)%/)?.[1]);
  assert.ok(toolShade >= 5 && toolShade <= 7, "tool box is a little lighter, but remains distinct from the user prompt background");
  assert.ok(/\.tool-transcript pre\s*\{[^}]*white-space:\s*pre-wrap/.test(css));
});

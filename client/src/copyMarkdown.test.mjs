// Run: node --test client/src/copyMarkdown.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

test("each agent response has a Copy markdown button beside its timestamp", () => {
  const button = readFileSync(new URL("./CopyMarkdownButton.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("<CopyMarkdownButton text={event.content} />"), "copies the raw event content, not the display-transformed text");
  assert.ok(app.includes('className="message-time-row"'), "the button sits in the timestamp row");
  assert.ok(button.includes("copyTextToClipboard(text)"), "copying uses the shared clipboard helper");
  assert.ok(button.includes('title={copied ? "Copied" : "Copy markdown"}'), "tooltip says Copy markdown");
  assert.ok(button.includes("CopiedCodeIcon") || button.includes('m3 8.5 3.2 3.2L13 5'), "copied state shows the check icon");
});

test("the Copy markdown button is smaller than the code block button and follows the same visibility policy", () => {
  assert.ok(css.includes(".message-copy-markdown {"), "button style exists");
  const rule = /\.message-copy-markdown \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(rule.includes("width: 18px; height: 18px;"), "smaller button than the 24px code block button");
  assert.ok(css.includes(".message-copy-markdown svg { width: 11px; height: 11px; }"), "smaller icon to match the 9px timestamp");
  assert.ok(css.includes(".message-time-row:hover .message-copy-markdown"), "hovering the timestamp row reveals the button on fine pointers");
  assert.ok(!css.includes(".output-event:hover .message-copy-markdown"), "hovering the rest of the response does not reveal it");
  assert.ok(css.includes(".message-time-row { display: flex; align-items: center; gap: 4px; width: fit-content;"), "the hover area is only as wide as the timestamp and button");
  // Always visible by default (touch); only hidden under the fine-pointer media query.
  const mediaIndex = css.indexOf("@media (hover: hover) and (pointer: fine)", css.indexOf(".message-copy-markdown"));
  assert.ok(mediaIndex > 0 && css.slice(mediaIndex, mediaIndex + 400).includes(".message-copy-markdown { opacity: 0; }"), "hidden only on hover-capable fine pointers");
});

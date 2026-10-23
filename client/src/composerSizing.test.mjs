import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSER_MAX_HEIGHT, resizeComposerTextarea } from "./composerSizing.ts";
const root = dirname(fileURLToPath(import.meta.url));

test("textarea grows with newlines, caps at a readable height, and shrinks again", () => {
  let contentHeight = 48;
  const input = { style: { height: "48px", overflowY: "hidden" }, get scrollHeight() {
    assert.equal(this.style.height, "auto", "measure the full content instead of the previous fixed height");
    return contentHeight;
  } };
  resizeComposerTextarea(input);
  assert.equal(input.style.height, "48px");
  contentHeight = 112;
  resizeComposerTextarea(input);
  assert.equal(input.style.height, "112px");
  assert.equal(input.style.overflowY, "hidden");
  contentHeight = 410;
  resizeComposerTextarea(input);
  assert.equal(COMPOSER_MAX_HEIGHT, 240);
  assert.equal(input.style.height, "240px");
  assert.equal(input.style.overflowY, "auto", "extra lines remain accessible by scrolling");
  contentHeight = 70;
  resizeComposerTextarea(input);
  assert.equal(input.style.height, "70px");
  assert.equal(input.style.overflowY, "hidden");
  // When constrained by a short mobile viewport (e.g. 386px above the virtual keyboard),
  // the textarea caps below 240px so `.terminal-composer` never overflows under the keyboard.
  contentHeight = 240;
  resizeComposerTextarea(input, 386);
  assert.equal(input.style.height, "191px");
  assert.equal(input.style.overflowY, "auto");
});

test("both draft and existing-agent composers autosize on text and pane changes", () => {
  const app = readFileSync(join(root, "App.tsx"), "utf8");
  const css = readFileSync(join(root, "theme.css"), "utf8");
  assert.ok(app.includes("draftSelected ? draftInputRef.current : takeoverInputRef.current"));
  assert.ok(app.includes("useLayoutEffect(() => {") && app.includes("resizeComposerTextarea(input)"));
  assert.ok(app.includes("[direction, selectedId, draftSelected, viewportWidth, paneSizes.sidebarWidth, paneSizes.chatShare, hasSidePanel, selectedCompanionId]"));
  assert.ok(/\.terminal-prompt textarea\s*\{[^}]*max-height:\s*240px/.test(css));
});

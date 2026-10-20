// The attachment affordance: every composer gets a paperclip button next
// to the voice button that opens a native file picker for images.
// Run: node --test client/src/attachmentButton.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const css = readFileSync(path.join(root, "theme.css"), "utf8");

test("attachment icon is defined", () => {
  assert.ok(app.includes("function AttachmentIcon()"), "expected an AttachmentIcon component");
});

test("both composers render the attachment button next to the voice button", () => {
  const attachments = [...app.matchAll(/<AttachmentButton \/>/g)];
  assert.equal(attachments.length, 2, "expected the attachment button in both composers");
  const voices = [...app.matchAll(/className=\{`composer-icon voice-button/g)];
  assert.equal(voices.length, 2, "expected the voice button in both composers");
  for (let i = 0; i < 2; i += 1) {
    assert.ok(
      attachments[i].index < voices[i].index,
      "attachment button must sit immediately before the voice button",
    );
  }
});

test("attachment button opens a hidden image file picker", () => {
  assert.ok(
    /className="composer-icon attachment-button"/.test(app),
    "expected a composer-icon attachment-button",
  );
  assert.ok(app.includes('aria-label="Attach files"'), "button needs an accessible label");
  assert.ok(
    /onClick=\{\(\) => fileInputRef\.current\?\.click\(\)\}/.test(app),
    "clicking the button must open the file picker",
  );
  assert.ok(
    /<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*multiple[^>]*hidden/.test(app),
    "expected a hidden file input accepting multiple images",
  );
});

test("attachment button shares the voice button styling", () => {
  assert.ok(
    /\.attachment-button\s*[,{]/.test(css),
    "expected .attachment-button rules in theme.css",
  );
});

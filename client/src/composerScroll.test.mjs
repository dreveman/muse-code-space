// Growing the composer must not unpin a transcript that was at its
// bottom. Run: node --test client/src/composerScroll.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("composer resizing re-pins a followed transcript bottom", () => {
  const sizing = app.slice(app.indexOf("const input = draftSelected ? draftInputRef.current"));
  assert.ok(sizing.includes("followTranscriptRef.current && transcriptAtBottom(body)"), "following state is snapshotted before the resize");
  assert.ok(sizing.indexOf("transcriptAtBottom(body)") < sizing.indexOf("resizeComposerTextarea(input)"), "snapshot precedes resize");
  assert.ok(sizing.includes("requestAnimationFrame") && sizing.includes("body.scrollTop = body.scrollHeight"),
    "the bottom is re-pinned after the shrunken layout settles");
  assert.ok(sizing.includes("setShowScrollToBottom(false)"), "no spurious Scroll to bottom button");
  assert.ok(!sizing.includes("if (!followTranscriptRef.current) return;\n      body.scrollTop"), "layout-induced scroll events cannot veto the re-pin");
});

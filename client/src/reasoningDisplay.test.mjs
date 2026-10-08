import { test } from "node:test";
import assert from "node:assert/strict";
import { reasoningDisplay } from "./reasoningDisplay.ts";

test("stored truncation note becomes separate presentation metadata", () => {
  assert.deepEqual(
    reasoningDisplay("Inspect the files.\n\n(Reasoning summary truncated by Muse.)"),
    { summary: "Inspect the files.", truncated: true },
  );
  assert.deepEqual(reasoningDisplay("Inspect the files."), { summary: "Inspect the files.", truncated: false });
  assert.deepEqual(reasoningDisplay(""), { summary: "", truncated: false });
  assert.deepEqual(reasoningDisplay("(Reasoning summary truncated by Muse.)"), {
    summary: "(Reasoning summary truncated by Muse.)", truncated: false,
  }, "ordinary summary content is not removed without the exact stored suffix");
});

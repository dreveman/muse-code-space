// Tests for the project briefing builder.
// Run: node --test server/src/projectBriefing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjectBriefing, withProjectBriefing } from "./projectBriefing.ts";

test("returns null when there is nothing to brief", () => {
  assert.equal(
    buildProjectBriefing({ name: "P", description: "  ", references: [] }),
    null,
  );
  assert.equal(
    buildProjectBriefing({
      name: "P",
      description: "",
      references: [{ label: "  ", target: "x" }],
    }),
    null,
  );
});

test("briefs description only", () => {
  assert.equal(
    buildProjectBriefing({ name: "Perfetto", description: "Trace viewer.", references: [] }),
    "[Project: Perfetto]\nTrace viewer.",
  );
});

test("briefs references only", () => {
  assert.equal(
    buildProjectBriefing({
      name: "P",
      description: "",
      references: [
        { label: "Docs", target: "https://example.com/docs" },
        { label: "Repo", target: "~/workspace/perfetto" },
      ],
    }),
    "[Project: P]\nReferences:\n- Docs: https://example.com/docs\n- Repo: ~/workspace/perfetto",
  );
});

test("withProjectBriefing joins with a separator", () => {
  assert.equal(
    withProjectBriefing("Do the thing", "[Project: P]\nContext here."),
    "[Project: P]\nContext here.\n\n---\n\nDo the thing",
  );
});

test("withProjectBriefing leaves the prompt alone when briefing is null", () => {
  assert.equal(withProjectBriefing("Do the thing", null), "Do the thing");
});

test("briefs the PROJECT.md content as-is", () => {
  const md = "# Goals\n\nShip it.\n\n## Constraints\n\n- No new deps.";
  assert.equal(
    buildProjectBriefing({ name: "P", description: "", references: [], briefing: md }),
    `[Project: P]\n\n${md}`,
  );
  assert.equal(
    buildProjectBriefing({ name: "P", description: "Desc.", references: [], briefing: md }),
    `[Project: P]\nDesc.\n\n${md}`,
  );
});

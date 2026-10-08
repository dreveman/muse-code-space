// First messages go below companion cards; no separate task creation view.
// Run: node --test client/src/draftSetup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const css = readFileSync(path.join(root, "theme.css"), "utf8");

test("no setup panel or setup inputs remain in the draft view", () => {
  for (const token of [
    "new-session-panel",
    "new-session-heading",
    "new-session-footer",
    "setup-label-button",
    "draft-workspace",
    "draft-project",
    "draft-model",
    "draft-effort",
  ]) {
    assert.ok(!app.includes(token), `draft setup remnant must be gone: ${token}`);
    assert.ok(!css.includes(`.${token}`) && !css.includes(`#${token}`), `orphaned CSS must be gone: ${token}`);
  }
});

test("no setup-only styles remain", () => {
  assert.ok(!css.includes(".workspace-field"), "orphaned workspace-field CSS must be gone");
});

test("companion cards have a first-message composer", () => {
  assert.ok(app.includes("composer={firstMessageComposer}"));
  assert.ok(app.includes("title: queued.draft.companionName"), "the chosen companion starts the task");
  const menus = app.match(/<CompanionMenu/g) ?? [];
  assert.equal(menus.length, 2, "card and live composers share companion options");
  assert.ok(app.includes("onSubmit={submitDraft}"), "first message must still create the session");
});

test("there are no explicit new-task controls or draft rows", () => {
  assert.ok(!app.includes("function DraftRow("));
  assert.ok(!app.includes("startDraft("));
  assert.ok(!app.includes("command-bar-new"));
});

test("creating an agent does not insert a transient banner above the layout", () => {
  assert.ok(!app.includes("Muse Code started.") && !app.includes("launchNotice"));
  assert.ok(!css.includes(".launch-notice"));
  assert.ok(app.includes("Your first message is saved. Connecting…"), "a delayed first turn still explains its state inline");
});

test("a companion's first message uses a generated working directory", () => {
  assert.ok(app.includes("makeNewSessionDraft(companion)"));
  assert.ok(app.includes("resolveWorkspaceRoot(draft.workspaceRoot)"));
  assert.ok(app.includes("workspaceRoot: queued.workspacePath"));
});

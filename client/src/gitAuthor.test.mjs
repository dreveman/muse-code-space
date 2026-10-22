import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatGitAuthor, gitAuthorDiffersFromGlobal, gitAuthorOverride, parseGitAuthorText } from "./gitAuthor.ts";

test("blank author fields mean the global identity applies", () => {
  assert.equal(gitAuthorOverride("", ""), null);
  assert.equal(gitAuthorOverride("  ", " "), null);
});

test("a full pair normalizes; a half pair or bad email is invalid", () => {
  assert.deepEqual(gitAuthorOverride(" David ", " D@Example.COM "), { name: "David", email: "d@example.com" });
  assert.equal(gitAuthorOverride("David", ""), "invalid");
  assert.equal(gitAuthorOverride("", "d@example.com"), "invalid");
  assert.equal(gitAuthorOverride("David", "nope"), "invalid");
});

test("differs-from-global only for a valid, changed pair", () => {
  const global = { name: "David", email: "d@example.com" };
  assert.equal(gitAuthorDiffersFromGlobal("David", "d@example.com", global), false);
  assert.equal(gitAuthorDiffersFromGlobal("Other", "o@example.com", global), true);
  assert.equal(gitAuthorDiffersFromGlobal("", "", global), false);
  assert.equal(gitAuthorDiffersFromGlobal("Other", "o@example.com", null), true);
});

test("a directly-edited author line round-trips and validates", () => {
  const author = { name: "David Reveman", email: "dreveman@gmail.com" };
  assert.equal(formatGitAuthor(author), "David Reveman <dreveman@gmail.com>");
  assert.deepEqual(parseGitAuthorText(" David Reveman <DReveman@Gmail.COM> "), author);
  assert.equal(parseGitAuthorText(""), null);
  assert.equal(parseGitAuthorText("David Reveman"), "invalid");
  assert.equal(parseGitAuthorText("David Reveman <nope>"), "invalid");
  assert.equal(parseGitAuthorText("<dreveman@gmail.com>"), "invalid");
});

test("actions support the global identity and a create-time author override", () => {
  const actions = readFileSync(new URL("../../server/src/actions.ts", import.meta.url), "utf8");
  assert.ok(actions.includes("getGitIdentity") && actions.includes("setGitIdentity"), "global identity actions exist");
  assert.ok(actions.includes("gitAuthorName: args.git_author?.name ?? null"), "override is stored on the session row");
});

test("the repo select dialog has no author fields; the manage dialog has a single Author row", () => {
  const picker = readFileSync(new URL("./RepoPicker.tsx", import.meta.url), "utf8");
  const pickMenu = picker.slice(picker.indexOf('{open && mode === "pick"'));
  assert.ok(!pickMenu.includes("repo-author") && !pickMenu.includes("Commit author"), "pick dialog is author-free");
  assert.ok(picker.includes('<span className="repo-manage-field-label">Author</span>'), "manage dialog shows one Author row with Workspace/Remote");
  assert.ok(!picker.includes("<strong>No repo</strong>"), "repo select has no way back to a blank workspace");
  assert.ok(!picker.includes("(global)"), "Author row shows just the current user and email");
});

test("the started conversation's repo dropdown can change the checkout author", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const picker = readFileSync(new URL("./RepoPicker.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../../server/src/actions.ts", import.meta.url), "utf8");
  assert.ok(actions.includes("setSessionGitAuthor: defineAction"), "session author action exists");
  assert.ok(app.includes("api.setSessionGitAuthor({"), "conversation repo dropdown saves through the action");
  assert.ok(picker.includes('aria-pressed={editingAuthor}') && picker.includes('editingAuthor ? "Save" : "Edit"'), "Edit turns into Save while editing");
  assert.ok(!picker.includes(">User<") && !picker.includes(">Email<") && !picker.includes("repo-author-editor"), "no separate User/Email rows");
  assert.ok(picker.includes("parseGitAuthorText(manageAuthorText)"), "Save parses the directly-edited Author field");
  assert.ok(!picker.includes("onSaveSessionGitAuthor(override); }, 600"), "typing alone never persists: Save must be pressed");
  assert.ok(picker.includes("sessionGitAuthor ?? globalGitIdentity"), "edit starts populated with the effective (global fallback) author");
});

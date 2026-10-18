// Run: node --test client/src/repoPicker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterRepos, repoStatusText, repoTriggerLabel } from "./repoPicker.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const css = readFileSync(path.join(root, "theme.css"), "utf8");
const actions = readFileSync(path.join(root, "../../server/src/actions.ts"), "utf8");

const REPOS = [
  { slug: "dreveman/muse-code-space", name: "muse-code-space", owner: "dreveman", private: false, description: null, default_branch: "main", updated_at: null, html_url: "https://github.com/dreveman/muse-code-space" },
  { slug: "Octo/Hello-World", name: "Hello-World", owner: "Octo", private: true, description: null, default_branch: "main", updated_at: null, html_url: "https://github.com/Octo/Hello-World" },
];

test("filterRepos matches owner/repo case-insensitively and keeps order", () => {
  assert.deepEqual(filterRepos(REPOS, "").map((r) => r.slug), REPOS.map((r) => r.slug));
  assert.deepEqual(filterRepos(REPOS, "hello").map((r) => r.slug), ["Octo/Hello-World"]);
  assert.deepEqual(filterRepos(REPOS, "DREVEMAN/").map((r) => r.slug), ["dreveman/muse-code-space"]);
  assert.deepEqual(filterRepos(REPOS, "nope"), []);
});

test("the row status says what happens on start", () => {
  assert.equal(repoTriggerLabel(null), "No repo");
  assert.equal(repoTriggerLabel("o/r"), "o/r");
  assert.match(repoStatusText(null, "idle"), /Blank workspace/);
  assert.match(repoStatusText("o/r", "idle"), /clones into the new workspace/);
  assert.match(repoStatusText("o/r", "starting"), /Cloning o\/r/);
  assert.match(repoStatusText("o/r", "queued"), /Queued/);
});

test("the repo row sits above the first-message composer and travels with the draft", () => {
  const pickerAt = app.indexOf("<RepoPicker");
  assert.ok(pickerAt > app.indexOf("companion-first-prompt"), "picker is inside the first-message form");
  assert.ok(pickerAt < app.indexOf('id="draft-input"'), "picker renders above the prompt input");
  assert.ok(app.includes("repo: queued.draft.repoSlug"), "the pick is sent when the session is created");
  assert.ok(app.includes("repoSlug: null"), "drafts default to the blank workspace");
  assert.ok(app.includes('queryFn: () => api.listRepos({})'), "the picker is fed by the listRepos action");
  assert.ok(css.includes(".repo-row"), "row styles exist");
  assert.ok(css.includes(".repo-menu"), "menu styles exist");
  const picker = readFileSync(path.join(root, "RepoPicker.tsx"), "utf8");
  assert.ok(!picker.includes("<form"), "no nested form inside the composer form");
});

test("the server stores the pick and the pilot clones before starting", () => {
  assert.ok(actions.includes("repo: z.string()"), "createSession accepts a repo");
  assert.ok(actions.includes("repoSlug,"), "the pick is stored on the session row");
  assert.ok(actions.includes("...(row.repoSlug ? { repo: row.repoSlug } : {})"), "queued retries pass the pick to the pilot");
  const pilot = readFileSync(path.join(root, "../../pilot/pilot.mjs"), "utf8");
  assert.ok(pilot.includes('path === "/repos"'), "pilot serves the repo list");
  assert.ok(pilot.includes("ensureRepoCloned"), "pilot clones the pick before the session starts");
});

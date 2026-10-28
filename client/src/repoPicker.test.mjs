// Run: node --test client/src/repoPicker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_REPOS_STORAGE_KEY, TOP_REPO_LIMIT, applyPinnedRepos, filterRepos, mergeRepoOptions, orderPinnedFirst, parsePinnedRepos, repoStatusText, repoTriggerLabel, togglePinnedRepo, visibleTopRepos } from "./repoOptions.ts";

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

test("visibleTopRepos defaults to the top 5 and expands with Show more or a filter query", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({
    ...REPOS[0],
    slug: `dreveman/repo-${i + 1}`,
    name: `repo-${i + 1}`,
  }));
  const collapsed = visibleTopRepos(many, "", false);
  assert.equal(collapsed.shown.length, TOP_REPO_LIMIT);
  assert.equal(collapsed.hasMore, true);
  const expanded = visibleTopRepos(many, "", true);
  assert.equal(expanded.shown.length, 7);
  assert.equal(expanded.hasMore, true);
  const filtered = visibleTopRepos(many, "repo-7", false);
  assert.deepEqual(filtered.shown.map((r) => r.slug), ["dreveman/repo-7"]);
  assert.equal(filtered.hasMore, false);
});

test("mergeRepoOptions appends GitHub search hits without duplicating the local list", () => {
  const perfetto = { slug: "google/perfetto", name: "perfetto", owner: "google", private: false, description: null, default_branch: "main", updated_at: null, html_url: "https://github.com/google/perfetto" };
  assert.deepEqual(mergeRepoOptions(REPOS, [perfetto]).map((r) => r.slug), [...REPOS.map((r) => r.slug), "google/perfetto"]);
  assert.deepEqual(
    mergeRepoOptions(REPOS, [{ ...REPOS[0], slug: "Dreveman/Muse-Code-Space" }]).map((r) => r.slug),
    REPOS.map((r) => r.slug),
  );
});

const PERFETTO = { slug: "google/perfetto", name: "perfetto", owner: "google", private: false, description: null, default_branch: "main", updated_at: null, html_url: "https://github.com/google/perfetto" };

test("a pinned repo shows at the top even when the broker list cannot see it", () => {
  // google/perfetto is absent from REPOS (the App-mode list); its stored
  // pin snapshot alone must put it first, ahead of the collapsed top 5.
  const ordered = applyPinnedRepos(REPOS, [PERFETTO]);
  assert.deepEqual(ordered.map((r) => r.slug), ["google/perfetto", ...REPOS.map((r) => r.slug)]);
  assert.equal(visibleTopRepos(ordered, "", false).shown[0].slug, "google/perfetto");
  // When the repo is in the list, the fresher list entry wins over the snapshot.
  const fresher = { ...PERFETTO, slug: "dreveman/muse-code-space", description: "fresh" };
  assert.equal(applyPinnedRepos([fresher], [{ ...PERFETTO, slug: "dreveman/muse-code-space", description: "stale" }])[0].description, "fresh");
  // Filtering never injects a pinned repo that does not match.
  assert.deepEqual(orderPinnedFirst(REPOS, [PERFETTO]).map((r) => r.slug), REPOS.map((r) => r.slug));
  assert.deepEqual(
    orderPinnedFirst([PERFETTO, ...REPOS], [PERFETTO]).map((r) => r.slug),
    ["google/perfetto", ...REPOS.map((r) => r.slug)],
  );
});

test("togglePinnedRepo pins newest-first, unpins, and caps the list", () => {
  assert.deepEqual(togglePinnedRepo([], PERFETTO).map((r) => r.slug), ["google/perfetto"]);
  assert.deepEqual(togglePinnedRepo([PERFETTO], PERFETTO), []);
  const two = togglePinnedRepo([PERFETTO], REPOS[0]);
  assert.deepEqual(two.map((r) => r.slug), ["dreveman/muse-code-space", "google/perfetto"]);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...PERFETTO, slug: `o/r-${i}` }));
  assert.equal(togglePinnedRepo(many, PERFETTO).length, 20);
  assert.equal(togglePinnedRepo(many, PERFETTO)[0].slug, "google/perfetto");
});

test("parsePinnedRepos validates stored pins and survives junk", () => {
  assert.equal(PINNED_REPOS_STORAGE_KEY, "muse-code-space:pinned-repos");
  assert.deepEqual(parsePinnedRepos(null), []);
  assert.deepEqual(parsePinnedRepos("not json"), []);
  assert.deepEqual(parsePinnedRepos('{"slug":"google/perfetto"}'), []);
  const parsed = parsePinnedRepos(JSON.stringify([PERFETTO, { slug: "bad" }, PERFETTO, null, { slug: "o/r" }]));
  assert.deepEqual(parsed.map((r) => r.slug), ["google/perfetto", "o/r"]);
  assert.equal(parsed[1].html_url, "https://github.com/o/r");
  assert.equal(parsed[1].owner, "o");
});

test("the picker renders a pin toggle per repo and persists pins", () => {
  const picker = readFileSync(path.join(root, "RepoPicker.tsx"), "utf8");
  assert.ok(picker.includes("repo-menu-pin"), "pin button is rendered");
  assert.ok(picker.includes("aria-pressed={pinned}"), "pin button exposes its state");
  assert.ok(picker.includes("Pin ${repo.slug} to the top"), "pin button is labelled");
  assert.ok(picker.includes("PINNED_REPOS_STORAGE_KEY"), "pins persist in localStorage");
  assert.ok(picker.includes("applyPinnedRepos(repos, pinnedRepos)"), "pins order the list");
  assert.ok(css.includes(".repo-menu-pin"), "pin styles exist");
  assert.ok(css.includes(".repo-menu-pin.pinned"), "pinned state styles exist");
});

test("the picker search box asks GitHub, not just the local list", () => {
  const picker = readFileSync(path.join(root, "RepoPicker.tsx"), "utf8");
  assert.ok(picker.includes("onSearchRepos"), "picker accepts a GitHub search callback");
  assert.ok(picker.includes("Searching GitHub"), "picker shows search progress");
  assert.ok(app.includes("api.searchRepos({ q })"), "App wires the searchRepos action");
  assert.ok(actions.includes("searchRepos: defineAction"), "server exposes repo search");
  assert.ok(actions.includes("/repos/search?q="), "server forwards search to the pilot");
  const pilot = readFileSync(path.join(root, "../../pilot/pilot.mjs"), "utf8");
  assert.ok(pilot.includes('path === "/repos/search"'), "pilot serves repo search");
  const setup = readFileSync(path.join(root, "../../pilot/repoSetup.mjs"), "utf8");
  assert.ok(setup.includes("searchGitHubRepos"), "pilot searches GitHub repositories");
  assert.ok(setup.includes("/search/repositories?q="), "search uses the GitHub search API");
});

test("the row status says what happens on start", () => {
  assert.equal(repoTriggerLabel(null), "Select repository");
  assert.equal(repoTriggerLabel(null, false), "Connect GitHub");
  assert.equal(repoTriggerLabel("o/r"), "o/r");
  assert.equal(repoTriggerLabel("o/r", false), "o/r");
  assert.equal(repoStatusText(null, "idle"), "");
  assert.equal(repoStatusText("o/r", "idle"), "");
  assert.match(repoStatusText("o/r", "starting"), /Cloning o\/r/);
  assert.match(repoStatusText("o/r", "queued"), /Queued/);
});

test("helper module names differ by more than case (macOS filesystems are case-insensitive)", () => {
  // "./repoPicker" resolved to RepoPicker.tsx itself on APFS, breaking the
  // dev-server build. The helpers live in repoOptions.ts so no two modules
  // in this directory are distinguished only by letter case.
  assert.ok(existsSync(path.join(root, "repoOptions.ts")));
  assert.ok(!existsSync(path.join(root, "repoPicker.ts")), "repoPicker.ts collides with RepoPicker.tsx on case-insensitive filesystems");
  const names = new Map();
  for (const name of readdirSync(root)) {
    const key = name.toLowerCase();
    assert.ok(!names.has(key), `${name} differs from ${names.get(key)} only by case`);
    names.set(key, name);
  }
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

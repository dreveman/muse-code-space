// Run: node --test client/src/githubSetup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const picker = readFileSync(new URL("./RepoPicker.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
const actions = readFileSync(new URL("../../server/src/actions.ts", import.meta.url), "utf8");
const fakePilot = readFileSync(new URL("../../dev/fake-pilot.ts", import.meta.url), "utf8");
const pilot = readFileSync(new URL("../../pilot/pilot.mjs", import.meta.url), "utf8");

test("the repo dropdown becomes a GitHub setup dialog until every step is done", () => {
  assert.ok(picker.includes("showGithubSetup"), "setup replaces the repo list while incomplete");
  assert.ok(picker.includes('aria-label="GitHub setup"'), "the dropdown is a labelled setup dialog");
  assert.ok(picker.includes("of 3 complete"), "progress is shown");
  for (const title of ["GitHub broker", "GitHub App", "Commit author"]) {
    assert.ok(picker.includes(`<strong>${title}</strong>`), `step title: ${title}`);
  }
  assert.ok(picker.includes("Lets companions use gh and list repositories"), "broker subtitle");
  assert.ok(picker.includes("Lets companions clone, pull, and push to repositories"), "App subtitle");
  assert.ok(picker.includes('githubSetup.brokerDone ? "✓" : "1"'), "completed steps get a checkmark");
  assert.ok(picker.includes('className={`repo-setup-step${githubSetup.brokerDone ? " done" : ""}`}'), "done styling");
  assert.ok(css.includes(".repo-setup-steps") && css.includes(".repo-setup-step.done .repo-setup-status"), "setup styles exist");
});

test("each step can be performed from inside the dialog", () => {
  assert.ok(picker.includes('runSetupStep("broker")'), "broker step asks the Muse assistant in place");
  assert.ok(picker.includes("Go to your Muse assistant to add the GitHub credential"), "waiting state directs the user to their Muse assistant");
  assert.ok(picker.includes('className="working-spinner"'), "waiting state shows a spinner");
  assert.ok(picker.includes("brokerWaiting"), "an outstanding assistant request keeps the waiting state");
  assert.ok(picker.includes('aria-label="App ID"') && picker.includes('aria-label="Installation ID"') && picker.includes('aria-label="Private key"'), "App step collects its credentials in the dialog");
  assert.ok(picker.includes("Connect GitHub App"), "App step submits from the dialog");
  assert.ok(picker.includes("onSaveGlobalGitAuthor(setupAuthorParsed)"), "author step saves the global author through the existing identity path");
  assert.ok(picker.includes("setupPrivateKey(\"\")") || picker.includes('setSetupPrivateKey("")'), "the private key is cleared after a successful App step");
});

test("App wires setup status and steps through the server actions", () => {
  assert.ok(app.includes("api.getGithubSetup({})"), "App fetches setup progress");
  assert.ok(app.includes("api.performGithubSetupStep({"), "App performs steps");
  assert.ok(app.includes("api.setGitIdentity({"), "author step reuses the git identity action");
  assert.ok(actions.includes("getGithubSetup: defineAction") && actions.includes("performGithubSetupStep: defineAction"), "server actions exist");
  assert.ok(actions.includes('step: z.enum(["broker", "app"])'), "steps are a closed enum");
  assert.ok(actions.includes("App ID and installation ID must be numeric."), "App credentials are validated server-side");
});

test("App polls setup status while steps are incomplete", () => {
  assert.ok(app.includes("refetchInterval"), "setup status polls so waiting steps complete on their own");
  assert.ok(app.includes("data.broker_done && data.app_done"), "polling stops once broker and App are done");
});

test("the fake pilot simulates the whole setup flow", () => {
  assert.ok(fakePilot.includes('path === "/github-setup"'), "fake pilot serves setup status");
  assert.ok(fakePilot.includes("githubSetup.brokerRequested = true"), "broker step records the assistant request");
  assert.ok(fakePilot.includes("githubSetup.brokerDone = true"), "broker step completes after the simulated vault addition");
  assert.ok(fakePilot.includes("githubSetup.appDone = true"), "App step completes");
  assert.ok(fakePilot.includes("!githubSetup.brokerDone"), "repo listing follows broker progress");
  assert.ok(fakePilot.includes("starts\n// with nothing done") || fakePilot.includes("with nothing done"), "disconnected mode starts incomplete so the flow can be exercised");
});

test("the real pilot reports genuine status and asks Muse for the broker credential", () => {
  assert.ok(pilot.includes('path === "/github-setup"'), "pilot serves setup status");
  assert.ok(pilot.includes('appDone: mode === "app"'), "App step reflects an app-mode broker config");
  assert.ok(pilot.includes("initiate the Secure Vault addition of a custom API credential named custom.github-broker, then write the surrogate broker config and restart the broker"), "broker step asks the Muse assistant via its inbox");
  assert.ok(pilot.includes("MUSE_INBOX_PATH"), "the request lands where readMuseMessages reads");
  assert.ok(pilot.includes("github_setup_unavailable"), "the App step is not faked on the real pilot yet");
  const hook = readFileSync(new URL("../../hooks/code-space-assistant-job.md", import.meta.url), "utf8");
  assert.ok(hook.includes("custom.github-broker"), "the assistant job knows how to handle the broker credential request");
  assert.ok(hook.includes('{"mode": "surrogate", "credential_name":') || hook.includes('"mode": "surrogate"'), "the assistant writes the surrogate broker config");
  assert.ok(hook.includes("systemctl restart muse-code-space-github-broker.service"), "the assistant activates the broker");
  assert.ok(hook.includes("__code_space/health"), "the assistant verifies the broker before reporting success");
});

// Entering the app must never paint a UI state that the first session
// load is about to replace. Run: node --test client/src/startupSelection.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("the available-companions roster waits for the first session load", () => {
  assert.ok(app.includes('filter === "active" && sessionsQuery.data && <section className="available-companions"'),
    "availability derives from sessions; rendering it pre-load shows everyone as free");
  assert.ok(app.includes('"Loading companions…"'), "the loading state is what paints first");
});

test("the initial session pick lands before paint", () => {
  const pick = app.slice(app.indexOf("const initialPickDoneRef"), app.indexOf("initialPickDoneRef.current = true"));
  assert.ok(pick.includes("useLayoutEffect(() => {"), "selection resolves in a layout effect, not a post-paint effect");
});

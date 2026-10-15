// Available companions are still; only task rows animate.
// Run: node --test client/src/companionContactMotion.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const companions = readFileSync(new URL("./Companions.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("available-companion contacts never animate", () => {
  const contact = companions.slice(companions.indexOf("export function CompanionContact"));
  assert.ok(contact.includes("<CompanionAvatar artwork={companion.artwork} animate={false} />"));
  assert.ok(!contact.includes('animate={access.status === "ready"}'));
});

test("sidebar task rows still animate while their task is active", () => {
  assert.ok(app.includes('animate={!session.archived}'), "non-archived task rows keep motion; archived (Past) rows are still");
});

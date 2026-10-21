// Run: node --test client/src/contextUsage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextUsageLabel } from "./contextUsage.ts";

test("context tooltip uses compact counts and a percentage, no jargon", () => {
  assert.equal(contextUsageLabel(673_000, 922_000), "673k/922k (73.0%) of context used");
  assert.equal(contextUsageLabel(0, 128_000), "0/128k (0.0%) of context used");
  assert.equal(contextUsageLabel(950, 128_000), "950/128k (0.7%) of context used");
  assert.equal(contextUsageLabel(999_999, 128_000), "1000k/128k (100.0%) of context used");
  assert.ok(!/approx|token/i.test(contextUsageLabel(673_000, 922_000)));
});

test("voice button tooltip matches its aria label in both composers and context ring only appears in started conversations", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.equal(app.split('title={listening ? "Stop voice input" : "Start voice input"}').length - 1, 2);
  assert.ok(!app.includes('"Dictate"') && !app.includes('"Stop dictation"'));
  assert.equal(app.split("title={contextUsageLabel(estimatedContextTokens, CONTEXT_WINDOW_TOKENS)}").length - 1, 1);
});

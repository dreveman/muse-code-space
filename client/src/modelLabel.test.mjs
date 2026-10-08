import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { displayModelLabel } from "./modelLabel.ts";

test("any recognizable family, dotted version and optional variant formats generically", () => {
  assert.equal(displayModelLabel("aurora-spark-2.4-preview"), "Aurora Spark 2.4 (Preview)");
  assert.equal(displayModelLabel("aurora-fire-1.0-contributor"), "Aurora Fire 1.0 (Contributor)");
  assert.equal(displayModelLabel("other-nova-2027.12.2-private-preview"), "Other Nova 2027.12.2 (Private Preview)");
  assert.equal(displayModelLabel("alpha-2.5"), "Alpha 2.5");
});

test("Wonder tiers use the names shown on companion cards", () => {
  assert.equal(displayModelLabel("muse-wonder-1.0"), "Muse Wonder 1.0");
  assert.equal(displayModelLabel("muse-wonder-full-1.0"), "Muse Wonder Full 1.0");
});

test("unrecognized or ambiguous IDs fall back byte-for-byte to the raw value", () => {
  for (const id of ["aurora-spark-latest", "gpt-4o", "aurora-spark-2.4-2.0", "aurora--2.4-preview", "aurora_spark-2.4-preview", "aurora-spark-2.4-", "aurora-spark-2.4/preview", " aurora-spark-2.4-preview ", ""]) {
    assert.equal(displayModelLabel(id), id);
  }
});

test("model names stay formatted in companion details and the catalog", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const cards = readFileSync(new URL("./Companions.tsx", import.meta.url), "utf8");
  assert.ok(cards.includes('displayModelLabel(companion.model.preferredId)'));
  assert.ok(!app.includes('aria-label="Change model and effort"'));
});

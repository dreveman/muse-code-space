import { test } from "node:test";
import assert from "node:assert/strict";
import { companionModelAccess, orderCompanionsByAccess } from "./companionModels.ts";

const paid = { model: { preferredId: "paid-model", ifUnavailable: "upgrade-required" } };
const free = { model: { preferredId: "free-model", ifUnavailable: "use-catalog-default" } };

test("a paid companion never falls back to another model", () => {
  for (const models of [[], [{ id: "free-model" }], [{ id: "different-paid-model" }]]) {
    assert.deepEqual(companionModelAccess(paid, models), { status: "upgrade-required" });
  }
});

test("an unknown catalog keeps paid companions unavailable without claiming an upgrade is required", () => {
  assert.deepEqual(companionModelAccess(paid, undefined), { status: "unavailable" });
});

test("paid companions unlock only after a positive catalog check", () => {
  const catalogs = [undefined, undefined, [{ id: "paid-model" }], undefined];
  assert.deepEqual(catalogs.map((models) => companionModelAccess(paid, models).status),
    ["unavailable", "unavailable", "ready", "unavailable"]);
});

test("unavailable companions sort last before and after a catalog check", () => {
  const anotherFree = { ...free, id: "another-free" };
  const roster = [paid, free, anotherFree];
  for (const models of [undefined, [], [{ id: "free-model" }]]) {
    assert.deepEqual(orderCompanionsByAccess(roster, models), [free, anotherFree, paid]);
  }
  assert.deepEqual(orderCompanionsByAccess(roster, [{ id: "paid-model" }]), roster);
});

test("an accessible paid companion uses its exact model id", () => {
  assert.deepEqual(companionModelAccess(paid, [{ id: "free-model" }, { id: "paid-model" }]),
    { status: "ready", modelId: "paid-model" });
});

test("free companions preserve their existing default and offline behavior", () => {
  assert.deepEqual(companionModelAccess(free, [{ id: "other-model" }, { id: "free-model" }]),
    { status: "ready", modelId: "free-model" });
  assert.deepEqual(companionModelAccess(free, [{ id: "other-model" }]),
    { status: "ready", modelId: "other-model" });
  for (const models of [[], undefined]) {
    assert.deepEqual(companionModelAccess(free, models), { status: "ready", modelId: "free-model" });
  }
});

test("unknown fallback policies do not silently grant a model", () => {
  assert.deepEqual(companionModelAccess({ model: { preferredId: "missing", ifUnavailable: "unknown" } }, []),
    { status: "unavailable" });
});

test("computed stats for the built-in roster", async () => {
  const { computeCompanionStats } = await import("./companionModels.ts");
  assert.deepEqual(computeCompanionStats("muse-spark-1.3", "medium"), { speed: 3, thoughtfulness: 2, creativity: 2, initiative: 4 });
  assert.deepEqual(computeCompanionStats("muse-spark-1.3", "low"), { speed: 4, thoughtfulness: 1, creativity: 2, initiative: 4 });
  assert.deepEqual(computeCompanionStats("muse-spark-1.3", "xhigh"), { speed: 2, thoughtfulness: 3, creativity: 2, initiative: 3 });
  assert.deepEqual(computeCompanionStats("muse-wonder-1.0", "medium"), { speed: 2, thoughtfulness: 4, creativity: 4, initiative: 5 });
  assert.deepEqual(computeCompanionStats("muse-wonder-full-1.0", "max"), { speed: 1, thoughtfulness: 5, creativity: 5, initiative: 2 });
});

test("unknown models fall back to family or neutral parameters", async () => {
  const { computeCompanionStats } = await import("./companionModels.ts");
  assert.deepEqual(computeCompanionStats("muse-wonder-9.9", "high"), computeCompanionStats("muse-wonder-1.0", "high"));
  assert.deepEqual(computeCompanionStats("muse-wonder-full-2.0", "low"), computeCompanionStats("muse-wonder-full-1.0", "low"));
  const neutral = computeCompanionStats("some-future-model", "medium");
  assert.deepEqual(neutral, { speed: 1, thoughtfulness: 3, creativity: 3, initiative: 4 });
  assert.deepEqual(computeCompanionStats("muse-spark-1.3", "bogus-effort"), computeCompanionStats("muse-spark-1.3", "medium"));
  for (const stats of [neutral, computeCompanionStats("x", "max"), computeCompanionStats("x", "minimal")]) {
    for (const value of Object.values(stats)) assert.ok(value >= 1 && value <= 5);
  }
});

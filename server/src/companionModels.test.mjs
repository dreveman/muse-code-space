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

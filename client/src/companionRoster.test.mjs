import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCompanionDefinitions, builtinCompanionDefinitions, companionAssignedElsewhere, companionDefinitions, companionForName, isDefaultCompanion, matchesCompanionQuery } from "./companionRoster.ts";

const session = (title, archived = false, updated_at = "2026-01-01T00:00:00Z") => ({ title, archived, updated_at });

test("the built-in roster is Poppy, Remy, Tilly, Nova, Sage in order", () => {
  assert.deepEqual(builtinCompanionDefinitions.map((c) => c.id), ["poppy", "remy", "tilly", "nova", "sage"]);
  assert.deepEqual(companionDefinitions.length, 20);
  assert.equal(isDefaultCompanion({ id: "poppy" }), true);
  assert.equal(isDefaultCompanion({ id: "pip" }), false);
});

test("an old unarchived task keeps its companion occupied until explicit archive", () => {
  const old = session("poppy", false, "2000-01-01T00:00:00Z");
  assert.equal(availableCompanionDefinitions([old]).some((c) => c.id === "poppy"), false);
  assert.equal(availableCompanionDefinitions([{ ...old, archived: true }]).some((c) => c.id === "poppy"), true);
});

test("donor companions are not assignable even when free", () => {
  const available = availableCompanionDefinitions([session("Pip", true), session("PIP")]);
  assert.equal(available.length, builtinCompanionDefinitions.length);
  assert.equal(available.some((c) => c.id === "pip"), false);
});

test("archived history cannot free a companion with another unarchived task", () => {
  const available = availableCompanionDefinitions([session("Poppy", true), session("POPPY")]);
  assert.equal(available.length, builtinCompanionDefinitions.length - 1);
  assert.equal(available.some((c) => c.id === "poppy"), false);
});

test("available companions are most recently used first, with unused companions in roster order", () => {
  const sessions = [session("Nova", true), session("Sage", true, "2026-02-01T00:00:00Z"), session("Poppy", true, "bad-date")];
  const before = structuredClone(sessions);
  assert.deepEqual(availableCompanionDefinitions(sessions).slice(0, 4).map((c) => c.id), ["sage", "nova", "poppy", "remy"]);
  assert.deepEqual(sessions, before);
});

test("a custom roster can be supplied for availability", () => {
  const roster = [{ id: "custom-1", name: "Willow" }, { id: "custom-2", name: "Fern" }];
  assert.deepEqual(availableCompanionDefinitions([session("Willow")], roster).map((c) => c.id), ["custom-2"]);
});

test("name matching is exact and search also finds specialties and skills", () => {
  const pip = companionForName(" PIP ");
  assert.equal(pip?.id, "pip");
  assert.equal(companionForName("Pip 2"), undefined);
  assert.equal(companionForName("Unknown"), undefined);
  assert.ok(matchesCompanionQuery(pip, "debugging"));
  assert.ok(matchesCompanionQuery(pip, " ALL-ROUNDER "));
  assert.equal(matchesCompanionQuery(pip, "nonexistent"), false);
});

test("search also finds companions by music genre and tags", () => {
  const nova = companionForName("Nova");
  assert.ok(matchesCompanionQuery(nova, "idm"));
  assert.ok(matchesCompanionQuery(nova, "hypnotic"));
  const sage = companionForName("Sage");
  assert.ok(matchesCompanionQuery(sage, "ambient"));
  assert.equal(matchesCompanionQuery(sage, "techno"), false);
});

test("archived tasks need a different companion if their previous one owns another task", () => {
  const tasks = [{ id: "past", ...session("Juno", true) }, { id: "other", ...session("JUNO") }];
  assert.equal(companionAssignedElsewhere(tasks, " Juno ", "past"), true);
  assert.equal(companionAssignedElsewhere(tasks, "Milo", "past"), false);
  assert.equal(companionAssignedElsewhere(tasks, "Juno", "other"), false);
  assert.equal(companionAssignedElsewhere(tasks.map(s => ({ ...s, archived: true })), "Juno", "past"), false);
});

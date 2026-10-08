import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCompanionDefinitions, companionAssignedElsewhere, companionDefinitions, companionForName, matchesCompanionQuery } from "./companionRoster.ts";

const session = (title, archived = false, updated_at = "2026-01-01T00:00:00Z") => ({ title, archived, updated_at });

test("an old unarchived task keeps its companion occupied until explicit archive", () => {
  const old = session("pip", false, "2000-01-01T00:00:00Z");
  assert.equal(availableCompanionDefinitions([old]).some((c) => c.id === "pip"), false);
  assert.equal(availableCompanionDefinitions([{ ...old, archived: true }]).some((c) => c.id === "pip"), true);
});

test("archived history cannot free a companion with another unarchived task", () => {
  const available = availableCompanionDefinitions([session("Pip", true), session("PIP")]);
  assert.equal(available.length, companionDefinitions.length - 1);
  assert.equal(available.some((c) => c.id === "pip"), false);
});

test("available companions are most recently used first, with unused companions in roster order", () => {
  const sessions = [session("Juno", true), session("Sage", true, "2026-02-01T00:00:00Z"), session("Pip", true, "bad-date")];
  const before = structuredClone(sessions);
  assert.deepEqual(availableCompanionDefinitions(sessions).slice(0, 4).map((c) => c.id), ["sage", "juno", "pip", "milo"]);
  assert.deepEqual(sessions, before);
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

test("archived tasks need a different companion if their previous one owns another task", () => {
  const tasks = [{ id: "past", ...session("Juno", true) }, { id: "other", ...session("JUNO") }];
  assert.equal(companionAssignedElsewhere(tasks, " Juno ", "past"), true);
  assert.equal(companionAssignedElsewhere(tasks, "Milo", "past"), false);
  assert.equal(companionAssignedElsewhere(tasks, "Juno", "other"), false);
  assert.equal(companionAssignedElsewhere(tasks.map(s => ({ ...s, archived: true })), "Juno", "past"), false);
});

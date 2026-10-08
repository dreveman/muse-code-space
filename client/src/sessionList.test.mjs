// Tests for the sidebar session list helpers.
// Run: node --test client/src/sessionList.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSessionQuery, sessionTaskTitle, formatRelativeTime, groupSessionsByProject, resolveSelectedId, isSessionActive, sortSessions, ACTIVE_WINDOW_MS, ACTIVE_WINDOW_PROJECT_MS } from "./sessionList.ts";

const session = {
  title: "Refactor the parser",
  prompt: "Clean up tokenizer edge cases",
  latest_output: "All tests pass",
};

test("blank query matches everything", () => {
  assert.equal(matchesSessionQuery(session, ""), true);
  assert.equal(matchesSessionQuery(session, "   "), true);
});

test("matches title, prompt, and latest output case-insensitively", () => {
  assert.equal(matchesSessionQuery(session, "PARSER"), true);
  assert.equal(matchesSessionQuery(session, "tokenizer"), true);
  assert.equal(matchesSessionQuery(session, "TESTS PASS"), true);
});

test("matches an optional summary and ignores one that is missing", () => {
  assert.equal(matchesSessionQuery({ ...session, session_summary: "Improves parser diagnostics" }, "DIAGNOSTICS"), true);
  assert.equal(matchesSessionQuery({ ...session, session_summary: null }, "DIAGNOSTICS"), false);
});

test("a renamed task is searchable independently of its companion name", () => {
  const task = { ...session, title: "Pip", session_summary: "Improve keyboard navigation" };
  assert.equal(matchesSessionQuery(task, "KEYBOARD"), true);
  assert.equal(matchesSessionQuery(task, "pip"), true);
  assert.equal(matchesSessionQuery({ ...task, title: "Sage" }, "KEYBOARD"), true);
});

test("one summary supplies the label across agent handoffs, with a prompt fallback", () => {
  const task = { ...session, title: "Pip", session_summary: "Original summary" };
  assert.equal(sessionTaskTitle(task), "Original summary");
  assert.equal(sessionTaskTitle({ ...task, title: "Sage" }), "Original summary");
  assert.equal(sessionTaskTitle({ ...task, session_summary: "New summary" }), "New summary");
  assert.equal(sessionTaskTitle({ ...task, session_summary: "  A  concise\nsummary " }), "A concise summary");
  assert.equal(sessionTaskTitle({ ...task, session_summary: null }), session.prompt);
  assert.equal(sessionTaskTitle({ ...task, session_summary: " " }), session.prompt);
});

test("rejects non-matching queries", () => {
  assert.equal(matchesSessionQuery(session, "renderer"), false);
});

test("handles null latest output", () => {
  assert.equal(matchesSessionQuery({ ...session, latest_output: null }, "parser"), true);
  assert.equal(matchesSessionQuery({ ...session, latest_output: null }, "zzz"), false);
});

const T0 = new Date("2026-09-30T18:00:00.000Z").getTime();
const iso = (ms) => new Date(ms).toISOString();

test("formats relative ages compactly", () => {
  assert.equal(formatRelativeTime(iso(T0 - 10_000), T0), "now");
  assert.equal(formatRelativeTime(iso(T0 - 5 * 60_000), T0), "5m");
  assert.equal(formatRelativeTime(iso(T0 - 2 * 3_600_000), T0), "2h");
  assert.equal(formatRelativeTime(iso(T0 - 3 * 86_400_000), T0), "3d");
});

test("clamps future timestamps to now", () => {
  assert.equal(formatRelativeTime(iso(T0 + 60_000), T0), "now");
});

test("returns empty for invalid dates", () => {
  assert.equal(formatRelativeTime("not-a-date", T0), "");
});

const filed = (id, project_id) => ({
  id,
  title: id,
  prompt: "",
  latest_output: null,
  project_id,
});

test("groups by project name with No Project trailing", () => {
  const groups = groupSessionsByProject(
    [filed("s1", "pb"), filed("s2", null), filed("s3", "pa"), filed("s4", "pb")],
    [
      { id: "pa", name: "Zebra" },
      { id: "pb", name: "Alpha" },
    ],
  );
  assert.deepEqual(
    groups.map((g) => g.name),
    ["Alpha", "Zebra", "No Project"],
  );
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["s1", "s4"]);
  assert.deepEqual(groups[2].sessions.map((s) => s.id), ["s2"]);
});

test("omits empty groups and unknown projects fall back to No Project", () => {
  const groups = groupSessionsByProject([filed("s1", "gone")], [{ id: "pa", name: "Zebra" }]);
  assert.deepEqual(groups.map((g) => g.name), ["No Project"]);
  assert.equal(groups[0].projectId, null);
});

test("returns no groups for no sessions", () => {
  assert.deepEqual(groupSessionsByProject([], [{ id: "pa", name: "Zebra" }]), []);
});

test("draft selection survives auto-selection", () => {
  assert.equal(
    resolveSelectedId("draft-1", ["s1", "s2"], ["s1", "s2"], { draftId: "draft-1", defer: false }),
    "draft-1",
  );
  assert.equal(
    resolveSelectedId("draft-1", [], [], { draftId: "draft-1", defer: false }),
    "draft-1",
  );
});

test("selection survives filter changes; only a first load auto-picks", () => {
  const known = ["active-1", "past-1"];
  // Switching to Past: the open Active session stays selected though it's not visible.
  assert.equal(resolveSelectedId("active-1", known, ["past-1"], { draftId: null, defer: false }), "active-1");
  assert.equal(resolveSelectedId("active-1", known, [], { draftId: null, defer: false }), "active-1");
  // A deleted selection is cleared, not replaced by another session.
  assert.equal(resolveSelectedId("gone", known, ["active-1"], { draftId: null, defer: false }), null);
  // Nothing selected: no auto-pick, except on the first load.
  assert.equal(resolveSelectedId(null, known, ["active-1"], { draftId: null, defer: false }), null);
  assert.equal(resolveSelectedId(null, known, ["active-1"], { draftId: null, defer: false, autoPickFirst: true }), "active-1");
  assert.equal(resolveSelectedId(null, [], [], { draftId: null, defer: false, autoPickFirst: true }), null);
});

test("deferred selection keeps current", () => {
  assert.equal(
    resolveSelectedId("gone", ["s1"], ["s1"], { draftId: null, defer: true }),
    "gone",
  );
});

test("activity windows are 24h, 72h for filed sessions", () => {
  assert.equal(ACTIVE_WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.equal(ACTIVE_WINDOW_PROJECT_MS, 72 * 60 * 60 * 1000);
});

test("recent sessions are active, stale ones are not", () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(isSessionActive({ archived: false, updated_at: iso(now - 1000), project_id: null }, now), true);
  assert.equal(isSessionActive({ archived: false, updated_at: iso(now - ACTIVE_WINDOW_MS + 60000), project_id: null }, now), true);
  assert.equal(isSessionActive({ archived: false, updated_at: iso(now - ACTIVE_WINDOW_MS - 60000), project_id: null }, now), false);
});

test("filed sessions stay active for 72h", () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const filed = (updated_at) => ({ archived: false, updated_at, project_id: "p1" });
  assert.equal(isSessionActive(filed(iso(now - ACTIVE_WINDOW_MS - 60000)), now), true);
  assert.equal(isSessionActive(filed(iso(now - ACTIVE_WINDOW_PROJECT_MS - 60000)), now), false);
});

test("archived or dateless sessions are never active", () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(isSessionActive({ archived: true, updated_at: iso(now), project_id: null }, now), false);
  assert.equal(isSessionActive({ archived: false, updated_at: "not-a-date", project_id: null }, now), false);
});

test("past sessions group by age: Yesterday, Earlier this week, Earlier", async () => {
  const { groupSessionsByAge, ageBucket } = await import("./sessionList.ts");
  // Fixed local "now": Thursday 2026-10-08 15:00 local time.
  const now = new Date(2026, 9, 8, 15, 0, 0).getTime();
  const at = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  const entry = (id, updated_at) => ({ id, title: id, prompt: "", latest_output: null, project_id: null, updated_at });
  assert.equal(ageBucket(at(2026, 9, 8, 1), now), "age:today");
  assert.equal(ageBucket(at(2026, 9, 7, 23), now), "age:yesterday");
  assert.equal(ageBucket(at(2026, 9, 7, 0), now), "age:yesterday");
  assert.equal(ageBucket(at(2026, 9, 6), now), "age:week");
  assert.equal(ageBucket(at(2026, 9, 2, 0), now), "age:week", "6 days ago is still this week");
  assert.equal(ageBucket(at(2026, 9, 1, 23), now), "age:earlier");
  assert.equal(ageBucket("not a date", now), "age:earlier");

  const groups = groupSessionsByAge([
    entry("y1", at(2026, 9, 7)),
    entry("e1", at(2026, 8, 1)),
    entry("w1", at(2026, 9, 5)),
    entry("y2", at(2026, 9, 7, 9)),
  ], now);
  assert.deepEqual(groups.map((g) => [g.name, g.sessions.map((s) => s.id)]), [
    ["Yesterday", ["y1", "y2"]],
    ["Earlier this week", ["w1"]],
    ["Earlier", ["e1"]],
  ], "empty Today omitted, order kept within groups");
});

test("sort priority: needs you, finished, working, then idle; ties by last prompt/reply", () => {
  const date = (n) => new Date(2026, 9, n).toISOString();
  const rows = [
    { id: "idle", status: "queued", needs_you: false, updated_at: date(10), started_at: date(9) },
    { id: "working", status: "running", needs_you: false, updated_at: date(9), started_at: date(8) },
    { id: "finished-old", status: "succeeded", needs_you: false, updated_at: date(5), started_at: date(2) },
    { id: "needs-input", status: "running", needs_you: true, updated_at: date(4), started_at: date(1) },
    { id: "finished-new", status: "stopped", needs_you: false, updated_at: date(8), started_at: date(3) },
    { id: "failed", status: "failed", needs_you: false, updated_at: date(3), started_at: date(2) },
  ];
  const ids = (mode) => sortSessions(rows, mode).map((row) => row.id);
  assert.deepEqual(ids("priority"), ["needs-input", "failed", "finished-new", "finished-old", "working", "idle"]);
  assert.deepEqual(ids("updated"), ["idle", "working", "finished-new", "finished-old", "needs-input", "failed"]);
  assert.deepEqual(ids("created"), ["idle", "working", "finished-new", "finished-old", "failed", "needs-input"]);
  assert.equal(rows[0].id, "idle", "query data isn't mutated");
});

test("restoring an old agent makes it Active without moving its Updated timestamp", () => {
  const now = Date.now();
  const old = new Date(now - ACTIVE_WINDOW_MS * 2).toISOString();
  const restored = new Date(now - 60_000).toISOString();
  assert.equal(isSessionActive({ archived: false, updated_at: old, restored_at: restored, project_id: null }, now), true);
  assert.equal(isSessionActive({ archived: true, updated_at: old, restored_at: restored, project_id: null }, now), false);
});

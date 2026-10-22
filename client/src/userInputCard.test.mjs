// Tests for the pending question card's selection guidance and readiness.
// Run: node --test client/src/userInputCard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { questionSelectionHint, questionAnswered, userInputReadiness } from "./userInputCard.ts";

const single = { id: "q1", selection: { mode: "single" }, options: [{ label: "A" }, { label: "B" }] };
const multi = { id: "q2", selection: { mode: "multiple", minSelections: 2, maxSelections: 3 }, options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }] };

test("selection hints spell out how many options to pick", () => {
  assert.equal(questionSelectionHint(single), "Pick one");
  assert.equal(questionSelectionHint(multi), "Pick 2–3");
  assert.equal(questionSelectionHint({ ...multi, selection: { mode: "multiple", minSelections: 1, maxSelections: 3 } }), "Pick 1–3");
  assert.equal(questionSelectionHint({ ...multi, selection: { mode: "multiple", minSelections: 2 } }), "Pick at least 2");
  assert.equal(questionSelectionHint({ ...multi, selection: { mode: "multiple", maxSelections: 2 } }), "Pick up to 2");
  assert.equal(questionSelectionHint({ id: "q3", selection: { mode: "single" }, options: [] }), "Write your answer");
});

test("a question is answered by valid options or by free text, not both counted twice", () => {
  assert.equal(questionAnswered(single, ["A"], ""), true);
  assert.equal(questionAnswered(single, [], "something else"), true);
  assert.equal(questionAnswered(single, [], ""), false);
  assert.equal(questionAnswered(multi, ["A"], ""), false, "below the minimum");
  assert.equal(questionAnswered(multi, ["A", "B"], ""), true);
  assert.equal(questionAnswered(multi, ["A", "B", "C", "D"], ""), false, "above the maximum");
});

test("readiness counts answered questions and finds the first unanswered one", () => {
  const questions = [single, multi];
  assert.deepEqual(userInputReadiness(questions, {}, {}), { ready: false, answered: 0, total: 2, firstUnanswered: 0 });
  assert.deepEqual(userInputReadiness(questions, { q1: ["A"] }, {}), { ready: false, answered: 1, total: 2, firstUnanswered: 1 });
  assert.deepEqual(userInputReadiness(questions, { q1: ["A"], q2: ["A", "B"] }, {}), { ready: true, answered: 2, total: 2, firstUnanswered: -1 });
  assert.deepEqual(userInputReadiness(questions, { q2: ["A", "B"] }, { q1: "custom" }), { ready: true, answered: 2, total: 2, firstUnanswered: -1 });
});

test("a card taller than the screen scrolls its questions and keeps Send reachable", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const card = app.slice(app.indexOf("function UserInputCard("), app.indexOf("type TranscriptEvent ="));
  assert.ok(card.includes('<div className="user-input-questions"'), "questions live in their own scroll region");
  assert.ok(card.indexOf("user-input-questions") < card.indexOf("user-input-actions"), "actions stay outside the scroll region");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  const cardRule = css.match(/\.user-input-card\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(/min-height:\s*0/.test(cardRule) && /flex:\s*0 1 auto/.test(cardRule), "the card can shrink to the space the transcript leaves it");
  const regionRule = css.match(/\.user-input-questions\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(/overflow-y:\s*auto/.test(regionRule), "tall cards scroll");
  assert.ok(/min-height:\s*0/.test(regionRule) && /overscroll-behavior:\s*contain/.test(regionRule), "the scroll region can shrink and keeps its scroll");
  assert.ok(/padding:\s*4px/.test(regionRule), "the scroll region leaves room so selected highlights are not clipped at its edges");
  const optionRule = css.match(/\.user-input-option\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(/padding:\s*10px 12px/.test(optionRule), "option boxes have breathing room around their content");
});

test("the card and its buttons match the conversation's rounded, slim button style", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  const rule = (selector) => css.match(new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`))?.[0] ?? "";
  assert.ok(/border-radius:\s*7px/.test(rule("user-input-card")), "card corners match the floating chat buttons");
  assert.ok(/border-radius:\s*6px/.test(rule("user-input-option")), "option rows are rounded inside the card");
  const submit = rule("user-input-submit");
  assert.ok(/min-height:\s*30px/.test(submit) && /border-radius:\s*6px/.test(submit) && /font:\s*600 12px/.test(submit), "send is a slim rounded button");
  const skip = rule("user-input-skip");
  assert.ok(/min-height:\s*30px/.test(skip) && /border-radius:\s*6px/.test(skip) && /border:\s*1px solid/.test(skip), "skip is a slim rounded ghost button");
});

test("the card wires readiness, selected states and per-question structure", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const card = app.slice(app.indexOf("function UserInputCard("), app.indexOf("type TranscriptEvent ="));
  assert.ok(card.includes("userInputReadiness(input.questions, picked, free)"), "readiness is computed");
  assert.ok(card.includes("disabled={busy || !readiness.ready}"), "send waits until every question is answered");
  assert.ok(card.includes("questionSelectionHint(question)"), "each question says how to answer it");
  assert.ok(card.includes("is-selected"), "picked options are visually marked");
  assert.ok(card.includes("<fieldset") && card.includes("<legend"), "questions use fieldset/legend semantics");
  assert.ok(card.includes("maxSelections") && card.includes("atMax"), "multi-select stops at its maximum");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(css.includes(".user-input-option.is-selected"), "selected option styling exists");
  assert.ok(css.includes(".user-input-status"), "footer readiness styling exists");
});

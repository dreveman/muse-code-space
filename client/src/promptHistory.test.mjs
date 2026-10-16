import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPromptHistory,
  cleanUserPromptText,
  INITIAL_PROMPT_HISTORY_STATE,
  navigatePromptHistory,
} from "./promptHistory.ts";

test("cleanUserPromptText strips legacy model/effort headers and trims", () => {
  assert.equal(cleanUserPromptText("[Model: muse-spark-1.3 | Effort: high]\n\nFix the test"), "Fix the test");
  assert.equal(cleanUserPromptText("  plain prompt  "), "plain prompt");
});

test("buildPromptHistory collects user events in order and collapses consecutive duplicates", () => {
  const history = buildPromptHistory(
    [
      { kind: "user", content: "first prompt" },
      { kind: "stdout", content: "agent reply" },
      { kind: "user", content: "first prompt" },
      { kind: "user", content: "[Model: muse-spark-1.3 | Effort: high]\n\nsecond prompt" },
    ],
    ["second prompt", "third prompt"],
  );
  assert.deepEqual(history, ["first prompt", "second prompt", "third prompt"]);
});

test("ArrowUp at position 0 steps backward through history and saves the unsent draft", () => {
  const history = ["first", "second", "third"];
  let state = INITIAL_PROMPT_HISTORY_STATE;

  // Not at position 0 -> ignored so normal multiline cursor movement works
  assert.equal(
    navigatePromptHistory({
      state,
      key: "ArrowUp",
      currentText: "my draft",
      selectionStart: 3,
      selectionEnd: 3,
      history,
    }),
    null,
  );

  // Non-collapsed selection -> ignored
  assert.equal(
    navigatePromptHistory({
      state,
      key: "ArrowUp",
      currentText: "my draft",
      selectionStart: 0,
      selectionEnd: 2,
      history,
    }),
    null,
  );

  // At position 0 -> recalls "third" and saves "my draft"
  const step1 = navigatePromptHistory({
    state,
    key: "ArrowUp",
    currentText: "my draft",
    selectionStart: 0,
    selectionEnd: 0,
    history,
  });
  assert.ok(step1);
  assert.equal(step1.value, "third");
  assert.equal(step1.caret, 0);
  assert.deepEqual(step1.state, { index: 2, draft: "my draft" });
  state = step1.state;

  // Pressing ArrowUp again at 0 -> recalls "second"
  const step2 = navigatePromptHistory({
    state,
    key: "ArrowUp",
    currentText: step1.value,
    selectionStart: step1.caret,
    selectionEnd: step1.caret,
    history,
  });
  assert.ok(step2);
  assert.equal(step2.value, "second");
  assert.equal(step2.caret, 0);
  state = step2.state;

  // Pressing ArrowUp again at 0 -> recalls "first"
  const step3 = navigatePromptHistory({
    state,
    key: "ArrowUp",
    currentText: step2.value,
    selectionStart: step2.caret,
    selectionEnd: step2.caret,
    history,
  });
  assert.ok(step3);
  assert.equal(step3.value, "first");
  assert.equal(step3.caret, 0);
  state = step3.state;

  // At the oldest entry -> returns null
  assert.equal(
    navigatePromptHistory({
      state,
      key: "ArrowUp",
      currentText: step3.value,
      selectionStart: 0,
      selectionEnd: 0,
      history,
    }),
    null,
  );
});

test("ArrowDown at the last position steps forward through history and restores the saved draft", () => {
  const history = ["first", "second"];
  const up1 = navigatePromptHistory({
    state: INITIAL_PROMPT_HISTORY_STATE,
    key: "ArrowUp",
    currentText: "unsent draft",
    selectionStart: 0,
    selectionEnd: 0,
    history,
  });
  const up2 = navigatePromptHistory({
    state: up1.state,
    key: "ArrowUp",
    currentText: up1.value,
    selectionStart: 0,
    selectionEnd: 0,
    history,
  });
  assert.equal(up2.value, "first");

  // Not at the end of "first" -> ArrowDown lets native cursor movement reach the end first
  assert.equal(
    navigatePromptHistory({
      state: up2.state,
      key: "ArrowDown",
      currentText: up2.value,
      selectionStart: 0,
      selectionEnd: 0,
      history,
    }),
    null,
  );

  // At the last position of "first" -> moves to "second" with caret at the end
  const down1 = navigatePromptHistory({
    state: up2.state,
    key: "ArrowDown",
    currentText: up2.value,
    selectionStart: up2.value.length,
    selectionEnd: up2.value.length,
    history,
  });
  assert.ok(down1);
  assert.equal(down1.value, "second");
  assert.equal(down1.caret, "second".length);

  // Pressing ArrowDown again at the end of "second" -> restores "unsent draft"
  const down2 = navigatePromptHistory({
    state: down1.state,
    key: "ArrowDown",
    currentText: down1.value,
    selectionStart: down1.caret,
    selectionEnd: down1.caret,
    history,
  });
  assert.ok(down2);
  assert.equal(down2.value, "unsent draft");
  assert.equal(down2.caret, "unsent draft".length);
  assert.deepEqual(down2.state, INITIAL_PROMPT_HISTORY_STATE);

  // Pressing ArrowDown when not browsing history -> returns null
  assert.equal(
    navigatePromptHistory({
      state: down2.state,
      key: "ArrowDown",
      currentText: down2.value,
      selectionStart: down2.caret,
      selectionEnd: down2.caret,
      history,
    }),
    null,
  );
});

test("both composers wire prompt history after @mention handling", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.equal((app.match(/if \(handleMentionKeyDown\(event\)\) return;\s*if \(handleHistoryKeyDown\(event\)\) return;/g) ?? []).length, 2);
});

// Regression tests for the Enter-to-submit policy.
// Run: node --test client/src/keyboardSubmit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
isHardwareKeyEvent,
isVirtualKeyboardEnvironment,
isVirtualKeyboardOpen,
shouldSubmitOnEnter,
} from "./keyboardSubmit.ts";

test("hardware-only keys prove a physical keyboard", () => {
  assert.equal(isHardwareKeyEvent("Tab"), true);
  assert.equal(isHardwareKeyEvent("Escape"), true);
  assert.equal(isHardwareKeyEvent("F5"), true);
  assert.equal(isHardwareKeyEvent("F12"), true);
});

test("ordinary and virtual-shift keys do not prove hardware", () => {
  assert.equal(isHardwareKeyEvent("Enter"), false);
  assert.equal(isHardwareKeyEvent("a"), false);
  assert.equal(isHardwareKeyEvent("Shift"), false);
  assert.equal(isHardwareKeyEvent("ArrowLeft"), false);
});

test("no window means not a virtual-keyboard environment", () => {
  assert.equal(isVirtualKeyboardEnvironment(), false);
});

test("virtual keyboard open only on a real viewport shrink", () => {
  assert.equal(isVirtualKeyboardOpen(400, 800), true);
  assert.equal(isVirtualKeyboardOpen(780, 800), false);
  assert.equal(isVirtualKeyboardOpen(800, 800), false);
  assert.equal(isVirtualKeyboardOpen(NaN, 800), false);
  assert.equal(isVirtualKeyboardOpen(400, 0), false);
});

test("desktop Enter submits, shift and IME never do", () => {
  const desktop = { isComposing: false, shiftKey: false, virtualKeyboard: false, hardwareKeyboardSeen: false };
  assert.equal(shouldSubmitOnEnter(desktop), true);
  assert.equal(shouldSubmitOnEnter({ ...desktop, shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ ...desktop, isComposing: true }), false);
});

test("touch keyboard Enter makes a newline until hardware is seen", () => {
  const touch = { isComposing: false, shiftKey: false, virtualKeyboard: true, hardwareKeyboardSeen: false };
  assert.equal(shouldSubmitOnEnter(touch), false);
  assert.equal(
    shouldSubmitOnEnter({ ...touch, hardwareKeyboardSeen: true }),
    true,
  );
});

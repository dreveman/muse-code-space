// Run: node --test client/src/clipboard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyTextToClipboard } from "./clipboard.ts";

function stubGlobals({ navigator, document }) {
  const previousNavigator = globalThis.navigator;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true });
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  return () => {
    Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
  };
}

function fakeDocument(execResult) {
  const state = { created: null, removed: false, copiedText: null };
  const document = {
    body: { appendChild(el) { state.created = el; } },
    createElement() {
      return {
        value: "",
        style: {},
        setAttribute() {},
        select() {},
        setSelectionRange() {},
        remove() { state.removed = true; },
      };
    },
    execCommand(command) {
      assert.equal(command, "copy");
      state.copiedText = state.created.value;
      return execResult;
    },
  };
  return { document, state };
}

test("uses the Clipboard API when it works", async () => {
  let written = null;
  const restore = stubGlobals({
    navigator: { clipboard: { writeText: async (text) => { written = text; } } },
    document: undefined,
  });
  try {
    assert.equal(await copyTextToClipboard("echo hello"), true);
    assert.equal(written, "echo hello");
  } finally { restore(); }
});

test("falls back to execCommand when the Clipboard API is missing (preview iframe)", async () => {
  const { document, state } = fakeDocument(true);
  const restore = stubGlobals({ navigator: {}, document });
  try {
    assert.equal(await copyTextToClipboard("echo hello"), true);
    assert.equal(state.copiedText, "echo hello");
    assert.equal(state.removed, true, "the helper textarea is cleaned up");
  } finally { restore(); }
});

test("falls back when the Clipboard API rejects, and reports failure honestly", async () => {
  const rejecting = { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } };
  const ok = fakeDocument(true);
  let restore = stubGlobals({ navigator: rejecting, document: ok.document });
  try {
    assert.equal(await copyTextToClipboard("x"), true);
    assert.equal(ok.state.copiedText, "x");
  } finally { restore(); }

  const failing = fakeDocument(false);
  restore = stubGlobals({ navigator: {}, document: failing.document });
  try {
    assert.equal(await copyTextToClipboard("x"), false);
  } finally { restore(); }
});

test("all copy buttons go through the shared helper", () => {
  for (const file of ["./MarkdownCodeBlock.tsx", "./RepoPicker.tsx", "./FileTab.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(source.includes("copyTextToClipboard("), `${file} copies via the shared helper`);
    assert.ok(!source.includes("navigator.clipboard"), `${file} does not touch the raw Clipboard API`);
  }
});

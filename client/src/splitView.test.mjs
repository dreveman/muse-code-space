import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  findLinkedPair,
  linkSessionPair,
  pruneLinkedSessionPairs,
} from "./splitView.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const menu = readFileSync(path.join(root, "WireDebug.tsx"), "utf8");
const css = readFileSync(path.join(root, "theme.css"), "utf8");

test("linkSessionPair links two sessions in [left, right] order and replaces prior links for either session", () => {
  let pairs = [];
  pairs = linkSessionPair(pairs, "sess-a", "sess-b");
  assert.deepEqual(pairs, [["sess-a", "sess-b"]]);

  assert.deepEqual(findLinkedPair(pairs, "sess-a"), {
    leftId: "sess-a",
    rightId: "sess-b",
    partnerId: "sess-b",
    slot: "left",
    partnerSlot: "right",
  });
  assert.deepEqual(findLinkedPair(pairs, "sess-b"), {
    leftId: "sess-a",
    rightId: "sess-b",
    partnerId: "sess-a",
    slot: "right",
    partnerSlot: "left",
  });

  // Linking sess-b with sess-c replaces the sess-a <-> sess-b link.
  pairs = linkSessionPair(pairs, "sess-b", "sess-c");
  assert.deepEqual(pairs, [["sess-b", "sess-c"]]);
  assert.equal(findLinkedPair(pairs, "sess-a"), null);

  // Unlinking via null removes the pair.
  pairs = linkSessionPair(pairs, "sess-c", null);
  assert.deepEqual(pairs, []);
});

test("pruneLinkedSessionPairs removes pairs when either session is archived or deleted", () => {
  const initial = [
    ["sess-a", "sess-b"],
    ["sess-c", "sess-d"],
  ];
  const allActive = new Set(["sess-a", "sess-b", "sess-c", "sess-d"]);
  assert.equal(pruneLinkedSessionPairs(initial, allActive), initial);

  const afterArchive = new Set(["sess-a", "sess-c", "sess-d"]);
  assert.deepEqual(pruneLinkedSessionPairs(initial, afterArchive), [["sess-c", "sess-d"]]);
});

test("SessionMenu includes an expandable Split view section and sidebar renders linked pairs", () => {
  assert.ok(menu.includes('aria-label="Split view"'), "burger menu has expandable Split view section");
  assert.ok(app.includes("session-linked-pair"), "sidebar groups linked conversations together");
  assert.ok(app.includes("LinkedConversationPane"), "detail split renders linked conversation pane");
  assert.ok(css.includes('.detail-split[data-split-conversations="true"]'), "CSS grid supports two conversation panes");
});

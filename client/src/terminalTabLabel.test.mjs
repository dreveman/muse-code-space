import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const side = readFileSync(new URL("./SidePanel.tsx", import.meta.url), "utf8");

test("a lone terminal tab is labeled without a number", () => {
  assert.ok(side.includes("return terminalCount > 1 && tab.number !== null ? `Terminal ${tab.number}` : \"Terminal\";"),
    "numbers appear only when there is more than one terminal tab");
  assert.ok(side.includes("const terminalCount = state.tabs.filter((tab) => tab.kind === \"terminal\").length;"),
    "the count covers terminal tabs only, not file tabs");
  assert.ok(side.includes("const label = sideTabLabel(tab, terminalCount);"),
    "tab rendering passes the terminal count to the label");
});

test("file tabs keep their file name label", () => {
  assert.ok(side.includes('if (tab.kind === "file") return tab.path.split("/").at(-1) || tab.path;'));
});

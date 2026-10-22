import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const component = readFileSync(new URL("./FileTab.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

test("file tabs use accessible icon buttons and operate on original file contents", () => {
  for (const label of ["Refresh file", "Download file"]) assert.ok(component.includes(`aria-label="${label}"`));
  assert.ok(component.includes('aria-label={copied ? "Copied file contents" : "Copy file contents"}'));
  assert.ok(component.includes("<RefreshIcon />") && component.includes("<DownloadIcon />") && component.includes("<CopyIcon />"));
  assert.ok(component.includes("copyTextToClipboard(content)"), "copy the exact source, not the rendered lines and numbers");
  assert.ok(component.includes('new Blob([content], { type: "text/plain;charset=utf-8" })'), "download the exact text snapshot");
  assert.ok(component.includes('link.download = path.split("/").at(-1) || "artifact.txt"'), "download retains the file name without a directory path");
  assert.ok(component.includes('disabled={loading || content === null}'), "copy and download are unavailable without a loaded file");
  assert.ok(css.includes(".file-tab-actions button svg { width: 15px; height: 15px; }"));
});

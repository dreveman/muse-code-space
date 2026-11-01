import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDirectory } from "../../pilot/files.mjs";
const component = readFileSync(new URL("./FileTab.tsx", import.meta.url), "utf8");
const browserComponent = readFileSync(new URL("./FileBrowserPanel.tsx", import.meta.url), "utf8");
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

test("listWorkspaceDirectory lists folders first, detects images, skips .git/node_modules/symlinks, and refuses path traversal", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-file-browser-"));
  try {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "README.md"), "# hello\n");
    writeFileSync(join(dir, "logo.png"), "png-bytes");
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
    symlinkSync(join(dir, "README.md"), join(dir, "linked.md"));

    const root = listWorkspaceDirectory(dir, "");
    assert.equal(root.ok, true);
    assert.deepEqual(
      root.entries.map((e) => ({ name: e.name, kind: e.kind, isImage: e.isImage })),
      [
        { name: "src", kind: "directory", isImage: false },
        { name: "logo.png", kind: "file", isImage: true },
        { name: "README.md", kind: "file", isImage: false },
      ],
    );

    const sub = listWorkspaceDirectory(dir, "src");
    assert.equal(sub.ok, true);
    assert.equal(sub.path, "src");
    assert.equal(sub.entries.length, 1);
    assert.equal(sub.entries[0].path, "src/index.ts");

    assert.equal(listWorkspaceDirectory(dir, "../outside").ok, false);
    assert.equal(listWorkspaceDirectory(dir, "/etc").ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(browserComponent.includes("listSessionDirectory") && browserComponent.includes("Filter files in folder"), "FileBrowserPanel queries listSessionDirectory and supports folder filtering");
  const sidePanel = readFileSync(new URL("./SidePanel.tsx", import.meta.url), "utf8");
  assert.ok(sidePanel.includes('tab.kind === "files"') && sidePanel.includes("<FileBrowserView"), "SidePanel wires the Files browser tab");
});

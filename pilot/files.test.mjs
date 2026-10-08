import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile, MAX_VIEW_FILE_BYTES } from "./files.mjs";
const root = mkdtempSync(join(tmpdir(), "mcs-file-tab-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "test.ts"), "const x = 1;\n");
writeFileSync(join(root, "bom.txt"), "\uFEFFhello\n");
writeFileSync(join(root, "bad.bin"), Buffer.from([0xff, 0x00]));
writeFileSync(join(root, "big.txt"), "a".repeat(MAX_VIEW_FILE_BYTES + 1));
symlinkSync(join(root, "src", "test.ts"), join(root, "link.ts"));
symlinkSync(tmpdir(), join(root, "outside"));

test("read-only tabs receive only bounded UTF-8 regular files inside the saved workspace", () => {
  assert.deepEqual(readWorkspaceFile(root, "src/test.ts"), { ok: true, path: "src/test.ts", content: "const x = 1;\n" });
  assert.equal(readWorkspaceFile(root, "bom.txt").content, "\uFEFFhello\n", "reading a file never discards its UTF-8 BOM");
  for (const requested of ["../other", "/etc/passwd", "src/../../other", "src\\test.ts", "", "src/test.ts\0"]) {
    assert.equal(readWorkspaceFile(root, requested).ok, false, `reject ${JSON.stringify(requested)}`);
  }
  for (const requested of ["link.ts", "outside/other", "src", "bad.bin", "big.txt", "missing.txt"]) {
    assert.equal(readWorkspaceFile(root, requested).ok, false, `reject ${requested}`);
  }
  assert.equal(readWorkspaceFile(root, "link.ts").code, 400);
  assert.equal(readWorkspaceFile(root, "big.txt").code, 413);
});

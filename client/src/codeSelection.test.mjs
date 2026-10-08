import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

test("file previews, edit diffs and file tabs copy code spans but not their line-number gutters", () => {
  const code = read("./codeSelection.ts");
  const file = read("./CodeFileLines.tsx");
  const diff = read("./RenderedToolDiff.tsx");
  const search = read("./ToolSearchView.tsx");
  const css = read("./theme.css");
  for (const component of [file, diff, search]) assert.ok(component.includes("onCopy={copyCodeSelection}"));
  assert.ok(file.includes('className={`tool-diff tool-file-view${tab ? " file-tab-content"'), "historical output and file tabs use the same copy handler");
  assert.ok(code.includes('".tool-file-code, .tool-diff-code, .tool-search-code"'), "clipboard text is built only from source spans");
  assert.ok(code.includes('slice.compareBoundaryPoints(Range.START_TO_START, content)') && code.includes('slice.compareBoundaryPoints(Range.END_TO_END, content)'), "partial selections keep their first and last line boundaries");
  assert.ok(code.includes('chunks.length ? chunks.join("\\n") : null'), "filename-only selections keep native copy");
  for (const gutter of ["tool-file-number", "tool-diff-gutter", "tool-search-number"]) {
    assert.match(css, new RegExp(`\\.${gutter} \\{[^}]*user-select: none; -webkit-user-select: none;`), `${gutter} is not selectable`);
  }
});

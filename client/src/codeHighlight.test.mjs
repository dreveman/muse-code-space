import { test } from "node:test";
import assert from "node:assert/strict";
import { codeLanguageForPath } from "./codeLanguage.ts";
import { highlightCode } from "./codeHighlight.ts";

test("only explicitly supported file extensions select a language", () => {
  assert.equal(codeLanguageForPath("src/App.tsx"), "tsx");
  assert.equal(codeLanguageForPath("tools/pilot.mjs"), "javascript");
  assert.equal(codeLanguageForPath("schema.sql"), "sql");
  for (const path of ["hello.unknown", "widget.h", "README", ".env", "file.", "bad\n.ts", null]) {
    assert.equal(codeLanguageForPath(path), null, `no guess for ${path}`);
  }
});

test("known files tokenize in both themes and preserve the source exactly", async () => {
  const source = "const x: number = 3;\nconsole.log(x)";
  for (const theme of ["light", "dark"]) {
    const lines = await highlightCode(source, "a.ts", theme);
    assert.equal(lines.length, 2);
    assert.equal(lines.map((line) => line.map((token) => token.text).join("")).join("\n"), source);
    assert.ok(lines[0].some((token) => token.color && token.color !== lines[0][0].color), "distinct syntax tokens");
  }
  assert.equal(await highlightCode(source, "a.unknown", "light"), null);
  assert.equal(await highlightCode("x".repeat(129 * 1024), "a.ts", "light"), null);
});

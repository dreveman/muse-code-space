import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codeLanguageForPath, codeLanguageForTag } from "./codeLanguage.ts";
import { highlightCode, highlightCodeForLanguage } from "./codeHighlight.ts";

test("only explicitly supported file extensions select a language", () => {
  assert.equal(codeLanguageForPath("src/App.tsx"), "tsx");
  assert.equal(codeLanguageForPath("tools/pilot.mjs"), "javascript");
  assert.equal(codeLanguageForPath("schema.sql"), "sql");
  for (const path of ["hello.unknown", "widget.h", "README", ".env", "file.", "bad\n.ts", null]) {
    assert.equal(codeLanguageForPath(path), null, `no guess for ${path}`);
  }
});

test("only explicitly supported fence tags select a language", () => {
  for (const [tag, lang] of [["bash", "shellscript"], ["sh", "shellscript"], ["shell", "shellscript"], ["zsh", "shellscript"], ["ts", "typescript"], ["typescript", "typescript"], ["tsx", "tsx"], ["js", "javascript"], ["py", "python"], ["rs", "rust"], ["BASH", "shellscript"]]) {
    assert.equal(codeLanguageForTag(tag), lang, `tag ${tag}`);
  }
  for (const tag of ["text", "markdown", "md", "c++", "brainfuck", "made-up-lang", "", null, undefined, "bash ts"]) {
    assert.equal(codeLanguageForTag(tag), null, `no guess for ${tag}`);
  }
});

test("a shell fence tokenizes in both themes and preserves the source exactly", async () => {
  const source = 'echo "hello"\npwd';
  const lang = codeLanguageForTag("bash");
  for (const theme of ["light", "dark"]) {
    const lines = await highlightCodeForLanguage(source, lang, theme);
    assert.equal(lines.length, 2);
    assert.equal(lines.map((line) => line.map((token) => token.text).join("")).join("\n"), source);
    assert.ok(lines.flat().some((token) => token.color), "shell tokens are coloured");
  }
  assert.equal(await highlightCodeForLanguage(source, codeLanguageForTag("made-up-lang"), "light"), null);
});

test("Markdown fences render through the highlighting code block", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const block = readFileSync(new URL("./MarkdownCodeBlock.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("<MarkdownCodeBlock") && app.includes("languageTag={fenceMatch[1] || null}"), "the fence tag reaches the code block");
  assert.ok(block.includes("codeLanguageForTag(languageTag)"), "unknown tags stay plain");
  assert.ok(block.includes("highlightCodeForLanguage(code, lang, theme)"), "known tags highlight like file views");
});

test("the fake pilot can demo highlighted and plain fences", () => {
  const fakePilot = readFileSync(new URL("../../dev/fake-pilot.ts", import.meta.url), "utf8");
  assert.ok(fakePilot.includes('trigger: "code-fence / markdown-code"'), "help inventory lists the trigger");
  assert.ok(fakePilot.includes("/\\b(?:code-fence|markdown-code)\\b/i"), "runTurn matches the trigger");
  assert.ok(fakePilot.includes("```bash") && fakePilot.includes("```made-up-lang"), "demo reply has a highlighted and a plain fence");
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

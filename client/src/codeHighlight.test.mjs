import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codeLanguageForPath, codeLanguageForTag, fenceTagForLine } from "./codeLanguage.ts";
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

test("any info string opens a fence, even one that names no known language", () => {
  assert.equal(fenceTagForLine("```bash"), "bash");
  assert.equal(fenceTagForLine("```made-up-lang"), "made-up-lang");
  assert.equal(fenceTagForLine("```c++"), "c++");
  assert.equal(fenceTagForLine("```python3"), "python3");
  assert.equal(fenceTagForLine("```"), "");
  assert.equal(fenceTagForLine("  ```ts  "), "ts");
  assert.equal(fenceTagForLine("``bash"), undefined);
  assert.equal(fenceTagForLine("```bash extra"), undefined);
  assert.equal(fenceTagForLine("just text"), undefined);
  // Unknown tags open a plain block, never a highlighted one.
  assert.equal(codeLanguageForTag(fenceTagForLine("```made-up-lang")), null);
  assert.equal(codeLanguageForTag(fenceTagForLine("```c++")), null);
});

test("the Markdown renderer detects fences with fenceTagForLine", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("fenceTagForLine(trimmed)"), "fence detection accepts hyphenated/unknown tags");
  assert.ok(!app.includes("/^```(\\w*)"), "the word-character-only fence regex is gone");
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
  assert.ok(app.includes("<MarkdownCodeBlock") && app.includes("languageTag={fenceTag || null}"), "the fence tag reaches the code block");
  assert.ok(block.includes("codeLanguageForTag(languageTag)"), "unknown tags stay plain");
  assert.ok(block.includes("highlightCodeForLanguage(code, lang, theme)"), "known tags highlight like file views");
});

test("Markdown code blocks have a copy button, hover-only on fine pointers", () => {
  const block = readFileSync(new URL("./MarkdownCodeBlock.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(block.includes("copyTextToClipboard(code)"), "the button copies the exact block source via the shared helper");
  assert.ok(block.includes('className="markdown-code-copy"'), "the button is part of the code block");
  assert.ok(block.includes('aria-label={copied ? "Copied" : "Copy code"}'), "copy state is announced");
  assert.ok(block.includes('title={copied ? "Copied" : "Copy"}'), "the tooltip just says Copy");
  assert.ok(css.includes(".markdown-code-copy { position: absolute; right: 6px; bottom: 6px;"), "button sits in the bottom right corner");
  assert.ok(css.includes("@media (hover: hover) and (pointer: fine)"), "hover reveal is limited to non-touch devices");
  assert.ok(css.includes(".markdown-code-block:hover .markdown-code-copy"), "hovering the block reveals the button");
});

test("the code block copy button matches the repo dialog copy button", () => {
  const block = readFileSync(new URL("./MarkdownCodeBlock.tsx", import.meta.url), "utf8");
  const repoPicker = readFileSync(new URL("./RepoPicker.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  const repoRule = /\.repo-manage-copy \{([^}]*)\}/.exec(css)?.[1] ?? "";
  const codeRule = /\.markdown-code-copy \{([^}]*)\}/.exec(css)?.[1] ?? "";
  for (const shared of ["width: 24px; height: 24px;", "border: 0;", "border-radius: 5px;", "background: transparent;", "color: var(--terminal-dim);"]) {
    assert.ok(repoRule.includes(shared) && codeRule.includes(shared), `both copy buttons share ${shared}`);
  }
  assert.ok(css.includes(".markdown-code-copy:hover { background: var(--terminal-faint); color: var(--terminal-text); }"), "same hover treatment as the repo dialog");
  // Identical icon artwork as the repo dialog's CopyButtonIcon/CopiedCheckIcon.
  const iconPaths = (source, fn) => {
    const start = source.indexOf(`function ${fn}(`);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    return [...body.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  };
  const blockPaths = new Set([...block.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]));
  for (const fn of ["CopyButtonIcon", "CopiedCheckIcon"]) {
    const paths = iconPaths(repoPicker, fn);
    assert.ok(paths.length > 0 && paths.every((d) => blockPaths.has(d)), `${fn} artwork matches the repo dialog`);
  }
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

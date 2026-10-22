import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMarkdownTable } from "./markdownTable.ts";

test("parses a GFM table with alignments and body rows", () => {
  const lines = ["| Tool | Formatter |", "| :--- | ---: |", "| bash | Yes |", "| search | No |", "", "after"];
  const table = parseMarkdownTable(lines, 0);
  assert.deepEqual(table.header, ["Tool", "Formatter"]);
  assert.deepEqual(table.alignments, ["left", "right"]);
  assert.deepEqual(table.rows, [["bash", "Yes"], ["search", "No"]]);
  assert.equal(table.endIndex, 4, "parsing stops before the blank line");
});

test("leading and trailing pipes are optional", () => {
  const table = parseMarkdownTable(["A | B", "--- | :---:", "1 | 2"], 0);
  assert.deepEqual(table.header, ["A", "B"]);
  assert.deepEqual(table.alignments, [null, "center"]);
  assert.deepEqual(table.rows, [["1", "2"]]);
});

test("escaped pipes and pipes inside code spans do not split cells", () => {
  const table = parseMarkdownTable(["| A | B |", "| --- | --- |", "| a \\| b | `x|y` |"], 0);
  assert.deepEqual(table.rows, [["a | b", "`x|y`"]]);
});

test("short rows are padded and long rows truncated to the header width", () => {
  const table = parseMarkdownTable(["| A | B |", "| --- | --- |", "| 1 |", "| 1 | 2 | 3 |"], 0);
  assert.deepEqual(table.rows, [["1", ""], ["1", "2"]]);
});

test("a delimiter row that does not match the header is not a table", () => {
  assert.equal(parseMarkdownTable(["| A | B |", "| --- |"], 0), null);
  assert.equal(parseMarkdownTable(["| A | B |", "| no | dashes |"], 0), null);
  assert.equal(parseMarkdownTable(["just a | paragraph"], 0), null);
  assert.equal(parseMarkdownTable(["| A |", "| --- |"], 1), null, "no delimiter line left");
});

test("tables stop at the first non-table line and can start mid-document", () => {
  const lines = ["intro", "| A |", "| --- |", "| 1 |", "plain text after"];
  const table = parseMarkdownTable(lines, 1);
  assert.deepEqual(table.rows, [["1"]]);
  assert.equal(table.endIndex, 4);
});

test("Markdown renders parsed tables with aligned cells", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(app.includes("parseMarkdownTable(lines, i)"), "the Markdown loop tries the table parser");
  assert.ok(app.includes("<table>") && app.includes("markdown-table-wrap"), "tables render in a scrollable wrapper");
  assert.ok(app.includes("renderInlineText(cell"), "cell text keeps inline formatting");
  assert.ok(css.includes(".markdown-body table") && css.includes(".markdown-table-wrap"), "tables are styled");
});

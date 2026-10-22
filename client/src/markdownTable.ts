// GFM-style pipe tables for the hand-rolled Markdown renderer. Conservative
// by design: a header row only becomes a table when the next line is a
// delimiter row (`---`, `:--`, `:-:`, `--:`) with the same cell count, so
// ordinary paragraphs containing pipes keep rendering as text.
export type TableAlignment = "left" | "center" | "right" | null;
export type MarkdownTable = {
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
  /** Index of the first line after the table. */
  endIndex: number;
};

// Splits one table row into trimmed cells. Escaped pipes (`\|`) stay in the
// cell as a literal pipe, and pipes inside `code spans` never split.
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let codeRun = 0; // backtick run length of the open code span (0 = outside)
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 0;
      while (line[i + run] === "`") run++;
      cell += "`".repeat(run);
      i += run - 1;
      if (codeRun === 0) codeRun = run;
      else if (run === codeRun) codeRun = 0;
      continue;
    }
    if (ch === "|" && codeRun === 0) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  // Optional outer pipes produce empty edge cells; drop exactly those.
  if (cells.length > 1 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 1 && cells.at(-1)!.trim() === "") cells.pop();
  return cells.map((value) => value.trim());
}

function parseDelimiter(line: string): TableAlignment[] | null {
  if (!line.includes("-")) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    alignments.push(cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null);
  }
  return alignments;
}

export function parseMarkdownTable(lines: readonly string[], start: number): MarkdownTable | null {
  const headerLine = lines[start];
  const delimiterLine = lines[start + 1];
  if (headerLine === undefined || delimiterLine === undefined) return null;
  if (!headerLine.includes("|")) return null;
  const header = splitRow(headerLine);
  const alignments = parseDelimiter(delimiterLine);
  if (!alignments || header.length === 0 || alignments.length !== header.length) return null;
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || !line.includes("|")) break;
    const cells = splitRow(line);
    rows.push(header.map((_, index) => cells[index] ?? ""));
    i++;
  }
  return { header, alignments, rows, endIndex: i };
}

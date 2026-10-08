// Only a verified structured tool_patch or strict unified-diff text may be
// presented as a diff. Never derive an "applied" change from edit arguments.
export const PATCH_LIMIT_BYTES = 4 * 1024 * 1024;
export type DiffLine = { kind: "context" | "add" | "remove" | "meta"; text: string };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = { path: string; oldPath: string; newPath: string; hunks: DiffHunk[] };
export type DiffDocument = { files: DiffFile[]; source: "patch" | "text" };

function safePath(path: unknown): string | null {
  if (typeof path !== "string" || !path || path.length > 1000 || /[\x00-\x1f\x7f<>]/.test(path)) return null;
  // Show the relative path if the patch supplies one; strip private prefixes
  // from absolute paths while preserving the file identity.
  if (path === "/dev/null") return path;
  return path.startsWith("/") ? path.split("/").at(-1) || null : path;
}
function line(input: unknown): DiffLine | null {
  if (typeof input !== "string" || input.length > 16000) return null;
  if (input.startsWith("+")) return { kind: "add", text: input };
  if (input.startsWith("-")) return { kind: "remove", text: input };
  if (input.startsWith(" ")) return { kind: "context", text: input };
  if (input.startsWith("\\ No newline")) return { kind: "meta", text: input };
  return null;
}
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

export function parseStructuredPatch(raw: string): DiffDocument | null {
  if (new TextEncoder().encode(raw).length > PATCH_LIMIT_BYTES) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object" || !Array.isArray((data as {files?: unknown}).files)) return null;
  const rawFiles = (data as {files: unknown[]}).files;
  if (rawFiles.length === 0 || rawFiles.length > 100) return null;
  const files: DiffFile[] = [];
  let totalLines = 0;
  for (const value of rawFiles) {
    if (!value || typeof value !== "object") return null;
    const f = value as Record<string, unknown>;
    const path = safePath(f.path);
    if (!path || !Array.isArray(f.hunks) || f.hunks.length === 0 || f.hunks.length > 500) return null;
    const hunks: DiffHunk[] = [];
    for (const value of f.hunks) {
      if (!value || typeof value !== "object") return null;
      const h = value as Record<string, unknown>;
      if (![h.oldStart,h.oldLines,h.newStart,h.newLines].every(safeCount) || !Array.isArray(h.lines)) return null;
      totalLines += h.lines.length;
      if (totalLines > 20000) return null;
      const lines = h.lines.map(line);
      if (lines.some(x => !x)) return null;
      const typed = lines as DiffLine[];
      if (typed.filter(l => l.kind === "context" || l.kind === "remove").length !== h.oldLines ||
          typed.filter(l => l.kind === "context" || l.kind === "add").length !== h.newLines) return null;
      hunks.push({ header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines: typed });
    }
    files.push({ path, oldPath: path, newPath: path, hunks });
  }
  return { files, source: "patch" };
}

export function parseUnifiedDiff(raw: string): DiffDocument | null {
  if (raw.length > 200_000) return null;
  const rows = raw.replace(/\r\n/g,"\n").split("\n");
  const files: DiffFile[] = [];
  let file: DiffFile | null = null, hunk: DiffHunk | null = null;
  let totalLines = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.startsWith("diff --git ") || row.startsWith("index ")) continue;
    if (row.startsWith("--- ") && rows[i+1]?.startsWith("+++ ")) {
      const oldPath=safePath(row.slice(4).replace(/^a\//,"")), newPath=safePath(rows[++i]!.slice(4).replace(/^b\//,""));
      if (!oldPath || !newPath || files.length >= 100) return null;
      file={path:newPath==="/dev/null"?oldPath:newPath,oldPath,newPath,hunks:[]};files.push(file);hunk=null;continue;
    }
    const match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (match && file) {
      if (file.hunks.length >= 500) return null;
      hunk={header:row,lines:[]};file.hunks.push(hunk);continue;
    }
    if (hunk) {
      if (i===rows.length-1 && !row) continue; // final newline
      const parsed=line(row);if (!parsed || ++totalLines>20000) return null;
      hunk.lines.push(parsed);continue;
    }
    if (row.trim() && (!file || !/^(?:new file mode|deleted file mode|rename (?:from|to)|similarity index) /.test(row))) return null;
  }
  if (!files.length || !files.every(f=>f.hunks.length)) return null;
  for (const f of files) for (const h of f.hunks) {
    const counts = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header)!;
    if (h.lines.filter(l=>l.kind==="context"||l.kind==="remove").length!==Number(counts[2]??1) ||
        h.lines.filter(l=>l.kind==="context"||l.kind==="add").length!==Number(counts[4]??1)) return null;
  }
  return { files, source: "text" };
}

export type DiffDisplayLine = { kind: DiffLine["kind"] | "file" | "hunk"; text: string; lineNumber: number | null };
export function diffDisplayLines(doc: DiffDocument): DiffDisplayLine[] {
  const rows: DiffDisplayLine[] = [];
  for (const file of doc.files) {
    rows.push({ kind: "file", text: `--- ${file.oldPath}`, lineNumber: null });
    rows.push({ kind: "file", text: `+++ ${file.newPath}`, lineNumber: null });
    for (const hunk of file.hunks) {
      rows.push({ kind: "hunk", text: hunk.header, lineNumber: null });
      const starts = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
      let oldLine = Number(starts?.[1] ?? 0), newLine = Number(starts?.[2] ?? 0);
      for (const line of hunk.lines) {
        let lineNumber: number | null = null;
        if (line.kind === "remove") lineNumber = oldLine++;
        else if (line.kind === "add") lineNumber = newLine++;
        else if (line.kind === "context") { lineNumber = newLine++; oldLine++; }
        rows.push({ ...line, lineNumber });
      }
    }
  }
  return rows;
}

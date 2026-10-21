import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileMetric, filePreviewForTool, imagePreviewForTool, toolPresentation } from "./toolPresentation.ts";

const details = (tool, args, output, status = "completed") => ({ tool, status, args, output,
  failureReason: null, truncated: false, outputRef: null, patchRef: null, patchSummary: null });
const ctx = (d) => ({ label: `${d.tool} · old label`, details: d, running: d.status === "inProgress", workspaceRoot: "/tmp/session" });

test("read_file strips the verified wrapper and uses the source line numbers", () => {
  const d = details("read_file", '{"path":"notes.txt"}', "Read text file `notes.txt`.\n1|ALPHA\n2|BETA\n3|GAMMA");
  const preview = filePreviewForTool(d);
  assert.equal(preview.path, "notes.txt", "real read result selects the filename");
  assert.deepEqual(preview.lines, [{ number: 1, text: "ALPHA" }, { number: 2, text: "BETA" }, { number: 3, text: "GAMMA" }]);
  assert.equal(fileMetric(preview), "3 lines");
  assert.equal(fileMetric({ ...preview, partial: true }), "3+ lines", "truncated reads never claim a full file size");
  assert.deepEqual(toolPresentation(ctx(d)), { adapterId: "read", name: "Read", detail: "notes.txt", view: "file", showDuration: false, metric: "3 lines", command: null, emphasizeName: false });
  const forty = details("read_file", d.args, "Read text file `notes.txt`.\n" + Array.from({ length: 40 }, (_, i) => `${i + 1}|line ${i + 1}`).join("\n"));
  assert.equal(fileMetric(filePreviewForTool(forty)), "40 lines");
  assert.equal(filePreviewForTool(details("read_file", d.args, "unknown response")), null, "unrecognized output remains plain text");
  assert.equal(filePreviewForTool(details("read_file", d.args, d.output, "failed")), null);
});

test("binary image reads select a thumbnail preview instead of a numbered file view", () => {
  const png = details("read_file", '{"path":"picture.png"}', "Read image file `picture.png`.");
  assert.deepEqual(imagePreviewForTool(png), { path: "picture.png" });
  assert.equal(filePreviewForTool(png), null, "binary image output is never a numbered text preview");
  assert.deepEqual(imagePreviewForTool(details("read_file", '{"path":"photo.JPG"}', "Read image file `photo.JPG`.")), { path: "photo.JPG" });
  assert.equal(imagePreviewForTool(details("read_file", '{"path":"diagram.svg"}', "Read text file `diagram.svg`.\n1|<svg/>")), null, "SVG source keeps its numbered text view");
  assert.equal(imagePreviewForTool(details("read_file", '{"path":"notes.md"}', "Read text file `notes.md`.\n1|# Notes")), null, "plain text files keep their numbered view");
  assert.equal(imagePreviewForTool(details("write_file", '{"path":"picture.png","content":"x"}', "wrote 1 bytes to picture.png")), null, "only reads get an image thumbnail");
  assert.equal(imagePreviewForTool(details("read_file", '{"path":"picture.png"}', "Read image file `picture.png`.", "failed")), null);
  assert.equal(imagePreviewForTool(details("read_file", '{broken', "Read image file `picture.png`.")), null, "unparseable args fail closed");
  assert.equal(imagePreviewForTool(details("read_file", '{"path":"https://example.com/picture.png"}', "Read image file.")), null, "remote paths fail closed");
});

test("image thumbnail loads workspace bytes like Markdown images and opens the viewer on click", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("./RenderedToolImage.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(app.includes("imagePreviewForTool(displayDetails)") && app.includes("<ToolImageView sessionId={sessionId} preview={imagePreview}"));
  assert.ok(component.includes("api.readSessionImage") && component.includes('queryKey: ["session-image", sessionId, relative]'), "same cache key and loader as Markdown images");
  assert.ok(component.includes("onOpenFile(relative)") && component.includes('className="markdown-image-button"'), "click opens the image viewer tab");
  assert.ok(css.includes(".tool-image-thumbnail { max-width: min(100%, 320px); }"), "thumbnail is smaller than a full Markdown image");
});

test("write_file shows only accepted content and substitutes a line or KB metric for time", () => {
  const d = details("write_file", JSON.stringify({ path: "notes.txt", content: "ALPHA\nBETA\nGAMMA\n" }), "wrote 17 bytes to notes.txt");
  const preview = filePreviewForTool(d);
  assert.equal(preview.path, "notes.txt", "verified write selects the submitted filename");
  assert.equal(preview.lines.length, 3);
  assert.equal(preview.lines.at(-1).text, "GAMMA");
  assert.equal(fileMetric(preview), "3 lines");
  assert.deepEqual(toolPresentation(ctx(d)), { adapterId: "write", name: "Wrote", detail: "notes.txt", view: "file", showDuration: false, metric: "3 lines", command: null, emphasizeName: false });
  const waiting = { ...d, status: "inProgress" };
  assert.equal(filePreviewForTool(waiting), null, "pending arguments are not presented as applied content");
  assert.equal(toolPresentation(ctx(waiting)).name, "Writing");
  assert.equal(toolPresentation(ctx(waiting)).metric, null);
  assert.equal(filePreviewForTool({ ...d, failureReason: "permission denied", status: "failed" }), null);
  assert.equal(filePreviewForTool(details("write_file", d.args, "could not write file")), null, "unconfirmed arguments are never presented as written content");
  assert.equal(fileMetric(filePreviewForTool(details("write_file", JSON.stringify({ content: "x".repeat(12 * 1024) }), `wrote ${12 * 1024} bytes to notes.txt`))), "12 KB");
  assert.equal(fileMetric(filePreviewForTool(details("write_file", JSON.stringify({ content: "" }), "wrote 0 bytes to notes.txt"))), "0 lines");
});

test("file views use a scrollable, numbered neutral pane and never show a final duration", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  const component = readFileSync(new URL("./RenderedToolFile.tsx", import.meta.url), "utf8");
  const shared = readFileSync(new URL("./CodeFileLines.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("presentation.metric ? (") && app.includes("<ToolFileView preview={filePreview} workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} />"));
  assert.ok(component.includes("<CodeFileLines") && shared.includes('className={`tool-diff tool-file-view') && shared.includes("{line.number}"));
  assert.ok(component.includes("preview.path.slice(workspaceRoot.length + 1)"), "absolute paths are only opened if inside this session's saved workspace");
  assert.ok(component.indexOf("<CodeFileLines") < component.indexOf('>Open {relative.split("/").at(-1)}'), "open button sits below the Read/Wrote preview box");
  assert.ok(css.includes('.tool-file-actions { display: flex; justify-content: flex-end; margin-top: 5px; }'), "button has a small gap below the preview");
  const metric = css.match(/\.tool-file-metric\s*\{[^}]*\}/)?.[0] ?? "";
  const open = css.match(/\.tool-more\.tool-open-file\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(metric.includes('font: 11px/1 var(--mono)') && open.includes('font: 11px/1 var(--mono)') && open.includes('color: var(--terminal-dim)'), "open filename matches the normal-weight line count");
  assert.ok(css.indexOf('.tool-more.tool-open-file {') > css.indexOf('.tool-more {'), "the override wins over the generic bold tool button");
  assert.ok(!/background:|padding:|text-decoration:/.test(open) && !css.includes('.tool-more.tool-open-file:hover'), "generic button surface and hover remain intact, not a link");
  assert.ok(!shared.includes("tool-diff-sign") && !shared.includes("dangerouslySetInnerHTML"));
  assert.ok(shared.includes("complete && lines[0]?.number === 1") && shared.includes("codeLanguageForPath(path) !== null"), "partial and unknown-language files stay plain");
  assert.ok(/\.tool-file-line\s*\{[^}]*grid-template-columns:\s*var\(--file-gutter-width, 2ch\) max-content/.test(css));
});

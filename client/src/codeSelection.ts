import type { ClipboardEvent } from "react";

// The visible gutters are useful for reading but are not source text. Build
// clipboard plain text from the code spans only, preserving partial first/
// last lines and blank lines even when a selection crosses many grid rows.
export function selectedCodeText(root: Element, range: Range): string | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  try {
    const chunks: string[] = [];
    for (const code of Array.from(root.querySelectorAll<HTMLElement>(".tool-file-code, .tool-diff-code, .tool-search-code"))) {
      if (!range.intersectsNode(code)) continue;
      const content = code.ownerDocument.createRange();
      content.selectNodeContents(code);
      const slice = range.cloneRange();
      if (slice.compareBoundaryPoints(Range.START_TO_START, content) < 0) slice.setStart(content.startContainer, content.startOffset);
      if (slice.compareBoundaryPoints(Range.END_TO_END, content) > 0) slice.setEnd(content.endContainer, content.endOffset);
      chunks.push(slice.toString());
    }
    return chunks.length ? chunks.join("\n") : null; // let filename/notes-only selections copy normally
  } catch { return null; } // unfamiliar Range implementation: leave native copy intact
}

export function copyCodeSelection(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const text = selectedCodeText(event.currentTarget, selection.getRangeAt(0));
  if (text === null || !event.clipboardData) return;
  try {
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  } catch { /* native copy and nonselectable gutters are still the fallback */ }
}

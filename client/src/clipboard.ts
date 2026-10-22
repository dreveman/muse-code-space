// Copying to the clipboard from the composer/preview is not guaranteed:
// the Clipboard API only exists in secure contexts, and the host shows the
// app in a sandboxed preview iframe (blob:null origin), where
// `navigator.clipboard` is undefined and writes would reject anyway. Fall
// back to the legacy select-and-`execCommand("copy")` path, which works
// from a user gesture in non-secure contexts. Returns whether the text was
// actually copied, so callers only show their "Copied" state on success.
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / document not focused: try the fallback below.
    }
  }
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body || typeof doc.execCommand !== "function") return false;
  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Off-screen but selectable: display:none elements cannot be copied.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  doc.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

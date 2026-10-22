import { useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "./clipboard";

// Same artwork as the repo dialog's CopyButtonIcon/CopiedCheckIcon
// (RepoPicker.tsx); sizing lives in .message-copy-markdown (theme.css).
function CopyMarkdownIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16" color="currentColor" aria-hidden="true">
      <path d="M14.238 4.333a.764.764 0 0 0-.762.762v6.095a3.047 3.047 0 0 1-3.048 3.048H6.62a.764.764 0 0 0-.762.762c0 .419.343.761.762.761h3.81a4.575 4.575 0 0 0 4.57-4.57V5.094a.764.764 0 0 0-.761-.762z" />
      <path d="M11.952 10.81V2.427A1.905 1.905 0 0 0 10.047.523H3.19a1.905 1.905 0 0 0-1.904 1.905v8.381c0 1.052.853 1.905 1.904 1.905h6.857a1.905 1.905 0 0 0 1.905-1.905zm-9.143 0V2.427c0-.213.168-.38.381-.38h6.857c.214 0 .381.167.381.38v8.381c0 .214-.167.381-.38.381H3.19a.377.377 0 0 1-.38-.38z" />
      <path d="M8.143 3.571H5.095a.764.764 0 0 0-.762.762c0 .419.343.762.762.762h3.048c.419 0 .762-.343.762-.762a.764.764 0 0 0-.762-.762zM6.619 6.619H5.095a.764.764 0 0 0-.762.762c0 .419.343.761.762.761H6.62c.419 0 .762-.342.762-.761a.764.764 0 0 0-.762-.762z" />
    </svg>
  );
}

function CopiedCodeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
      <path d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  );
}

// Copies the raw Markdown of one agent response (the exact event content,
// never the rendered or display-transformed form).
export function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);
  const copy = async () => {
    if (!await copyTextToClipboard(text)) return;
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" className="message-copy-markdown"
      title={copied ? "Copied" : "Copy markdown"}
      aria-label={copied ? "Copied" : "Copy markdown"}
      onClick={() => { void copy(); }}>
      {copied ? <CopiedCodeIcon /> : <CopyMarkdownIcon />}
    </button>
  );
}

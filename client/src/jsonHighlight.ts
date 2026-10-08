import type { ToolDetails } from "../../server/src/toolDetails";
export type JsonToken = { text: string; kind: "plain" | "key" | "string" | "number" | "literal" };

export function formatJsonTranscript(details: ToolDetails | null, output: string | null): string | null {
  if (!details || !output || output.length > 200_000) return null;
  let result: unknown;
  try { result = JSON.parse(output); } catch { return null; }
  let args = details.args;
  if (args) try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* verbatim malformed args */ }
  return `${args !== null ? `Arguments:\n${args}\n\n` : ""}Output:\n${JSON.stringify(result, null, 2)}${details.failureReason ? `\n\nFailure:\n${details.failureReason}` : ""}`;
}

// Tokenize only text from parsed/validated JSON. Render as React text nodes,
// never HTML; gaps preserve the whitespace and section headings verbatim.
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > start) tokens.push({ text: text.slice(start, index), kind: "plain" });
    const value = match[0];
    const kind = value.startsWith('"') ? /^\s*:/.test(text.slice(index + value.length)) ? "key" : "string"
      : /^(?:true|false|null)$/.test(value) ? "literal" : "number";
    tokens.push({ text: value, kind });
    start = index + value.length;
  }
  if (start < text.length) tokens.push({ text: text.slice(start), kind: "plain" });
  return tokens;
}

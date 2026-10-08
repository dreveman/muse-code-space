// The worker has historically stored this exact explanatory suffix with a
// truncated Muse reasoning summary. Keep persisted transcripts unchanged, but
// present the note separately from the italic summary text.
const STORED_TRUNCATION_SUFFIX = "\n\n(Reasoning summary truncated by Muse.)";

export function reasoningDisplay(content: string): { summary: string; truncated: boolean } {
  if (!content.endsWith(STORED_TRUNCATION_SUFFIX)) return { summary: content, truncated: false };
  return { summary: content.slice(0, -STORED_TRUNCATION_SUFFIX.length), truncated: true };
}

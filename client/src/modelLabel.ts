// Only a recognizable hyphenated family + dotted numeric version + optional
// variant gets a display label. Never guess at opaque model identifiers: an
// unknown shape must be shown verbatim and still be sent unchanged to Muse.
export function displayModelLabel(raw: string): string {
  const parts = raw.split("-");
  const versionParts = parts.map((part, index) => /^\d+(?:\.\d+)+$/.test(part) ? index : -1).filter((index) => index >= 0);
  if (versionParts.length !== 1) return raw;
  const versionIndex = versionParts[0]!;
  const family = parts.slice(0, versionIndex);
  const variant = parts.slice(versionIndex + 1);
  const namePart = /^[a-z][a-z0-9]*$/i;
  if (family.length === 0 || ![...family, ...variant].every((part) => namePart.test(part))) return raw;
  const title = (part: string) => part[0]!.toUpperCase() + part.slice(1).toLowerCase();
  return `${family.map(title).join(" ")} ${parts[versionIndex]}${variant.length ? ` (${variant.map(title).join(" ")})` : ""}`;
}

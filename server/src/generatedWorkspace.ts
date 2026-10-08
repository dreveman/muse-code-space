// Pure-JS FNV-1a hash (no Node crypto — forbidden in artifact action handlers).
// Returns a deterministic 12-char hex token from the sessionId.
export function shortWorkspaceToken(sessionId: string): string {
  let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    const c = sessionId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + 31), 0x01000193);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return (hex1 + hex2).slice(0, 12);
}

// Only the UI's default path is reserved for an individual app session.
// User-selected workspaces may intentionally be shared by several agents.
export function isGeneratedWorkspaceRoot(sessionId: string, path: string, workspaceRoot: string): boolean {
  const token = sessionId.match(/^manual-\d+-([0-9a-f]{12})$/)?.[1];
  return !!token && path === `${workspaceRoot}/code/${token}`;
}

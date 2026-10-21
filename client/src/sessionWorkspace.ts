// crypto.randomUUID() is only exposed in secure contexts, so the preview
// iframe (blob:null origin) and other non-secure hosts would throw
// `crypto.randomUUID is not a function` on any id-generating click. This
// falls back to getRandomValues, then Math.random, always emitting a valid
// v4 UUID that newSessionIdentity accepts.
export function randomUuid(): string {
  const fallbackBytes = () => {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  };
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through to the manual v4 below
    }
  }
  const bytes = fallbackBytes();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The last 12 hex digits of a crypto.randomUUID() are 48 random bits. Keep
// this opaque workspace token in the immutable app session id, so an unsent
// draft and its first-prompt retry always use the same directory. The agent's
// mutable display name and the long app/pilot session ids never enter the path.
export function newSessionIdentity(uuid: string, now: number): { id: string; workspaceRoot: string } {
  const token = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-([0-9a-f]{12})$/i.exec(uuid)?.[1]?.toLowerCase();
  if (!token || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("A valid random UUID and timestamp are required to create a session workspace");
  }
  return { id: `manual-${now}-${token}`, workspaceRoot: `~/workspace/code/${token}` };
}

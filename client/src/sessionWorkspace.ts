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

// Pure transcript visibility rules shared by the worker and React client.
// Only visible output that the agent/pilot produced should make an agent
// unread; the user's own prompts and hidden lifecycle chatter do not.
export type TranscriptEventShape = { kind: string; content: string };

export function isLifecycleMessage(event: TranscriptEventShape): boolean {
  if (event.kind !== "system") return false;
  return /^(Wake signal sent|Picked up by supervisor|Continuation picked up|Immediate wake was unavailable|Direction received|Takeover|Continuing in the same workspace)/i.test(event.content.trim());
}

export function countsAsUnread(event: TranscriptEventShape): boolean {
  return event.kind !== "user" && event.kind !== "result" && event.kind !== "thinking" && !isLifecycleMessage(event);
}

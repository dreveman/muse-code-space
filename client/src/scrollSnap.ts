// Pure decision for the transcript bottom-snap (see App.tsx).
// No runtime imports: safe to load anywhere (client bundle, probes).

// True when opening a session whose transcript has loaded and which hasn't
// been snapped yet this visit. The caller records the snap by storing the
// session id, and clears it when leaving so revisiting snaps again.
export function shouldSnapToBottom(
  snappedSessionId: string | null,
  sessionId: string,
  eventCount: number,
): boolean {
  return eventCount > 0 && snappedSessionId !== sessionId;
}

// Follow while the reader is pinned to the bottom and there is content or a
// pending prompt. Turn status is deliberately irrelevant: the final response
// can arrive in the same update that marks the turn complete.
export function shouldFollowTranscript(
  following: boolean,
  eventCount: number,
  hasPendingEcho: boolean,
): boolean {
  if (!following) return false;
  return eventCount > 0 || hasPendingEcho;
}

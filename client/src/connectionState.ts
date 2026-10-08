// Connection handling: the UI stays up while the app can't reach its
// backend, shows "Connecting…", and holds at most one prompt to send when
// the connection is back.

export type ConnectionSignals = {
  /** navigator.onLine — the browser knows it has no network. */
  browserOnline: boolean;
  /** The polled session list's last fetch failed. */
  listFailed: boolean;
  /** When a send last failed with a network error (ms, 0 = never). */
  sendFailedAt: number;
  /** When the session list last loaded successfully (ms, 0 = never). */
  listUpdatedAt: number;
};

export function isConnectionLost(signals: ConnectionSignals): boolean {
  if (!signals.browserOnline || signals.listFailed) return true;
  // A failed send counts until the list proves the backend is reachable again.
  return signals.sendFailedAt > 0 && signals.sendFailedAt >= signals.listUpdatedAt;
}

/** fetch() rejects with a TypeError when the request never got a response. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

export type SubmitDecision = "send" | "queue" | "queue-full";

/** What a submit does: send now, hold it for later, or refuse (one max). */
export function decideSubmit(connectionLost: boolean, hasQueuedPrompt: boolean): SubmitDecision {
  if (!connectionLost) return "send";
  return hasQueuedPrompt ? "queue-full" : "queue";
}

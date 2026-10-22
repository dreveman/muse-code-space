// Polling policy for the open session's detail query.
//
// The session list and the detail query hold separate copies of a session's
// status, and the list usually learns a turn ended first. Polling must stay
// alive while EITHER copy still says the turn is live: gating only on the
// list strands the open view on its last mid-turn snapshot, because no
// further detail fetch is ever scheduled once the list flips terminal.
// Once both copies agree the session is terminal/idle, polling stops.

export type SessionStatus = "queued" | "running" | "succeeded" | "failed" | "stopped";

export function isTurnLiveStatus(status: SessionStatus | null | undefined): boolean {
  return status === "queued" || status === "running";
}

export function shouldPollSessionDetail(
  listStatus: SessionStatus | null | undefined,
  detailStatus: SessionStatus | null | undefined,
): boolean {
  return isTurnLiveStatus(listStatus) || isTurnLiveStatus(detailStatus);
}

export function isLiveToTerminalTransition(
  previous: SessionStatus | null | undefined,
  next: SessionStatus | null | undefined,
): boolean {
  return isTurnLiveStatus(previous) && next != null && !isTurnLiveStatus(next);
}


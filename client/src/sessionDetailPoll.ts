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

export type ListSessionStart = {
  pilot_session_id?: string | null;
  status: SessionStatus;
};

// The server says this session has started: it has a pilot session, or it
// has moved past the queued state a not-yet-started local draft sits in.
export function isStartedListSession(session: ListSessionStart | null | undefined): boolean {
  return session != null && (Boolean(session.pilot_session_id) || session.status !== "queued");
}

// A local draft must not gate off the detail query once the server says the
// session has started. An interrupted start handshake can leave the draft in
// place forever; a disabled query with no cached data stays pending forever
// and no getSession is ever issued for the session.
export function shouldEnableSessionDetail(args: {
  selectedId: string | null;
  draftId: string | null;
  listSession: ListSessionStart | null | undefined;
}): boolean {
  if (args.selectedId === null) return false;
  if (args.selectedId !== args.draftId) return true;
  return isStartedListSession(args.listSession);
}

// Never spin forever on a pending detail query when the list already has
// the session: render from the list copy (detailSession falls back to it)
// and let the detail fetch fill in the transcript when it lands.
export function shouldShowConversationLoading(args: {
  isPending: boolean;
  hasDetailSession: boolean;
  hasListSession: boolean;
}): boolean {
  if (!args.hasDetailSession) return true;
  return args.isPending && !args.hasListSession;
}

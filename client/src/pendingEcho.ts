// Pure helpers for the submitted-prompt echo in the transcript view.
// No runtime imports: safe to load anywhere (client bundle, probes).

export type EchoEvent = {
  kind: string;
  content: string;
};

// True once a held prompt shows up in the transcript. The legacy path wraps
// content in a model header, so match on suffix as well as exact equality.
// fromIndex anchors the match to events that arrived after the echo was set:
// without it, resending a prompt identical to an older message would clear
// the echo immediately against that stale message.
export function pendingHasArrived(events: EchoEvent[], pending: string, fromIndex = 0): boolean {
  return events.slice(fromIndex).some(
    (event) =>
      event.kind === "user" &&
      (event.content.trim() === pending || event.content.trim().endsWith(pending)),
  );
}

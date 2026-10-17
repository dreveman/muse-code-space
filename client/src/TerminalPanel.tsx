// Terminal tab content (prototype): a shell in the session's working
// directory on the machine where muse runs (the pilot's host), rendered with
// wterm. A session can have any number of these (the side panel's tabs).
//
// Transport: the browser can only reach this app through its actions, so
// output is a long-poll (terminalOutput, by byte offset) and keystrokes are
// small batched POSTs (terminalInput), sent strictly in order. The pilot
// keeps the shells: switching sessions and coming back reattaches each tab
// (replaying recent output). Closing a tab, archiving or deleting the
// session, or a pilot restart ends its shell.
import { Terminal, useTerminal, type WTerm } from "@wterm/react";
import "@wterm/react/css";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { optimizeTerminalInstance } from "./terminalOptimizations";

type Status = "starting" | "connected" | "reconnecting" | "exited" | "error";

const INPUT_FLUSH_MS = 12;
const RESIZE_DEBOUNCE_MS = 150;
const LONG_POLL_MS = 8000;

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function TerminalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
    </svg>
  );
}

/** Floating chat button: always opens a new terminal tab. */
export function NewTerminalButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="terminal-toggle"
      onClick={onOpen}
      aria-label="Open a new terminal"
      title="New terminal in the working directory"
    >
      <TerminalIcon />
    </button>
  );
}

export function TerminalView({ sessionId, terminalId, active, onOpened }: {
  sessionId: string;
  /** null: open a new shell; otherwise reattach to this one. */
  terminalId: string | null;
  /** Inactive tabs keep their connection but pause painting. */
  active: boolean;
  /** A shell was opened for this tab (new, or after Restart). */
  onOpened: (terminalId: string, number: number) => void;
}) {
  const { ref, write, focus } = useTerminal();
  const [status, setStatus] = useState<Status>("starting");
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState<WTerm | null>(null);
  const [generation, setGeneration] = useState(0); // bump to start a fresh shell
  const terminalIdRef = useRef<string | null>(terminalId);
  const reattachRef = useRef(terminalId !== null); // the first open reattaches
  const pendingInput = useRef("");
  const flushTimer = useRef<number | null>(null);
  const sendChain = useRef<Promise<void>>(Promise.resolve());
  const resizeTimer = useRef<number | null>(null);
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;

  // Open (or reattach to) the shell, then long-poll its output.
  useEffect(() => {
    if (!term) return;
    let cancelled = false;
    let since = 0;
    setStatus("starting");
    setError(null);
    const closed = (message: string) => {
      terminalIdRef.current = null;
      setStatus("exited");
      setError(null);
      write(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`);
    };
    const run = async () => {
      let failures = 0;
      let opened = false;
      while (!cancelled) {
        if (!opened) {
          const reattachId = reattachRef.current ? terminalIdRef.current : null;
          const result = await api
            .openTerminal({ session_id: sessionId, cols: term.cols, rows: term.rows, ...(reattachId ? { terminal_id: reattachId } : {}) })
            .catch(() => null);
          if (cancelled) {
            // The tab went away while its new shell was starting: end it.
            if (result?.ok && result.terminal_id && !result.reattached) void api.closeTerminal({ terminal_id: result.terminal_id }).catch(() => undefined);
            return;
          }
          if (result?.gone) return closed("terminal closed");
          if (!result?.ok || !result.terminal_id) {
            setStatus("error");
            setError(result?.error ?? "Couldn't reach the pilot to start a terminal.");
            await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * 2 ** failures++)));
            continue;
          }
          opened = true;
          reattachRef.current = true;
          terminalIdRef.current = result.terminal_id;
          if (!result.reattached && result.number !== null) onOpenedRef.current(result.terminal_id, result.number);
          since = 0; // fresh view: replay what the shell has buffered
          // Match this view's size (a reattached shell may be sized differently).
          void api.terminalResize({ terminal_id: result.terminal_id, cols: term.cols, rows: term.rows }).catch(() => undefined);
        }
        const id = terminalIdRef.current;
        if (!id) return;
        const out = await api.terminalOutput({ terminal_id: id, since, wait_ms: LONG_POLL_MS }).catch(() => null);
        if (cancelled) return;
        if (!out) {
          setStatus("reconnecting");
          await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** failures++)));
          continue;
        }
        if (!out.ok) {
          // Gone: closed elsewhere (session archived, pilot restarted). Don't
          // silently start a new shell; offer Restart.
          if (out.gone) return closed("terminal closed");
          setStatus("reconnecting");
          setError(out.error);
          await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** failures++)));
          continue;
        }
        failures = 0;
        setStatus("connected");
        setError(null);
        if (out.truncated) write("\r\n\x1b[2m[earlier output trimmed]\x1b[0m\r\n");
        if (out.data) write(decodeBase64(out.data));
        since = out.next;
        if (out.exited) {
          setStatus("exited");
          write(`\r\n\x1b[2m[process exited${out.exit_code !== null ? ` with code ${out.exit_code}` : ""}]\x1b[0m\r\n`);
          return;
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [term, sessionId, generation, write]);

  const flushInput = useCallback(() => {
    flushTimer.current = null;
    const data = pendingInput.current;
    const id = terminalIdRef.current;
    if (!data || !id) return;
    pendingInput.current = "";
    // Strictly ordered: each batch waits for the previous POST.
    sendChain.current = sendChain.current.then(async () => {
      const result = await api.terminalInput({ terminal_id: id, data }).catch(() => null);
      if (!result?.ok) setError(result?.error ?? "Keystrokes couldn't be sent.");
    });
  }, []);

  const onData = useCallback((data: string) => {
    pendingInput.current += data;
    if (flushTimer.current === null) flushTimer.current = window.setTimeout(flushInput, INPUT_FLUSH_MS);
  }, [flushInput]);

  const onResize = useCallback((cols: number, rows: number) => {
    if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      const id = terminalIdRef.current;
      if (id) void api.terminalResize({ terminal_id: id, cols, rows }).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => {
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
  }, []);

  useEffect(() => {
    if (active) focus();
  }, [active, focus]);

  // A fresh shell in the same tab.
  const restart = () => {
    const id = terminalIdRef.current;
    terminalIdRef.current = null;
    reattachRef.current = false;
    if (id) void api.closeTerminal({ terminal_id: id }).catch(() => undefined);
    ref.current?.instance?.write("\x1bc"); // reset the screen
    setGeneration((value) => value + 1);
    focus();
  };

  // Status only in words, and only when it matters.
  const showError = error !== null && status !== "connected";
  const barText = showError
    ? error
    : status === "starting" ? "starting…"
    : status === "reconnecting" ? "reconnecting…"
    : status === "exited" ? "The shell has ended."
    : null;

  return (
    <div className="terminal-view">
      {barText && (
        <div className="terminal-view-bar" role={showError ? "alert" : "status"}>
          <span className={showError ? "terminal-view-error" : undefined}>{barText}</span>
          {status === "exited" && <button type="button" className="terminal-panel-button" onClick={restart}>Restart</button>}
        </div>
      )}
      <Terminal
        ref={ref}
        className="terminal-panel-term"
        autoResize
        cursorBlink
        renderingPaused={!active}
        aria-label="Terminal in the companion's working directory"
        onData={onData}
        onResize={onResize}
        onReady={(wt) => {
          optimizeTerminalInstance(wt);
          setTerm(wt);
        }}
        onError={(e) => {
          setStatus("error");
          setError(`Terminal failed to load: ${String(e)}`);
        }}
      />
    </div>
  );
}

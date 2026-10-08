#!/usr/bin/env python3
"""PTY bridge for the Code Sessions terminal (pilot/terminals.mjs).

Runs a login shell on a pseudo-terminal in a working directory and relays raw
bytes: stdin -> terminal, terminal -> stdout. Resize requests arrive on fd 3 as
JSON lines {"cols": N, "rows": N}. Exits with the shell's exit status.

Standard library only (no node-pty / native modules), so it installs anywhere
python3 runs: the Muse VM and a Mac.

usage: pty_bridge.py <cwd> <cols> <rows>
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd: int, cols: int, rows: int) -> None:
    cols = max(1, min(int(cols), 1000))
    rows = max(1, min(int(rows), 500))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    cwd, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    shell = os.environ.get("SHELL") or "/bin/bash"
    pid, master = pty.fork()
    if pid == 0:  # child: the shell
        try:
            os.chdir(cwd)
        except OSError:
            pass
        # The environment is exactly what terminals.mjs passed (an allowlist).
        os.execvpe(shell, [shell, "-l"], os.environ)

    set_size(master, cols, rows)
    try:
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass

    stdin, stdout, control = 0, 1, 3
    try:
        os.fstat(control)
    except OSError:
        control = -1
    control_buf = b""
    watched = [master, stdin] + ([control] if control >= 0 else [])

    while True:
        try:
            ready, _, _ = select.select(watched, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:  # EIO: the shell (and its terminal) went away
                data = b""
            if not data:
                break
            os.write(stdout, data)
        if stdin in ready:
            data = os.read(stdin, 65536)
            if not data:  # the pilot closed our stdin: hang up the shell
                os.kill(pid, signal.SIGHUP)
                watched.remove(stdin)
            else:
                os.write(master, data)
        if control >= 0 and control in ready:
            chunk = os.read(control, 4096)
            if not chunk:
                watched.remove(control)
                control = -1
                continue
            control_buf += chunk
            while b"\n" in control_buf:
                line, control_buf = control_buf.split(b"\n", 1)
                try:
                    msg = json.loads(line)
                    set_size(master, msg["cols"], msg["rows"])
                    os.kill(pid, signal.SIGWINCH)
                except (ValueError, KeyError, OSError):
                    pass

    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)


if __name__ == "__main__":
    sys.exit(main())

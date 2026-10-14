#!/usr/bin/env python3
"""Interactive GitHub App provisioning for the Code Space GitHub broker.

Run in a Code Space terminal (installed to the pilot runtime as
setup_github_broker.py):

    python3 ~/workspace/muse-code-space-pilot/setup_github_broker.py

It prompts for the GitHub App ID and installation ID, reads the App
private key with terminal echo disabled (paste ends automatically at
the END PRIVATE KEY line), validates the trio against GitHub BEFORE
writing anything (mints an App JWT and exchanges it for an installation
token), then writes the host-local broker config + key (both chmod
600), restarts the broker service, and verifies it. The key never
appears on screen or in any transcript this tool controls; nothing is
written anywhere except the two 600-mode files under
~/.config/muse-code-space-pilot/.

Stdlib only, mirroring pilot/github_broker.py's discipline.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import termios
import time
import tty

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from github_broker import GitHubAppTokenProvider  # noqa: E402

CONFIG_DIR = pathlib.Path.home() / ".config" / "muse-code-space-pilot"
KEY_PATH = CONFIG_DIR / "github-app-key.pem"
CONFIG_PATH = CONFIG_DIR / "github-broker.json"


def read_pem_hidden(prompt: str = "Paste the App private key (.pem), then wait — input is hidden: ") -> str:
    """Read a PEM with echo off, stopping at the END line or EOF."""
    sys.stderr.write(prompt)
    sys.stderr.flush()
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    lines: list[str] = []
    try:
        tty.setraw(fd)
        buf = ""
        while True:
            ch = sys.stdin.read(1)
            if ch == "":
                break  # EOF (Ctrl-D)
            if ch == "\x03":  # Ctrl-C
                raise KeyboardInterrupt
            buf += ch
            if ch == "\n":
                lines.append(buf)
                if "-----END" in buf and "PRIVATE KEY-----" in buf:
                    break
                buf = ""
        if buf:
            lines.append(buf)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stderr.write("\n")
    pem = "".join(lines).replace("\r\n", "\n").strip() + "\n"
    if "-----BEGIN" not in pem or "PRIVATE KEY-----" not in pem or "-----END" not in pem:
        raise ValueError("that did not look like a PEM private key (missing BEGIN/END PRIVATE KEY lines)")
    return pem


def prompt_numeric(label: str, input_fn=input) -> str:
    while True:
        value = input_fn(f"{label}: ").strip()
        if value.isdigit():
            return value
        print(f"{label} should be numeric — try again (Ctrl-C to quit).")


def build_config(app_id: str, installation_id: str, key_path: pathlib.Path = KEY_PATH) -> dict:
    return {
        "mode": "app",
        "app_id": str(app_id),
        "installation_id": str(installation_id),
        "private_key_path": str(key_path),
    }


def write_config(config: dict, pem: str,
                 config_path: pathlib.Path = CONFIG_PATH,
                 key_path: pathlib.Path = KEY_PATH) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    old_umask = os.umask(0o077)
    try:
        key_path.write_text(pem)
        key_path.chmod(0o600)
        config_path.write_text(json.dumps(config, indent=2) + "\n")
        config_path.chmod(0o600)
    finally:
        os.umask(old_umask)


def validate(app_id: str, installation_id: str, pem: str, provider_factory=GitHubAppTokenProvider) -> str:
    """Exchange the App JWT for an installation token; returns its prefix-free length proof."""
    provider = provider_factory(app_id, installation_id, pem)
    token = provider()
    if not token:
        raise RuntimeError("GitHub returned an empty installation token")
    return token


def restart_broker(run=subprocess.run) -> bool:
    for cmd in (["systemctl", "restart", "muse-code-space-github-broker.service"],
                ["sudo", "systemctl", "restart", "muse-code-space-github-broker.service"]):
        try:
            result = run(cmd, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            return True
    return False


def broker_health(port: int = 18792, attempts: int = 15) -> bool:
    import ssl
    import urllib.request
    runtime = pathlib.Path.home() / "workspace" / "muse-code-space-pilot"
    cert = runtime / "github-broker-cert.pem"
    ctx = ssl.create_default_context(cafile=str(cert)) if cert.exists() else ssl._create_unverified_context()
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(f"https://127.0.0.1:{port}/__code_space/health", context=ctx, timeout=3) as res:
                if json.loads(res.read()).get("ok") is True:
                    return True
        except Exception:
            time.sleep(1)
    return False


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    no_restart = "--no-restart" in argv
    print("GitHub App setup for the Code Space broker.")
    print("Create the App first if you haven't: https://github.com/settings/apps/new")
    print("  Repository permissions: Contents Read/Write, Pull requests Read/Write;")
    print("  generate a private key, then Install App on selected repositories only.")
    print("  App ID is on the App page; installation ID ends the install URL (.../installations/<id>).\n")
    try:
        app_id = prompt_numeric("App ID")
        installation_id = prompt_numeric("Installation ID")
        pem = read_pem_hidden()
    except (KeyboardInterrupt, EOFError):
        print("\nAborted — nothing written.")
        return 130
    except ValueError as exc:
        print(f"\n{exc} — nothing written.")
        return 2
    print("Validating against GitHub (minting an installation token)…")
    try:
        validate(app_id, installation_id, pem)
    except Exception as exc:  # noqa: BLE001 - surface a clean failure, never the key
        print(f"Validation failed ({type(exc).__name__}: {exc}) — nothing written. "
              "Check the App ID, installation ID, key, and that the App is installed on the account.")
        return 1
    write_config(build_config(app_id, installation_id), pem)
    print(f"Wrote {KEY_PATH} and {CONFIG_PATH} (both mode 600).")
    if no_restart:
        print("Skipping broker restart (--no-restart). Restart it with:")
        print("  systemctl restart muse-code-space-github-broker.service")
        return 0
    print("Restarting the broker service…")
    if not restart_broker():
        print("Could not restart the broker automatically. Run:")
        print("  systemctl restart muse-code-space-github-broker.service   (sudo if needed)")
        return 1
    port = int(os.environ.get("MUSE_CODE_SPACE_GITHUB_BROKER_PORT", "18792") or 18792)
    if broker_health(port):
        print(f"Broker is healthy on 127.0.0.1:{port}. Sessions now have full git + gh access")
        print("for the repositories this App is installed on. Try: git ls-remote https://github.com/<owner>/<repo>.git")
        return 0
    print("Broker restarted but health check did not pass — see ~/workspace/muse-code-space-pilot/github-broker.log")
    return 1


if __name__ == "__main__":
    sys.exit(main())

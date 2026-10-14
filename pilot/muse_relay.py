#!/usr/bin/env python3
"""Local relay letting the Muse Code CLI reach api.meta.ai.

The `muse` native binary ignores this VM's egress proxy env vars, so its
direct HTTPS connections to api.meta.ai fail at the transport layer. This
relay listens on 127.0.0.1 and forwards every request to https://api.meta.ai,
injecting a fresh authd credential surrogate per request. Python's urllib
honors the egress proxy, so the forwarded leg works and Sentinel swaps the
surrogate for the real key.

Point the CLI at it with: muse exec --base-url http://127.0.0.1:<port> ...

Only ever sends `hsurr:*` surrogate values, and only to api.meta.ai.
Never prints, logs, or persists credential material.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import json
import time
from collections import deque
from datetime import datetime, timezone
from itertools import count
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The platform moved the credential helper (skill-creator -> custom-
# connector-setup, under two roots on different hosts). Resolve the first
# candidate that actually contains the module; the legacy path is kept last.
_CREDENTIAL_HELPER_DIRS = (
    "/opt/muse/skills/custom-connector-setup/bin",
    "/opt/hatch/workflow-skills/custom-connector-setup/bin",
    "/opt/hatch/skills/skill-creator/bin",
)
for _helper_dir in _CREDENTIAL_HELPER_DIRS:
    if os.path.exists(os.path.join(_helper_dir, "dynamic_credentials.py")):
        sys.path.insert(0, _helper_dir)
        break
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

TARGET_BASE = "https://api.meta.ai"
CREDENTIAL_NAME = "custom.meta-model-api"
ALLOWED_HOSTS = ("api.meta.ai",)

# The CLI speaks the Responses API at `<base>/responses`, but Meta serves it
# at `/v1/responses`. Remap the path prefix before forwarding.
PATH_REMAP = (("/responses", "/v1/responses"),)

# In-memory, bounded and deliberately NOT a wire dump: no bodies, credentials,
# raw headers, query strings or arbitrary exception messages reach the UI.
DIAGNOSTICS = deque(maxlen=100)
DIAGNOSTICS_LOCK = threading.Lock()
REQUEST_IDS = count(1)
STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
LAST_SUCCESS = None
LAST_FAILURE = None


def diagnostics_snapshot() -> dict:
    with DIAGNOSTICS_LOCK:
        return {"ok": True, "entries": list(DIAGNOSTICS), "startedAt": STARTED_AT,
                "lastSuccessAt": LAST_SUCCESS, "lastFailureAt": LAST_FAILURE}


def safe_path(value: str) -> str:
    path = urllib.parse.urlparse(value).path
    if path == "/v1/responses" or path.startswith("/v1/responses/"):
        return "/v1/responses"
    if path in ("/models", "/v1/models"):
        return "/models"
    return "/other"


def record_diagnostic(method: str, status: int, stage: str, started: float,
                      request_bytes: int = 0, response_bytes: int = 0,
                      error_type: str | None = None, path: str = "/other") -> None:
    global LAST_SUCCESS, LAST_FAILURE
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    entry = {"id": next(REQUEST_IDS), "at": at, "method": method,
             "path": path,
             "status": status, "durationMs": round((time.monotonic() - started) * 1000),
             "requestBytes": request_bytes, "responseBytes": response_bytes,
             "stage": stage, "errorType": error_type}
    with DIAGNOSTICS_LOCK:
        DIAGNOSTICS.append(entry)
        if stage == "complete" and status < 400:
            LAST_SUCCESS = at
        else:
            LAST_FAILURE = at

# Headers that must not be forwarded hop-to-hop.
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
}


def fresh_surrogate() -> str:
    entry = dynamic_credential_entry(CREDENTIAL_NAME)
    surrogate = str(entry["surrogate"]).strip()
    if not surrogate.startswith("hsurr:"):
        raise RuntimeError("authd returned a non-surrogate credential value")
    return surrogate


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MuseRelay/1.0"

    def _local_json(self, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _forward(self) -> None:
        if self.command == "GET" and self.path == "/__code_space/health":
            self._local_json({"ok": True})
            return
        if self.command == "GET" and self.path == "/__code_space/diagnostics":
            self._local_json(diagnostics_snapshot())
            return
        started = time.monotonic()
        length = 0
        stage = "request"
        endpoint = "/other"
        streaming = False
        try:
            try:
                length = max(0, int(self.headers.get("Content-Length", 0) or 0))
            except ValueError:
                length = 0
            body = self.rfile.read(length) if length > 0 else None
            path = self.path
            for old, new in PATH_REMAP:
                if path == old or path.startswith(old + "/") or path.startswith(old + "?"):
                    path = new + path[len(old):]
                    break
            endpoint = safe_path(path)
            url = TARGET_BASE + path
            if (urllib.parse.urlparse(url).hostname or "").lower() not in ALLOWED_HOSTS:
                self.send_error(403, "relay only forwards to api.meta.ai")
                record_diagnostic(self.command, 403, "blocked", started, length, path=endpoint)
                return
            stage = "credential"
            surrogate = fresh_surrogate()
            req = urllib.request.Request(url, data=body, method=self.command)
            for key, value in self.headers.items():
                if key.lower() not in HOP_BY_HOP and key.lower() != "authorization":
                    req.add_header(key, value)
            req.add_header("Authorization", f"Bearer {surrogate}")
            stage = "upstream_connect"
            try:
                response = urllib.request.urlopen(req, timeout=300)
            except urllib.error.HTTPError as exc:
                response = exc
            try:
                status = response.status if hasattr(response, "status") else response.code
                stage = "upstream_http" if status >= 400 else "complete"
                streaming = True
                transferred, disconnected = self._relay_response(status, response.headers, response)
                if disconnected:
                    stage = "client_disconnect"
                record_diagnostic(self.command, status, stage, started, length, transferred, path=endpoint)
            finally:
                response.close()
        except Exception as exc:  # noqa: BLE001 - never store exception values
            if streaming:
                # Headers may already have been sent. A second HTTP error
                # response would corrupt the stream; close this connection.
                record_diagnostic(self.command, 502, "response_stream", started,
                                  length, error_type=type(exc).__name__, path=endpoint)
                self.close_connection = True
                return
            if isinstance(exc, urllib.error.URLError):
                reason = str(exc.reason).lower()
                stage = "proxy" if any(text in reason for text in ("proxy", "tunnel", "407")) else "upstream_connect"
            if isinstance(exc, TimeoutError):
                stage = "timeout"
            record_diagnostic(self.command, 502, stage, started, length,
                              error_type=type(exc).__name__, path=endpoint)
            try:
                self.send_error(502, f"relay {stage} error")
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _relay_response(self, status: int, headers, body_fp) -> tuple[int, bool]:
        self.send_response(status)
        for key, value in headers.items():
            if key.lower() not in HOP_BY_HOP:
                self.send_header(key, value)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        transferred = 0
        try:
            while True:
                chunk = body_fp.read(65536)
                if not chunk:
                    break
                self.wfile.write(b"%X\r\n" % len(chunk))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
                transferred += len(chunk)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return transferred, False
        except (BrokenPipeError, ConnectionResetError):
            return transferred, True

    do_GET = _forward
    do_POST = _forward
    do_PUT = _forward
    do_PATCH = _forward
    do_DELETE = _forward
    do_HEAD = _forward

    def log_message(self, *args):  # keep quiet; never log request details
        pass


def start_relay(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), RelayHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main() -> int:
    """Run the relay standalone (blocking).

    Port comes from MUSE_CODE_SPACE_RELAY_PORT (the project unit sets 18790);
    0 (ephemeral, for manual testing) remains the default.
    """
    port = int(os.environ.get("MUSE_CODE_SPACE_RELAY_PORT", "0") or 0)
    server = ThreadingHTTPServer(("127.0.0.1", port), RelayHandler)
    port = server.server_address[1]
    print(f"muse relay listening on 127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

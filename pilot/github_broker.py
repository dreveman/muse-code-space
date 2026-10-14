#!/usr/bin/env python3
"""Loopback GitHub credential broker for Muse Code Space sessions.

Modeled on pilot/muse_relay.py: stdlib-only, bound to 127.0.0.1, forwarding
through the egress proxy (urllib honors the proxy env the unit loads from
proxy.env). Sessions talk only to this broker:

- git smart-HTTP arrives via the generated gitconfig's insteadOf rewrite,
- `gh` REST calls arrive via its per-host `api_host` override (gh forces
  https for api_host, so the broker serves TLS with the install-generated
  loopback certificate; sessions trust it via SSL_CERT_FILE).

The broker strips any incoming Authorization, then attaches its own
credential per request — HTTP Basic `x-access-token:<token>` for git paths,
`Bearer <token>` for API paths. The only upstreams are github.com and
api.github.com. It never prints, logs, or persists credential material;
diagnostics keep bounded metadata only, exactly like the relay.
"""

from __future__ import annotations

import base64
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import count

GIT_BASE = "https://github.com"
API_BASE = "https://api.github.com"
ALLOWED_HOSTS = ("github.com", "api.github.com")
CHUNK = 65536

# Git smart-HTTP: /<owner>/<repo>[.git]/<endpoint>. Everything else that is a
# well-formed absolute path is a REST API path (gh sends /repos/..., /user).
GIT_PATH = re.compile(r"^/[^/]+/[^/]+/(info/refs|git-upload-pack|git-receive-pack)$")

DIAGNOSTICS = deque(maxlen=100)
DIAGNOSTICS_LOCK = threading.Lock()
REQUEST_IDS = count(1)
STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length", "host",
}

# ---- token provider (commit-step interface; providers live below main) ----
# A provider is a zero-arg callable returning the credential to attach.
# It is called per forwarded request so short-lived tokens stay fresh.
_token_provider = None
_provider_lock = threading.Lock()


def set_token_provider(provider) -> None:
    global _token_provider
    with _provider_lock:
        _token_provider = provider


def current_token() -> str:
    with _provider_lock:
        provider = _token_provider
    if provider is None:
        raise RuntimeError("no GitHub credential configured")
    token = str(provider()).strip()
    if not token:
        raise RuntimeError("GitHub credential provider returned an empty token")
    return token


def record_diagnostic(method: str, status: int, stage: str, started: float,
                      request_bytes: int = 0, response_bytes: int = 0,
                      error_type: str | None = None, path: str = "/other") -> None:
    entry = {"id": next(REQUEST_IDS),
             "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
             "method": method, "path": path, "status": status,
             "durationMs": round((time.monotonic() - started) * 1000),
             "requestBytes": request_bytes, "responseBytes": response_bytes,
             "stage": stage, "errorType": error_type}
    with DIAGNOSTICS_LOCK:
        DIAGNOSTICS.append(entry)


def diagnostics_snapshot() -> dict:
    with DIAGNOSTICS_LOCK:
        return {"ok": True, "entries": list(DIAGNOSTICS), "startedAt": STARTED_AT}


def classify(path: str) -> tuple[str, str] | None:
    """Map an incoming path to (surface, upstream URL); None rejects it."""
    split = urllib.parse.urlsplit(path)
    if split.netloc:  # //host/... smuggles an authority component; reject it
        return None
    raw = split.path
    if not raw.startswith("/") or "//" in raw or ".." in raw.split("/") or "\\" in raw:
        return None
    if any(ord(c) < 32 for c in raw):
        return None
    query = f"?{split.query}" if split.query else ""
    if GIT_PATH.match(raw):
        return "git", GIT_BASE + raw + query
    if raw in ("/", ""):
        return None
    return "api", API_BASE + raw + query


def upstream_context(candidates: tuple[str, ...] | None = None) -> ssl.SSLContext:
    """TLS context for upstream calls: system roots plus the egress CA
    bundle when present. The authenticated egress proxy MITMs TLS (that
    is how surrogate exchange works), and its CA is not in the system
    store — without it, proxied connects fail verification (observed as
    intermittent upstream_connect 502s in the broker service, whose unit
    env carries proxy vars but no SSL_CERT_FILE)."""
    ctx = ssl.create_default_context()
    paths = candidates if candidates is not None else (
        os.environ.get("SSL_CERT_FILE", ""),
        "/run/hatch/egress-tls/ca-bundle.pem",
    )
    for path in paths:
        if path and os.path.exists(path):
            try:
                ctx.load_verify_locations(cafile=path)
            except (ssl.SSLError, OSError):
                continue
            break
    return ctx


_UPSTREAM_CONTEXT = None


def _upstream_context() -> ssl.SSLContext:
    global _UPSTREAM_CONTEXT
    if _UPSTREAM_CONTEXT is None:
        _UPSTREAM_CONTEXT = upstream_context()
    return _UPSTREAM_CONTEXT


def _urlopen_with_retry(req, has_body: bool):
    """One retry on connection failure for bodiless requests only: roughly
    a third of proxied connects were observed failing transiently, and a
    GET with no body can be replayed verbatim. Streamed bodies cannot —
    the generator is consumed by the first attempt — so they fail fast."""
    attempts = 1 if has_body else 2
    for attempt in range(attempts):
        try:
            return urllib.request.urlopen(req, timeout=300, context=_upstream_context())
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(0.3)


def _stream_body(fp, length: int):
    remaining = length
    while remaining > 0:
        chunk = fp.read(min(CHUNK, remaining))
        if not chunk:
            break
        remaining -= len(chunk)
        yield chunk


class BrokerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MuseGitHubBroker/1.0"

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
        surface = "/other"
        streaming = False
        try:
            try:
                length = max(0, int(self.headers.get("Content-Length", 0) or 0))
            except ValueError:
                length = 0
            target = classify(self.path)
            if target is None:
                self.send_error(403, "broker only forwards GitHub git/API paths")
                record_diagnostic(self.command, 403, "blocked", started, length)
                return
            surface, url = target
            if (urllib.parse.urlparse(url).hostname or "").lower() not in ALLOWED_HOSTS:
                self.send_error(403, "broker only forwards to GitHub")
                record_diagnostic(self.command, 403, "blocked", started, length, path=f"/{surface}")
                return
            stage = "credential"
            token = current_token()
            if surface == "git" and token.startswith("hsurr:"):
                # GitHub requires Basic-with-token-password for git transport
                # and rejects Bearer there (verified live), while surrogates
                # can only ever travel as Bearer (the egress exchange rewrites
                # nothing else) — so surrogate mode can never do git. Fail
                # here with the actual reason instead of a GitHub auth error.
                self.send_error(502, "github broker: surrogate credentials support gh/API only; "
                                     "git transport needs app or pat mode (the broker must hold a real token)")
                record_diagnostic(self.command, 502, "credential", started, length, path=f"/{surface}")
                return
            data = _stream_body(self.rfile, length) if length > 0 else None
            req = urllib.request.Request(url, data=data, method=self.command)
            for key, value in self.headers.items():
                if key.lower() not in HOP_BY_HOP and key.lower() != "authorization":
                    req.add_header(key, value)
            if length > 0:
                req.add_header("Content-Length", str(length))
            if surface == "git":
                # Only real tokens reach this branch (surrogates were refused
                # above): git transport requires Basic with the token as password.
                basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
                req.add_header("Authorization", f"Basic {basic}")
            else:
                # Surrogates travel as Bearer: that is their registered
                # placement, the only one the egress exchange rewrites.
                req.add_header("Authorization", f"Bearer {token}")
            stage = "upstream_connect"
            try:
                response = _urlopen_with_retry(req, has_body=data is not None)
            except urllib.error.HTTPError as exc:
                response = exc
            try:
                status = response.status if hasattr(response, "status") else response.code
                stage = "upstream_http" if status >= 400 else "complete"
                streaming = True
                transferred, disconnected = self._relay_response(status, response.headers, response)
                if disconnected:
                    stage = "client_disconnect"
                record_diagnostic(self.command, status, stage, started, length, transferred, path=f"/{surface}")
            finally:
                response.close()
        except Exception as exc:  # noqa: BLE001 - never store exception values
            if streaming:
                record_diagnostic(self.command, 502, "response_stream", started,
                                  length, error_type=type(exc).__name__, path=f"/{surface}")
                self.close_connection = True
                return
            if isinstance(exc, urllib.error.URLError):
                reason = str(exc.reason).lower()
                stage = "proxy" if any(t in reason for t in ("proxy", "tunnel", "407")) else "upstream_connect"
            if isinstance(exc, TimeoutError):
                stage = "timeout"
            record_diagnostic(self.command, 502, stage, started, length,
                              error_type=type(exc).__name__, path=f"/{surface}")
            try:
                self.send_error(502, f"github broker {stage} error")
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
                chunk = body_fp.read(CHUNK)
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


def start_broker(host: str = "127.0.0.1", port: int = 0,
                 certfile: str | None = None, keyfile: str | None = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), BrokerHandler)
    if certfile:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile, keyfile)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main() -> int:
    port = int(os.environ.get("MUSE_CODE_SPACE_GITHUB_BROKER_PORT", "18792") or 18792)
    runtime = os.environ.get("MUSE_CODE_SPACE_GITHUB_BROKER_RUNTIME", "")
    certfile = os.path.join(runtime, "github-broker-cert.pem") if runtime else None
    keyfile = os.path.join(runtime, "github-broker-key.pem") if runtime else None
    use_tls = bool(certfile and os.path.exists(certfile))
    server = start_broker(port=port,
                          certfile=certfile if use_tls else None,
                          keyfile=keyfile if use_tls else None)
    # Token providers are wired in load_config_provider() (App/PAT/surrogate).
    load_config_provider()
    print(f"github broker listening on 127.0.0.1:{port} ({'tls' if use_tls else 'http'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def load_config_provider() -> None:
    """Wire the file/env-backed token provider (see providers below)."""
    set_token_provider(config_token_provider())


# ---- token providers (App JWT / PAT / surrogate) ----
# One interface: a zero-arg callable returning the token to attach.
# The App installation token is cached in memory only; nothing credential-
# bearing is ever written to disk, logged, or included in diagnostics.

def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def base64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _jwt_part(jwt_token: str, index: int) -> dict:
    return json.loads(base64url_decode(jwt_token.split(".")[index]))


def decode_jwt_header(jwt_token: str) -> dict:
    return _jwt_part(jwt_token, 0)


def decode_jwt_claims(jwt_token: str) -> dict:
    return _jwt_part(jwt_token, 1)


def _parse_expiry(value: str) -> float:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


class GitHubAppTokenProvider:
    """Mints RS256 App JWTs with the openssl CLI and exchanges them for
    installation tokens (1-hour life, cached in memory, refreshed when
    under 5 minutes remain). Stdlib + openssl only — no pip deps."""

    def __init__(self, app_id, installation_id, private_key_pem, exchange=None):
        self._app_id = str(app_id)
        self._installation_id = str(installation_id)
        self._key_pem = private_key_pem
        self._exchange = exchange or self._default_exchange
        self._token = None
        self._expires_at = 0.0
        self._lock = threading.Lock()

    def make_jwt(self, now: float | None = None) -> str:
        import subprocess
        import tempfile
        now = int(time.time() if now is None else now)
        header = base64url_encode(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        claims = base64url_encode(json.dumps(
            {"iss": self._app_id, "iat": now - 60, "exp": now + 540},
            separators=(",", ":")).encode())
        signing_input = f"{header}.{claims}"
        fd, key_path = tempfile.mkstemp(prefix="broker-app-key-")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(self._key_pem)
            result = subprocess.run(
                ["openssl", "dgst", "-sha256", "-sign", key_path],
                input=signing_input.encode(), capture_output=True, timeout=15)
            if result.returncode != 0:
                raise RuntimeError("openssl failed to sign the GitHub App JWT")
            return f"{signing_input}.{base64url_encode(result.stdout)}"
        finally:
            try:
                os.unlink(key_path)
            except OSError:
                pass

    def _default_exchange(self, jwt_token: str) -> dict:
        req = urllib.request.Request(
            f"{API_BASE}/app/installations/{self._installation_id}/access_tokens",
            data=b"", method="POST")
        req.add_header("Authorization", f"Bearer {jwt_token}")
        req.add_header("Accept", "application/vnd.github+json")
        with urllib.request.urlopen(req, timeout=30, context=_upstream_context()) as response:
            return json.loads(response.read().decode("utf-8"))

    def __call__(self) -> str:
        with self._lock:
            if self._token and self._expires_at - time.time() > 300:
                return self._token
            payload = self._exchange(self.make_jwt())
            token = str(payload.get("token", "")).strip()
            if not token:
                raise RuntimeError("GitHub returned no installation token")
            self._token = token
            expires = payload.get("expires_at")
            self._expires_at = _parse_expiry(expires) if expires else time.time() + 3600
            return token


# The platform moved the credential helper; resolve the first known
# location that contains it (mirrors muse_relay.py).
CREDENTIAL_HELPER_DIRS = (
    "/opt/muse/skills/custom-connector-setup/bin",
    "/opt/hatch/workflow-skills/custom-connector-setup/bin",
    "/opt/hatch/skills/skill-creator/bin",
)


def _dynamic_credential_entry():
    try:
        from dynamic_credentials import dynamic_credential_entry
        return dynamic_credential_entry
    except ImportError:
        for helper_dir in CREDENTIAL_HELPER_DIRS:
            if os.path.exists(os.path.join(helper_dir, "dynamic_credentials.py")):
                if helper_dir not in sys.path:
                    sys.path.insert(0, helper_dir)
                from dynamic_credentials import dynamic_credential_entry
                return dynamic_credential_entry
        raise


def surrogate_token_provider(credential_name: str):
    """Fresh hsurr:* surrogate per request, exactly like the muse relay.
    The platform module is imported lazily so this file stays importable
    (and unit-testable) where authd is absent."""
    def _provide() -> str:
        dynamic_credential_entry = _dynamic_credential_entry()
        entry = dynamic_credential_entry(credential_name)
        surrogate = str(entry["surrogate"]).strip()
        if not surrogate.startswith("hsurr:"):
            raise RuntimeError("authd returned a non-surrogate credential value")
        return surrogate
    return _provide


def default_config_path() -> str:
    configured = os.environ.get("MUSE_CODE_SPACE_GITHUB_BROKER_CONFIG", "").strip()
    if configured:
        return configured
    return os.path.join(os.path.expanduser("~"), ".config", "muse-code-space-pilot", "github-broker.json")


def config_token_provider(config_path: str | None = None):
    """Build the provider selected by the host-local credential file
    (chmod 600, never in the repo; in surrogate mode it holds only the
    Secure Vault entry name — the vault has no read-back), or by
    MUSE_CODE_SPACE_GITHUB_CREDENTIAL_NAME for surrogate mode. With neither,
    returns a provider that fails clearly at request time while the broker
    itself (and its /health) stays up."""
    path = config_path or default_config_path()
    env_name = os.environ.get("MUSE_CODE_SPACE_GITHUB_CREDENTIAL_NAME", "").strip()
    config = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            config = json.load(fh)
    if config is None:
        if env_name:
            return surrogate_token_provider(env_name)
        def _unconfigured():
            raise RuntimeError("GitHub credential not configured: see docs/PILOT.md (GitHub broker)")
        return _unconfigured
    mode = str(config.get("mode", "")).strip().lower()
    if mode == "pat":
        token = str(config.get("token", "")).strip()
        if not token:
            raise RuntimeError("github-broker.json: pat mode needs a token")
        return lambda: token
    if mode == "surrogate":
        name = str(config.get("credential_name", "")).strip() or env_name
        if not name:
            raise RuntimeError("github-broker.json: surrogate mode needs credential_name")
        return surrogate_token_provider(name)
    if mode == "app":
        key = str(config.get("private_key", ""))
        key_path = str(config.get("private_key_path", "")).strip()
        if not key and key_path:
            with open(key_path, encoding="utf-8") as fh:
                key = fh.read()
        app_id, inst = config.get("app_id"), config.get("installation_id")
        if not app_id or not inst or not key.strip():
            raise RuntimeError("github-broker.json: app mode needs app_id, installation_id, and the App private key")
        return GitHubAppTokenProvider(app_id, inst, key)
    raise RuntimeError(f"github-broker.json: unknown mode {mode!r} (expected app, pat, or surrogate)")


if __name__ == "__main__":
    sys.exit(main())

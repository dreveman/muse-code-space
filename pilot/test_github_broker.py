"""Isolated GitHub broker tests; no GitHub, proxy, or credential needed.

Style follows pilot/test_muse_relay.py: the upstream is stubbed at
urllib.request.urlopen and the token provider is a fixture, so no real
credential material exists in this file beyond obvious test strings.
"""
import base64
import http.client
import importlib.util
import io
import json
import pathlib
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "github_broker_under_test", pathlib.Path(__file__).with_name("github_broker.py")
)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

FIXTURE_TOKEN = "fixture-broker-token"
SENTINEL = "broker-provided-sentinel"


class FakeResponse(io.BytesIO):
    status = 200
    headers = {"Content-Type": "application/json", "X-RateLimit-Remaining": "59"}

    def __init__(self, body=b"{}"):
        super().__init__(body)
        self.code = self.status


class BrokerTest(unittest.TestCase):
    def setUp(self):
        broker.DIAGNOSTICS.clear()
        broker.set_token_provider(lambda: FIXTURE_TOKEN)
        self.server = broker.start_broker(port=0)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_address[1]
        self.upstream = []

        def fake_urlopen(req, timeout=None, context=None):
            body = req.data
            if body is not None and not isinstance(body, (bytes, bytearray)):
                body = b"".join(body)  # streamed iterable, as git uploads arrive
            self.upstream.append({
                "url": req.full_url, "method": req.get_method(),
                "data": body, "headers": dict(req.headers),
            })
            return FakeResponse(b'{"ok":true}')

        patcher = patch.object(broker.urllib.request, "urlopen", side_effect=fake_urlopen)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            res = conn.getresponse()
            return res.status, res.read(), dict(res.headers)
        finally:
            conn.close()

    def test_sentinel_never_forwarded_upstream(self):
        status, _, _ = self.request(
            "GET", "/octo/hello/info/refs?service=git-upload-pack",
            headers={"Authorization": f"Bearer {SENTINEL}"})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.upstream), 1)
        sent = json.dumps(self.upstream[0], default=str)
        self.assertNotIn(SENTINEL, sent)
        auth = self.upstream[0]["headers"].get("Authorization", "")
        self.assertTrue(auth.startswith("Basic "))
        self.assertEqual(base64.b64decode(auth[6:]).decode(), f"x-access-token:{FIXTURE_TOKEN}")

    def test_upstream_allowlist_rejects_other_hosts(self):
        # Authority-smuggling and traversal shapes are refused outright.
        for path in ("//evil.example.com/octo/hello/info/refs", "/octo/../../etc/passwd"):
            self.assertIsNone(broker.classify(path), path)
        status, _, _ = self.request("GET", "/octo/../../etc/passwd")
        self.assertEqual(status, 403)
        self.assertEqual(self.upstream, [])
        # Any other well-formed path can only ever land on api.github.com.
        self.request("GET", "/octo/hello")
        self.assertTrue(self.upstream[-1]["url"].startswith("https://api.github.com/"))

    def test_git_and_api_path_mapping(self):
        self.request("GET", "/octo/hello.git/info/refs?service=git-upload-pack")
        git = self.upstream[-1]
        self.assertTrue(git["url"].startswith("https://github.com/octo/hello"), git["url"])
        expected = "Basic " + base64.b64encode(f"x-access-token:{FIXTURE_TOKEN}".encode()).decode()
        self.assertEqual(git["headers"].get("Authorization"), expected)

        self.request("GET", "/repos/octo/hello/pulls")
        api = self.upstream[-1]
        self.assertEqual(api["url"], "https://api.github.com/repos/octo/hello/pulls")
        self.assertEqual(api["headers"].get("Authorization"), f"Bearer {FIXTURE_TOKEN}")

    def test_large_body_streamed_not_buffered(self):
        payload = b"x" * (3 * 1024 * 1024)
        status, _, _ = self.request("POST", "/octo/hello/git-receive-pack", body=payload,
                                    headers={"Content-Type": "application/x-git-receive-pack-request"})
        self.assertEqual(status, 200)
        self.assertEqual(self.upstream[-1]["data"], payload)
        source = pathlib.Path(broker.__file__).read_text()
        self.assertNotIn("rfile.read(length)", source, "request bodies must stream in chunks")

    def test_health_is_local_and_not_forwarded(self):
        status, body, _ = self.request("GET", "/__code_space/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(self.upstream, [])

    def test_upstream_error_status_passes_through(self):
        def fail(req, timeout=None, context=None):
            raise urllib.error.HTTPError(req.full_url, 404, "not found", {}, io.BytesIO(b"nope"))
        with patch.object(broker.urllib.request, "urlopen", side_effect=fail):
            status, body, _ = self.request("GET", "/repos/octo/missing")
        self.assertEqual(status, 404)
        self.assertEqual(body, b"nope")


class GitAuthSchemeTest(unittest.TestCase):
    def setUp(self):
        broker.DIAGNOSTICS.clear()
        self.server = broker.start_broker(port=0)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_address[1]
        self.upstream = []

        def fake_urlopen(req, timeout=None, context=None):
            self.upstream.append({"url": req.full_url, "headers": dict(req.headers)})
            return FakeResponse(b"{}")

        patcher = patch.object(broker.urllib.request, "urlopen", side_effect=fake_urlopen)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", path)
            res = conn.getresponse()
            res.read()
            return res.status
        finally:
            conn.close()

    def test_surrogate_git_fails_fast_with_reason_and_never_reaches_github(self):
        # Verified live: GitHub rejects Bearer for git transport, and
        # surrogates can only travel as Bearer — the broker must say so
        # itself instead of letting GitHub report a generic auth failure.
        broker.set_token_provider(lambda: "hsurr:fixture-surrogate")
        self.assertEqual(self.request("/octo/hello/info/refs?service=git-upload-pack"), 502)
        self.assertEqual(self.upstream, [])
        # ...while the API surface works: surrogate goes out as Bearer.
        self.assertEqual(self.request("/repos/octo/hello"), 200)
        self.assertEqual(self.upstream[-1]["headers"].get("Authorization"), "Bearer hsurr:fixture-surrogate")

    def test_real_token_keeps_basic_for_git(self):
        broker.set_token_provider(lambda: FIXTURE_TOKEN)
        self.assertEqual(self.request("/octo/hello/info/refs?service=git-upload-pack"), 200)
        expected = "Basic " + base64.b64encode(f"x-access-token:{FIXTURE_TOKEN}".encode()).decode()
        self.assertEqual(self.upstream[-1]["headers"].get("Authorization"), expected)


class RetryTest(unittest.TestCase):
    def setUp(self):
        broker.DIAGNOSTICS.clear()
        broker.set_token_provider(lambda: FIXTURE_TOKEN)
        self.server = broker.start_broker(port=0)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_address[1]
        self.calls = 0

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body)
            res = conn.getresponse()
            res.read()
            return res.status
        finally:
            conn.close()

    def test_bodiless_request_retries_once_on_connect_failure(self):
        def flaky(req, timeout=None, context=None):
            self.calls += 1
            if self.calls == 1:
                raise urllib.error.URLError("connection reset")
            return FakeResponse(b"{}")
        with patch.object(broker.urllib.request, "urlopen", side_effect=flaky):
            self.assertEqual(self.request("GET", "/repos/octo/hello"), 200)
        self.assertEqual(self.calls, 2)

    def test_body_request_is_not_retried(self):
        def failing(req, timeout=None, context=None):
            self.calls += 1
            raise urllib.error.URLError("connection reset")
        with patch.object(broker.urllib.request, "urlopen", side_effect=failing):
            self.assertEqual(self.request("POST", "/octo/hello/git-receive-pack", body=b"data"), 502)
        self.assertEqual(self.calls, 1, "streamed bodies cannot be replayed, so no retry")


class UpstreamContextTest(unittest.TestCase):
    def test_egress_ca_bundle_is_added_to_upstream_trust(self):
        import ssl
        ctx = broker.upstream_context(candidates=("/nonexistent/ca.pem",))
        self.assertIsInstance(ctx, ssl.SSLContext)
        # With the real egress bundle present, loading it must succeed.
        bundle = "/run/hatch/egress-tls/ca-bundle.pem"
        if pathlib.Path(bundle).exists():
            ctx2 = broker.upstream_context(candidates=(bundle,))
            self.assertIsInstance(ctx2, ssl.SSLContext)


class TokenProviderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import subprocess, tempfile
        cls.tmp = tempfile.mkdtemp()
        cls.key_path = f"{cls.tmp}/app-key.pem"
        subprocess.run(["openssl", "genrsa", "-out", cls.key_path, "2048"],
                       check=True, capture_output=True)
        cls.key_pem = pathlib.Path(cls.key_path).read_text()

    def test_app_jwt_claims_and_token_cache(self):
        import time
        exchanges = []

        def fake_exchange(jwt_token):
            exchanges.append(jwt_token)
            return {"token": "fixture-installation-token",
                    "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))}

        provider = broker.GitHubAppTokenProvider(
            "12345", "67890", self.key_pem, exchange=fake_exchange)
        token = provider()
        claims = broker.decode_jwt_claims(exchanges[0])
        header = broker.decode_jwt_header(exchanges[0])
        self.assertEqual(header["alg"], "RS256")
        self.assertEqual(claims["iss"], "12345")
        self.assertLessEqual(claims["exp"] - claims["iat"], 600)
        self.assertEqual(token, "fixture-installation-token")
        provider()  # cached: no second exchange while fresh
        self.assertEqual(len(exchanges), 1)
        provider._expires_at = time.time() + 299  # inside the refresh window
        provider()
        self.assertEqual(len(exchanges), 2, "re-mints when under 5 minutes remain")

    def test_app_jwt_signature_verifies_with_openssl(self):
        import subprocess
        provider = broker.GitHubAppTokenProvider(
            "12345", "67890", self.key_pem, exchange=lambda jwt: {"token": "t", "expires_at": "2999-01-01T00:00:00Z"})
        jwt_token = provider.make_jwt()
        signing_input, _, signature = jwt_token.rpartition(".")
        pub = f"{self.tmp}/app-pub.pem"
        subprocess.run(["openssl", "rsa", "-in", self.key_path, "-pubout", "-out", pub],
                       check=True, capture_output=True)
        sig_path, msg_path = f"{self.tmp}/sig.bin", f"{self.tmp}/msg.txt"
        pathlib.Path(sig_path).write_bytes(broker.base64url_decode(signature))
        pathlib.Path(msg_path).write_text(signing_input)
        result = subprocess.run(["openssl", "dgst", "-sha256", "-verify", pub,
                                 "-signature", sig_path, msg_path],
                                capture_output=True, text=True)
        self.assertIn("Verified OK", result.stdout + result.stderr)

    def test_pat_mode_attaches_token(self):
        import tempfile, os
        cfg = pathlib.Path(tempfile.mkdtemp()) / "github-broker.json"
        cfg.write_text(json.dumps({"mode": "pat", "token": "fixture-pat-token"}))
        provider = broker.config_token_provider(str(cfg))
        self.assertEqual(provider(), "fixture-pat-token")

    def test_surrogate_mode_validates_shape(self):
        import sys, types
        fake = types.ModuleType("dynamic_credentials")
        fake.dynamic_credential_entry = lambda name: {"surrogate": "hsurr:fixture"}
        sys.modules["dynamic_credentials"] = fake
        try:
            provider = broker.surrogate_token_provider("any-github-credential")
            self.assertEqual(provider(), "hsurr:fixture")
            fake.dynamic_credential_entry = lambda name: {"surrogate": "not-a-surrogate"}
            with self.assertRaises(RuntimeError):
                provider()
        finally:
            del sys.modules["dynamic_credentials"]


if __name__ == "__main__":
    unittest.main()

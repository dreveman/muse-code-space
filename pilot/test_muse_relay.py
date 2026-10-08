"""Isolated relay diagnostics tests; no authd, proxy or Meta network needed."""
import http.client
import importlib.util
import io
import json
import pathlib
import sys
import types
import unittest
import urllib.error
from unittest.mock import patch

sys.modules["dynamic_credentials"] = types.SimpleNamespace(
    dynamic_credential_entry=lambda _: {"surrogate": "hsurr:fixture-secret"}
)
spec = importlib.util.spec_from_file_location(
    "muse_relay_under_test", pathlib.Path(__file__).with_name("muse_relay.py")
)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class FakeResponse(io.BytesIO):
    status = 200
    headers = {"Content-Type": "application/json"}


class RelayDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        relay.DIAGNOSTICS.clear()
        relay.LAST_SUCCESS = None
        relay.LAST_FAILURE = None
        self.server = relay.start_relay(port=0)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_address[1]

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            res = conn.getresponse()
            return res.status, res.read()
        finally:
            conn.close()

    def diagnostics(self):
        status, data = self.request("GET", "/__code_space/diagnostics")
        self.assertEqual(status, 200)
        return json.loads(data)

    def test_health_and_diagnostics_are_local_and_not_recorded(self):
        self.assertIn("MUSE_CODE_SPACE_RELAY_PORT", pathlib.Path(relay.__file__).read_text())
        with patch.object(relay.urllib.request, "urlopen", side_effect=AssertionError("must not forward")):
            status, body = self.request("GET", "/__code_space/health")
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)["ok"])
            self.assertEqual(self.diagnostics()["entries"], [])

    def test_success_logs_only_bounded_metadata(self):
        captured = []
        def upstream(req, timeout):
            captured.append((req.full_url, req.get_header("Authorization")))
            return FakeResponse(b'{"ok":true}')
        with patch.object(relay.urllib.request, "urlopen", side_effect=upstream):
            status, body = self.request("POST", "/responses?private=query-secret", b"body-secret", {
                "Authorization": "Bearer original-secret", "X-API-Token": "header-secret",
            })
        self.assertEqual(status, 200)
        self.assertEqual(body, b'{"ok":true}')
        self.assertEqual(captured[0][0], "https://api.meta.ai/v1/responses?private=query-secret")
        self.assertEqual(captured[0][1], "Bearer hsurr:fixture-secret")
        diag = self.diagnostics()
        row = diag["entries"][0]
        self.assertEqual((row["method"], row["path"], row["status"], row["stage"]),
                         ("POST", "/v1/responses", 200, "complete"))
        self.assertEqual(row["requestBytes"], len(b"body-secret"))
        self.assertEqual(row["responseBytes"], len(body))
        for secret in ("body-secret", "query-secret", "header-secret", "original-secret", "fixture-secret"):
            self.assertNotIn(secret, json.dumps(diag))
        self.assertIsNotNone(diag["startedAt"])
        self.assertIsNotNone(diag["lastSuccessAt"])

    def test_upstream_status_and_failures_have_stage_but_no_error_text(self):
        error = urllib.error.HTTPError("https://api.meta.ai/v1/responses", 429, "quota-secret", {}, io.BytesIO(b"retry"))
        with patch.object(relay.urllib.request, "urlopen", side_effect=error):
            status, body = self.request("POST", "/responses", b"x")
        self.assertEqual((status, body), (429, b"retry"))
        self.assertEqual(self.diagnostics()["entries"][-1]["stage"], "upstream_http")
        with patch.object(relay, "fresh_surrogate", side_effect=RuntimeError("credential-secret")):
            status, _ = self.request("POST", "/responses", b"x")
        self.assertEqual(status, 502)
        self.assertEqual(self.diagnostics()["entries"][-1]["stage"], "credential")
        with patch.object(relay.urllib.request, "urlopen", side_effect=urllib.error.URLError("Tunnel connection failed: 407 proxy-secret")):
            status, _ = self.request("POST", "/responses", b"x")
        self.assertEqual(status, 502)
        self.assertEqual(self.diagnostics()["entries"][-1]["stage"], "proxy")
        for secret in ("credential-secret", "proxy-secret", "quota-secret"):
            self.assertNotIn(secret, json.dumps(self.diagnostics()))

    def test_stream_failure_is_visible_without_a_second_http_response(self):
        class BrokenStream(FakeResponse):
            def read(self, size=-1):
                raise TimeoutError("private-stream-error")
        with patch.object(relay.urllib.request, "urlopen", return_value=BrokenStream(b"")):
            try:
                self.request("POST", "/responses", b"x")
            except (http.client.IncompleteRead, http.client.RemoteDisconnected, OSError):
                pass  # The relay closes a partially sent HTTP response.
        row = self.diagnostics()["entries"][-1]
        self.assertEqual((row["status"], row["stage"], row["errorType"]),
                         (502, "response_stream", "TimeoutError"))
        self.assertNotIn("private-stream-error", json.dumps(self.diagnostics()))

    def test_ring_is_bounded(self):
        for _ in range(150):
            relay.record_diagnostic("POST", 200, "complete", relay.time.monotonic())
        self.assertEqual(len(self.diagnostics()["entries"]), 100)


if __name__ == "__main__":
    unittest.main()

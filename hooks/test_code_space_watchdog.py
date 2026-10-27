"""Behavioral tests with temporary hook state and an in-process pilot double."""

import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
SCRIPT = ROOT / "code-space-watchdog-state.py"
SPEC = importlib.util.spec_from_file_location("watchdog_state", SCRIPT)
watchdog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watchdog)
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz/8AAAAASUVORK5CYII="
AVATAR = "data:image/png;base64," + PNG


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="code-space-hook-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "state/watchdog.json"
        self.profile = self.root / "profile.json"
        self.avatar = self.root / "avatar.png"
        self.avatar.write_bytes(base64.b64decode(PNG))
        self.desired = {"name": "Actual Muse", "color": "#aabbcc", "avatar_path": "avatar.png"}
        self.write_profile()
        self.current = {"name": "Jolly", "color": "#d0e4fc", "avatar_data_url": None}
        self.inbox = {"messages": [], "latest": 0}
        self.now = 1000000
        self.pilot = patch.object(watchdog, "pilot_get", side_effect=self.get)
        self.pilot.start()
        self.addCleanup(self.pilot.stop)

    def write_profile(self):
        self.profile.write_text(json.dumps(self.desired))

    def get(self, _url, route):
        if route == "/assistant":
            return copy.deepcopy(self.current)
        cursor = int(route.split("since=")[1])
        return {"messages": [copy.deepcopy(message) for message in self.inbox["messages"]
                             if type(message.get("seq")) is not int or message["seq"] > cursor],
                "latest": self.inbox["latest"]}

    def inspect(self, **kwargs):
        return watchdog.inspect_state(self.state, "http://pilot.test", str(self.profile), "artifact-one",
                                      now_ms=self.now, **kwargs)

    def inspect_worker(self, **kwargs):
        return watchdog.inspect_state(self.state, "http://pilot.test", None, "artifact-one",
                                      now_ms=self.now, **kwargs)

    def complete_worker_identity(self, issue=None, expected=None):
        if issue is None:
            issue = next(item for item in self.inspect_worker() if item["type"] == "assistant_identity_needs_sync")
        if expected is None:
            expected = {"name": "Actual Muse", "color": self.current["color"], "avatar_data_url": AVATAR}
        payload = self.root / "worker-upload.json"
        payload.write_text(json.dumps(expected))
        self.current = copy.deepcopy(expected)
        watchdog.acknowledge_identity(self.state, issue["lease"], payload)

    def message_batch(self, *sequences):
        self.inbox = {"messages": [{"seq": seq, "text": "private message"} for seq in sequences],
                      "latest": max(sequences, default=0)}

    def complete_identity(self, issue=None):
        if issue is None:
            issue = next(item for item in self.inspect() if item["type"] == "assistant_identity_needs_sync")
        expected = {"name": self.desired["name"], "color": self.desired["color"], "avatar_data_url": AVATAR}
        expected_file = self.root / "upload.json"
        expected_file.write_text(json.dumps(expected))
        self.current = expected
        watchdog.acknowledge_identity(self.state, issue["lease"], expected_file)

    def test_initial_identity_requires_a_worker_and_complete_avatar(self):
        issues = self.inspect()
        self.assertEqual(issues[0]["reason"], "not_synchronized")
        self.assertIsNone(json.loads(self.state.read_text())["identity"])
        self.complete_identity(issues[0])
        self.assertEqual(self.inspect(), [])
        self.assertEqual(os.stat(self.state).st_mode & 0o777, 0o600)
        self.assertNotIn("base64", self.state.read_text())

    def test_name_only_update_cannot_acknowledge_an_avatar_upload(self):
        issue = self.inspect()[0]
        expected_file = self.root / "upload.json"
        expected_file.write_text(json.dumps({"name": "Actual Muse", "color": "#aabbcc"}))
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_identity(self.state, issue["lease"], expected_file)
        expected_file.write_text(json.dumps({"name": "Actual Muse", "color": "#aabbcc", "avatar_data_url": AVATAR}))
        self.current.update(name="Actual Muse", color="#aabbcc")  # Avatar upload did not happen.
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_identity(self.state, issue["lease"], expected_file)
        self.assertIsNone(json.loads(self.state.read_text())["identity"])

    def test_upload_does_not_spawn_a_second_identity_worker_before_ack(self):
        issue = self.inspect()[0]
        self.current = {"name": "Actual Muse", "color": "#aabbcc", "avatar_data_url": AVATAR}
        self.now += 15000
        self.assertEqual(self.inspect(), [])
        self.complete_identity(issue)

    def test_source_name_color_avatar_bytes_and_revision_changes_are_detected(self):
        self.complete_identity()
        for field, value in [("name", "New Muse"), ("color", "#112233"), ("revision", "v2")]:
            with self.subTest(field=field):
                self.desired[field] = value
                self.write_profile()
                issue = self.inspect()[0]
                self.assertEqual(issue["reason"], "profile_changed")
                self.complete_identity(issue)
        self.avatar.write_bytes(self.avatar.read_bytes() + b"new artwork bytes")
        self.assertEqual(self.inspect()[0]["reason"], "profile_changed")

    def test_saved_identity_reset_or_avatar_removal_is_detected(self):
        self.complete_identity()
        self.current["avatar_data_url"] = None
        issue = self.inspect()[0]
        self.assertEqual(issue["reason"], "saved_identity_changed")
        self.complete_identity(issue)
        self.current["name"] = "Unexpected name"
        self.assertEqual(self.inspect()[0]["reason"], "saved_identity_changed")

    def test_explicit_profile_avatar_removal_must_be_synced(self):
        self.complete_identity()
        self.desired["avatar_path"] = None
        self.write_profile()
        issue = self.inspect()[0]
        expected = {"name": "Actual Muse", "color": "#aabbcc", "avatar_data_url": None}
        path = self.root / "clear.json"
        path.write_text(json.dumps(expected))
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_identity(self.state, issue["lease"], path)
        self.current = expected
        watchdog.acknowledge_identity(self.state, issue["lease"], path)
        self.assertEqual(self.inspect(), [])

    def test_changed_source_or_replaced_lease_rejects_an_old_worker(self):
        old = self.inspect()[0]
        self.desired["color"] = "#112233"
        self.write_profile()
        with self.assertRaises(watchdog.WatchdogError):
            self.complete_identity(old)
        new = self.inspect()[0]
        self.assertNotEqual(new["lease"], old["lease"])
        with self.assertRaises(watchdog.WatchdogError):
            self.complete_identity(old)
        self.complete_identity(new)

    def test_leases_retry_after_ten_minutes(self):
        self.message_batch(1)
        first = self.inspect()
        self.now += watchdog.RETRY_MS - 1
        self.assertEqual(self.inspect(), [])
        self.now += 1
        second = self.inspect()
        self.assertEqual({item["type"] for item in first}, {item["type"] for item in second})
        self.assertNotEqual(first[0]["lease"], second[0]["lease"])

    def test_missing_profile_does_not_block_messages_or_count_as_synced(self):
        self.message_batch(2)
        issues = watchdog.inspect_state(self.state, "http://pilot.test", None, "artifact-one", now_ms=self.now)
        self.assertEqual({item["type"] for item in issues}, {"assistant_identity_needs_sync", "muse_messages_pending"})
        self.assertIn("worker_source", [item.get("reason") for item in issues])
        self.assertIsNone(json.loads(self.state.read_text())["identity"])

    def test_worker_mode_initial_sync_issues_and_acks(self):
        self.profile.unlink()
        issue = self.inspect_worker()[0]
        self.assertEqual(issue["reason"], "worker_source")
        self.assertNotIn("profile_file", issue)
        pending = watchdog.load_state(self.state)["pending"]["identity"]
        self.assertEqual(pending["mode"], "worker")
        self.assertNotIn("profile_file", pending)
        self.assertNotIn("source_fingerprint", pending)
        self.complete_worker_identity(issue)
        state = watchdog.load_state(self.state)
        self.assertEqual(state["version"], 1)
        self.assertEqual(state["identity"], {
            "target_fingerprint": watchdog.fingerprint(self.current),
            "source_fingerprint": watchdog.fingerprint({
                "name": "Actual Muse", "color": "#d0e4fc",
                "avatar_sha256": hashlib.sha256(base64.b64decode(PNG)).hexdigest(), "revision": None,
            }),
        })
        self.assertNotIn("identity", state["pending"])
        self.assertNotIn("base64", self.state.read_text())
        self.assertNotIn(PNG, self.state.read_text())
        self.assertEqual(self.inspect_worker(), [])

    def test_worker_mode_saved_identity_drift_is_detected(self):
        self.complete_worker_identity()
        self.assertEqual(self.inspect_worker(), [])
        self.current["avatar_data_url"] = None
        old = self.inspect_worker()[0]
        self.assertEqual(old["reason"], "worker_source")
        self.now += 15000
        self.current["name"] = "Changed saved name"
        new = self.inspect_worker()[0]
        self.assertEqual(new["reason"], "worker_source")
        self.assertNotEqual(old["lease"], new["lease"])

    def test_worker_mode_steady_poll_adds_no_profile_avatar_or_network_work(self):
        self.complete_worker_identity()
        self.profile.unlink()
        before = {path.relative_to(self.root) for path in self.root.rglob("*")}
        with patch.object(watchdog, "profile_fields", side_effect=AssertionError("Must not read profiles")), \
                patch.object(watchdog.base64, "b64decode", side_effect=AssertionError("Must not decode avatars")), \
                patch.object(watchdog, "pilot_get", side_effect=self.get) as requests:
            self.assertEqual(self.inspect_worker(), [])
        self.assertEqual([call.args[1] for call in requests.call_args_list],
                         ["/assistant", "/messages/muse?since=0"])
        self.assertEqual({path.relative_to(self.root) for path in self.root.rglob("*")}, before)

    def test_unchanged_worker_identity_is_suppressed_until_the_lease_expires(self):
        first = self.inspect_worker()[0]
        self.now += watchdog.RETRY_MS - 1
        self.assertEqual(self.inspect_worker(), [])
        self.now += 1
        second = self.inspect_worker()[0]
        self.assertEqual(second["reason"], "worker_source")
        self.assertNotEqual(first["lease"], second["lease"])

    def test_target_drift_replaces_a_fresh_worker_lease_promptly(self):
        old = self.inspect_worker()[0]
        self.now += 15000
        self.current["name"] = "Saved identity changed"
        new = self.inspect_worker()[0]
        self.assertNotEqual(old["lease"], new["lease"])
        self.assertEqual(new["reason"], "worker_source")
        before = self.state.read_bytes()
        with self.assertRaises(watchdog.WatchdogError):
            self.complete_worker_identity(old)
        self.assertEqual(self.state.read_bytes(), before)

    def test_worker_mode_ack_rejects_stale_lease_and_mismatched_saved_identity(self):
        issue = self.inspect_worker()[0]
        payload = self.root / "worker-upload.json"
        before = self.state.read_bytes()
        payload.write_text(json.dumps(self.current))
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_identity(self.state, "another-workers-lease", payload)
        self.assertEqual(self.state.read_bytes(), before)
        for expected in [
            {"name": "Actual Muse", "color": "#d0e4fc"},
            {"name": "Actual Muse", "color": "#d0e4fc", "avatar_data_url": AVATAR},
            {"name": "Jolly", "color": "#112233", "avatar_data_url": None},
            {"name": "Jolly", "color": "#d0e4fc", "avatar_data_url": AVATAR},
        ]:
            with self.subTest(expected=expected):
                payload.write_text(json.dumps(expected))
                with self.assertRaises(watchdog.WatchdogError):
                    watchdog.acknowledge_identity(self.state, issue["lease"], payload)
                self.assertEqual(self.state.read_bytes(), before)

    def test_worker_ack_requires_valid_avatar_bytes_even_if_the_target_matches(self):
        issue = self.inspect_worker()[0]
        payload = self.root / "worker-upload.json"
        self.current.update(avatar_data_url="data:image/png;base64,invalid!")
        payload.write_text(json.dumps(self.current))
        before = self.state.read_bytes()
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_identity(self.state, issue["lease"], payload)
        self.assertEqual(self.state.read_bytes(), before)

    def test_worker_mode_avatar_removal_acks(self):
        self.current["avatar_data_url"] = AVATAR
        issue = self.inspect_worker()[0]
        self.complete_worker_identity(issue, {"name": "Actual Muse", "color": "#d0e4fc", "avatar_data_url": None})
        self.assertEqual(self.inspect_worker(), [])
        self.assertEqual(watchdog.load_state(self.state)["identity"]["source_fingerprint"], watchdog.fingerprint({
            "name": "Actual Muse", "color": "#d0e4fc", "avatar_sha256": None, "revision": None,
        }))

    def test_worker_claim_flag_emits_lease_only_for_the_worker(self):
        self.complete_worker_identity()
        self.assertEqual(self.inspect_worker(), [])
        first = self.inspect_worker(worker_identity=True)[0]
        second = self.inspect_worker(worker_identity=True)[0]
        self.assertEqual(first["reason"], "worker_source")
        self.assertNotEqual(first["lease"], second["lease"])
        before = self.state.read_bytes()
        with self.assertRaises(watchdog.WatchdogError):
            self.complete_worker_identity(first)
        self.assertEqual(self.state.read_bytes(), before)
        # An unchanged saved identity needs no poller work; it clears stale claims.
        self.assertEqual(self.inspect_worker(), [])
        self.assertNotIn("identity", watchdog.load_state(self.state)["pending"])
        with self.assertRaises(watchdog.WatchdogError):
            self.inspect(worker_identity=True)

    def test_worker_claim_can_ack_a_new_live_identity_while_preserving_the_saved_color(self):
        self.complete_worker_identity()
        issue = self.inspect_worker(worker_identity=True)[0]
        self.complete_worker_identity(issue, {"name": "Renamed Muse", "color": self.current["color"],
                                              "avatar_data_url": AVATAR})
        self.assertEqual(self.inspect_worker(), [])

    def test_worker_claim_is_invalid_with_a_profile_in_both_python_and_cli(self):
        with self.assertRaises(watchdog.WatchdogError):
            self.inspect(worker_identity=True)
        self.assertFalse(self.state.parent.exists())
        result = subprocess.run([sys.executable, str(SCRIPT), "inspect", "--state-file", str(self.state),
                                 "--profile-file", str(self.profile), "--worker-identity"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not allowed", result.stderr)
        self.assertFalse(self.state.parent.exists())

    def test_worker_dry_run_and_explicit_claim_leave_state_untouched(self):
        self.assertEqual(self.inspect_worker(dry_run=True)[0]["reason"], "worker_source")
        self.assertFalse(self.state.parent.exists())
        self.complete_worker_identity()
        before = self.state.read_bytes()
        self.assertEqual(self.inspect_worker(dry_run=True, worker_identity=True)[0]["reason"], "worker_source")
        self.assertEqual(self.state.read_bytes(), before)

    def test_parallel_worker_polls_create_only_one_identity_lease(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.inspect_worker(), range(2)))
        self.assertEqual(sum(len(result) for result in results), 1)

    def test_worker_mode_accepts_profile_acknowledgements_and_detects_later_saved_drift(self):
        self.complete_identity()
        self.profile.unlink()
        self.assertEqual(self.inspect_worker(), [])
        self.current["avatar_data_url"] = None
        self.assertEqual(self.inspect_worker()[0]["reason"], "worker_source")

    def test_worker_mode_clears_old_unconfigured_profile_errors_without_resetting_inbox_progress(self):
        state = watchdog.new_state("http://pilot.test", "artifact-one")
        state["handled_message_seq"] = 5
        state["pending"]["identity_check"] = {
            "signature": "old-profile-error", "lease": "old-error-lease",
            "leased_at_ms": self.now, "profile_file": None,
        }
        watchdog.save_state(self.state, state)
        self.message_batch(7)
        issues = self.inspect_worker()
        self.assertEqual({issue["type"] for issue in issues}, {"assistant_identity_needs_sync", "muse_messages_pending"})
        identity = next(issue for issue in issues if issue["type"] == "assistant_identity_needs_sync")
        self.complete_worker_identity(identity)
        state = watchdog.load_state(self.state)
        self.assertNotIn("identity_check", state["pending"])
        self.assertEqual(state["handled_message_seq"], 5)
        self.assertEqual(state["pending"]["messages"]["since"], 5)

    def test_worker_mode_pending_state_round_trips(self):
        self.inspect_worker()
        state = watchdog.load_state(self.state)
        watchdog.save_state(self.state, state)
        self.assertEqual(watchdog.load_state(self.state), state)
        for field, value in [("profile_file", str(self.profile)), ("lease", None),
                             ("signature", False), ("leased_at_ms", "invalid")]:
            with self.subTest(field=field):
                corrupt = copy.deepcopy(state)
                corrupt["pending"]["identity"][field] = value
                watchdog.save_state(self.state, corrupt)
                with self.assertRaises(watchdog.WatchdogError):
                    watchdog.load_state(self.state)

    def test_missing_configured_profile_does_not_fall_back_to_worker_mode(self):
        self.profile.unlink()
        self.message_batch(1)
        issues = self.inspect()
        identity = next(issue for issue in issues if issue["type"] == "assistant_identity_needs_sync")
        self.assertNotEqual(identity["reason"], "worker_source")
        self.assertEqual(identity["profile_file"], str(self.profile))
        self.assertEqual(len([issue for issue in issues if issue["type"] == "muse_messages_pending"]), 1)
        self.assertNotIn("identity", watchdog.load_state(self.state)["pending"])

    def test_worker_identity_read_failure_preserves_existing_lease_and_inbox_progress(self):
        identity = self.inspect_worker()[0]
        self.message_batch(2)
        get = self.get

        def unavailable_identity(url, route):
            if route == "/assistant":
                raise watchdog.WatchdogError("Pilot identity is temporarily unavailable.")
            return get(url, route)

        with patch.object(watchdog, "pilot_get", side_effect=unavailable_identity):
            issues = self.inspect_worker()
        self.assertEqual({issue["type"] for issue in issues}, {"assistant_identity_needs_sync", "muse_messages_pending"})
        self.assertEqual(watchdog.load_state(self.state)["pending"]["identity"]["lease"], identity["lease"])
        self.assertEqual(watchdog.load_state(self.state)["handled_message_seq"], 0)
        self.complete_worker_identity(identity)

    def test_partial_inbox_ack_is_durable_and_new_arrivals_wait_for_current_batch(self):
        self.message_batch(2, 5)
        issue = next(item for item in self.inspect() if item["type"] == "muse_messages_pending")
        self.assertEqual(json.loads(self.state.read_text())["handled_message_seq"], 0)
        watchdog.acknowledge_messages(self.state, issue["lease"], 2, now_ms=self.now)
        self.message_batch(2, 5, 7)
        self.now += 15000
        self.assertEqual(self.inspect(), [])
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_messages(self.state, issue["lease"], 7)
        watchdog.acknowledge_messages(self.state, issue["lease"], 5)
        watchdog.acknowledge_messages(self.state, issue["lease"], 5)  # Retry a lost acknowledgement response.
        next_issue = self.inspect()[0]
        self.assertEqual(next_issue["since"], 5)
        self.assertEqual(next_issue["latest"], 7)
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_messages(self.state, issue["lease"], 7)
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.acknowledge_messages(self.state, next_issue["lease"], 2)
        watchdog.acknowledge_messages(self.state, next_issue["lease"], 7)
        self.assertEqual(self.inspect(), [])

    def test_empty_inbox_checks_never_advance_the_handled_cursor(self):
        self.inbox["latest"] = 8
        self.inspect()
        self.assertEqual(json.loads(self.state.read_text())["handled_message_seq"], 0)

    def test_dry_run_neither_creates_state_nor_changes_existing_leases(self):
        self.message_batch(1)
        self.assertEqual(len(self.inspect(dry_run=True)), 2)
        self.assertFalse(self.state.parent.exists())
        self.inspect()
        before = self.state.read_bytes()
        self.now += watchdog.RETRY_MS
        self.inspect(dry_run=True)
        self.assertEqual(self.state.read_bytes(), before)

    def test_parallel_inspections_claim_each_kind_of_work_once(self):
        self.message_batch(1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.inspect(), range(2)))
        flattened = [issue for result in results for issue in result]
        self.assertEqual(len(flattened), 2)
        self.assertEqual(len({issue["type"] for issue in flattened}), 2)

    def test_bad_pilot_response_does_not_look_like_an_empty_inbox(self):
        self.complete_identity()
        self.inbox = {"messages": [{"seq": "invalid"}], "latest": 3}
        issue = self.inspect()[0]
        self.assertEqual(issue["type"], "muse_messages_check_failed")
        self.assertEqual(json.loads(self.state.read_text())["handled_message_seq"], 0)
        self.assertEqual(self.inspect(), [])  # Error wakeups are also throttled.

    def test_corrupt_state_is_reported_without_resetting_it(self):
        self.state.parent.mkdir()
        self.state.write_text('{"version":1,"handled_message_seq":45,"pending":[]}')
        before = self.state.read_bytes()
        result = subprocess.run([sys.executable, str(SCRIPT), "inspect", "--state-file", str(self.state)],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)[0]["type"], "code_space_watchdog_state_invalid")
        self.assertEqual(self.state.read_bytes(), before)

    def test_state_cannot_be_reused_for_a_different_artifact(self):
        self.inspect()
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.inspect_state(self.state, "http://pilot.test", str(self.profile), "other-artifact")

    def test_existing_handled_cursor_can_be_imported_once_before_installation(self):
        self.message_batch(2, 5, 7)
        watchdog.initialize_state(self.state, "http://pilot.test", "artifact-one", 5)
        message = next(issue for issue in self.inspect() if issue["type"] == "muse_messages_pending")
        self.assertEqual(message["since"], 5)
        self.assertEqual(message["count"], 1)
        before = self.state.read_bytes()
        with self.assertRaises(watchdog.WatchdogError):
            watchdog.initialize_state(self.state, "http://pilot.test", "artifact-one", 0)
        self.assertEqual(self.state.read_bytes(), before)

    def test_cursor_import_rejects_a_wrong_pilot_or_negative_sequence(self):
        for cursor in [-1, 5]:
            with self.assertRaises(watchdog.WatchdogError):
                watchdog.initialize_state(self.state, "http://pilot.test", "artifact-one", cursor)
        self.assertFalse(self.state.exists())

    def test_hook_uses_real_gets_and_does_not_need_an_artifact_db(self):
        self.exercise_hook_round_trip(profile_mode=True)

    def test_worker_mode_hook_and_cli_complete_sync_without_a_profile_or_artifact_db(self):
        self.profile.unlink()
        self.exercise_hook_round_trip(profile_mode=False)

    def exercise_hook_round_trip(self, *, profile_mode):
        requested = []
        current = self.current

        class Pilot(BaseHTTPRequestHandler):
            def do_GET(inner):
                requested.append(inner.path)
                payload = ({"ok": True} if inner.path == "/health" else current if inner.path == "/assistant" else
                           {"messages": [{"seq": 1, "text": "message must not leak into wake payload"}]
                            if inner.path.endswith("since=0") else [], "latest": 1})
                inner.send_response(200)
                inner.send_header("Content-Type", "application/json")
                inner.end_headers()
                inner.wfile.write(json.dumps(payload).encode())

            def log_message(*_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Pilot)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        runtime = self.root / "runtime.sh"
        runtime.write_text('wake() { echo "$2"; }; silent() { echo "$2"; }; log() { :; };\n')
        binaries = self.root / "bin"
        binaries.mkdir()
        systemctl = binaries / "systemctl"
        systemctl.write_text("#!/bin/sh\nexit 0\n")
        systemctl.chmod(0o755)
        environment = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                       "HATCH_HOOK_RUNTIME": str(runtime), "HATCH_HOOK_DRY_RUN": "1",
                       "MUSE_CODE_SPACE_PILOT_URL": f"http://127.0.0.1:{server.server_port}",
                       "MUSE_CODE_SPACE_ASSISTANT_PROFILE": str(self.profile),
                       "MUSE_CODE_SPACE_WATCHDOG_STATE_DIR": str(self.root / "isolated-state"),
                       "MUSE_CODE_SPACE_ARTIFACTS_DIR": str(self.root / "no-artifact-db")}
        if not profile_mode:
            environment.pop("MUSE_CODE_SPACE_ASSISTANT_PROFILE", None)
        result = subprocess.run(["bash", str(ROOT / "code-space-watchdog.sh")], env=environment,
                                capture_output=True, text=True, check=True)
        issues = json.loads(result.stdout)["issues"]
        self.assertEqual({issue["type"] for issue in issues}, {"assistant_identity_needs_sync", "muse_messages_pending"})
        self.assertEqual(set(requested), {"/health", "/assistant", "/messages/muse?since=0"})
        self.assertNotIn("message must not leak", result.stdout)
        self.assertNotIn("base64", result.stdout)
        self.assertFalse((self.root / "isolated-state").exists())
        environment["HATCH_HOOK_DRY_RUN"] = "0"
        result = subprocess.run(["bash", str(ROOT / "code-space-watchdog.sh")], env=environment,
                                capture_output=True, text=True, check=True)
        issues = json.loads(result.stdout)["issues"]
        identity = next(issue for issue in issues if issue["type"] == "assistant_identity_needs_sync")
        messages = next(issue for issue in issues if issue["type"] == "muse_messages_pending")
        if not profile_mode:
            self.assertEqual(identity["reason"], "worker_source")
            self.assertNotIn("profile_file", identity)
        upload = self.root / "actual-upload.json"
        current.update(name="Actual Muse", color="#aabbcc" if profile_mode else current["color"], avatar_data_url=AVATAR)
        upload.write_text(json.dumps(current))
        for command in [
            ["ack-identity", "--state-file", identity["state_file"], "--lease", identity["lease"], "--identity-file", str(upload)],
            ["ack-messages", "--state-file", messages["state_file"], "--lease", messages["lease"], "--through", "1"],
        ]:
            result = subprocess.run([sys.executable, str(SCRIPT), *command], capture_output=True, text=True, check=True)
            self.assertTrue(json.loads(result.stdout)["ok"])
        result = subprocess.run(["bash", str(ROOT / "code-space-watchdog.sh")], env=environment,
                                capture_output=True, text=True, check=True)
        self.assertNotIn("issues", json.loads(result.stdout))
        self.assertEqual(json.loads(Path(messages["state_file"]).read_text())["handled_message_seq"], 1)
        self.assertIn("/messages/muse?since=1", requested)
        if not profile_mode:
            result = subprocess.run([sys.executable, str(SCRIPT), "inspect", "--state-file", identity["state_file"],
                                     "--pilot-url", environment["MUSE_CODE_SPACE_PILOT_URL"],
                                     "--scope", identity["scope"], "--worker-identity"],
                                    capture_output=True, text=True, check=True)
            claim = json.loads(result.stdout)[0]
            self.assertEqual(claim["reason"], "worker_source")
            self.assertNotEqual(claim["lease"], identity["lease"])
            current["name"] = "Live Muse renamed"
            upload.write_text(json.dumps(current))
            result = subprocess.run([sys.executable, str(SCRIPT), "ack-identity", "--state-file", claim["state_file"],
                                     "--lease", claim["lease"], "--identity-file", str(upload)],
                                    capture_output=True, text=True, check=True)
            self.assertTrue(json.loads(result.stdout)["ok"])
            result = subprocess.run(["bash", str(ROOT / "code-space-watchdog.sh")], env=environment,
                                    capture_output=True, text=True, check=True)
            self.assertNotIn("issues", json.loads(result.stdout))

    def test_worker_and_profile_modes_sync_and_detect_user_name_drift(self):
        # 1. Start with a legacy 3-field acknowledgement, then pilot begins returning user_name: None.
        self.complete_worker_identity()
        self.assertEqual(self.inspect_worker(), [])
        self.current["user_name"] = None
        issue = self.inspect_worker()[0]
        self.assertEqual(issue["reason"], "worker_source")

        # Worker syncs user_name alongside name, color, and avatar_data_url.
        self.complete_worker_identity(issue, {
            "name": "Actual Muse",
            "color": "#d0e4fc",
            "avatar_data_url": AVATAR,
            "user_name": "Alex",
        })
        self.assertEqual(self.inspect_worker(), [])

        # If user_name on the pilot is cleared or changed, inspect wakes the worker again.
        self.current["user_name"] = None
        drift_issue = self.inspect_worker()[0]
        self.assertEqual(drift_issue["reason"], "worker_source")

    def test_hook_discovers_sessions_needing_summary_via_python_sqlite_without_sqlite3_cli(self):
        import sqlite3

        artifacts_dir = self.root / "ts-spaces"
        space_dir = artifacts_dir / "code-space-live"
        space_dir.mkdir(parents=True)
        (space_dir / "space.json").write_text(json.dumps({"name": "Code Space", "slug": "code-space-live"}))
        db_path = space_dir / "app.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, archived INTEGER NOT NULL, session_summary TEXT)"
        )
        conn.execute("INSERT INTO sessions VALUES ('sess-needs-summary', 0, NULL)")
        conn.execute("INSERT INTO sessions VALUES ('sess-blank-summary', 0, '   ')")
        conn.execute("INSERT INTO sessions VALUES ('sess-has-summary', 0, 'Already summarized')")
        conn.execute("INSERT INTO sessions VALUES ('sess-archived', 1, NULL)")
        conn.commit()
        conn.close()

        self.complete_worker_identity()
        current = self.current

        class Pilot(BaseHTTPRequestHandler):
            def do_GET(inner):
                payload = (
                    {"ok": True}
                    if inner.path == "/health"
                    else current
                    if inner.path == "/assistant"
                    else {"messages": [], "latest": 0}
                )
                inner.send_response(200)
                inner.send_header("Content-Type", "application/json")
                inner.end_headers()
                inner.wfile.write(json.dumps(payload).encode())

            def log_message(*_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Pilot)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        runtime = self.root / "runtime.sh"
        runtime.write_text('wake() { echo "$2"; }; silent() { echo "$2"; }; log() { :; };\n')
        binaries = self.root / "bin"
        binaries.mkdir(exist_ok=True)
        for tool, code in [("systemctl", 0), ("sqlite3", 127)]:
            stub = binaries / tool
            stub.write_text(f"#!/bin/sh\nexit {code}\n")
            stub.chmod(0o755)

        environment = {
            **os.environ,
            "HOME": str(self.root),
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "HATCH_HOOK_RUNTIME": str(runtime),
            "MUSE_CODE_SPACE_PILOT_URL": f"http://127.0.0.1:{server.server_port}",
            "MUSE_CODE_SPACE_ARTIFACT_SLUG": "code-space-live",
            "MUSE_CODE_SPACE_WATCHDOG_STATE_DIR": str(self.root / "state"),
            "MUSE_CODE_SPACE_ARTIFACTS_DIR": str(artifacts_dir),
        }
        environment.pop("HATCH_HOOK_DRY_RUN", None)
        result = subprocess.run(
            ["bash", str(ROOT / "code-space-watchdog.sh")],
            env=environment,
            capture_output=True,
            text=True,
            check=True,
        )
        issues = json.loads(result.stdout)["issues"]
        summary_issue = next(i for i in issues if i["type"] == "sessions_needing_summary")
        self.assertEqual(set(summary_issue["session_ids"]), {"sess-needs-summary", "sess-blank-summary"})


if __name__ == "__main__":
    unittest.main()

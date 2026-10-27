#!/usr/bin/env python3
"""Read-only pilot checks and durable worker acknowledgements (stdlib only)."""

import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.request
import uuid

RETRY_MS = 10 * 60 * 1000
MAX_PROFILE_BYTES = 8 * 1024 * 1024


class WatchdogError(Exception):
    pass


def fingerprint(value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(data.encode()).hexdigest()


def read_json(path, limit=MAX_PROFILE_BYTES * 2):
    try:
        with Path(path).open("rb") as handle:
            raw = handle.read(limit + 1)
        if len(raw) > limit:
            raise WatchdogError("JSON file exceeds its size limit.")
        return json.loads(raw)
    except (OSError, ValueError) as error:
        raise WatchdogError("JSON file is missing, unreadable, or invalid.") from error


def normalize_user_name(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise WatchdogError("Identity user_name must be a string or null.")
    cleaned = value.strip()
    if not cleaned:
        raise WatchdogError("Identity user_name must not be blank (use null to clear).")
    return cleaned


def identity_fields(value):
    if not isinstance(value, dict) or not {"name", "color", "avatar_data_url"} <= value.keys():
        raise WatchdogError("Identity must contain name, color, and avatar_data_url.")
    if not isinstance(value["name"], str) or not value["name"].strip():
        raise WatchdogError("Identity name is missing.")
    if not isinstance(value["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value["color"]):
        raise WatchdogError("Identity color must be #rrggbb.")
    avatar = value["avatar_data_url"]
    if avatar is not None and (not isinstance(avatar, str) or not avatar.startswith("data:image/")):
        raise WatchdogError("Identity avatar must be a raster data URL or null.")
    result = {"name": value["name"].strip(), "color": value["color"].lower(), "avatar_data_url": avatar}
    if "user_name" in value:
        result["user_name"] = normalize_user_name(value["user_name"])
    return result


def profile_fields(path):
    if not path:
        raise WatchdogError("Profile file is required in profile mode.")
    data = read_json(path)
    if not isinstance(data, dict):
        raise WatchdogError("Profile must be a JSON object.")
    # Requiring an explicit avatar field distinguishes absent configuration
    # from a profile that deliberately has no avatar.
    if ("avatar_path" in data) == ("avatar_data_url" in data):
        raise WatchdogError("Profile needs exactly one of avatar_path or avatar_data_url (null clears it).")
    identity = identity_fields({"name": data.get("name"), "color": data.get("color"), "avatar_data_url": None})
    avatar = data.get("avatar_path") if "avatar_path" in data else data["avatar_data_url"]
    avatar_bytes = None
    if avatar is not None:
        if not isinstance(avatar, str) or not avatar:
            raise WatchdogError("Profile avatar must be a nonempty path/data URL, or null.")
        if "avatar_path" in data:
            image = Path(avatar).expanduser()
            if not image.is_absolute():
                image = Path(path).parent / image
            try:
                with image.open("rb") as handle:
                    avatar_bytes = handle.read(MAX_PROFILE_BYTES + 1)
            except OSError as error:
                raise WatchdogError("Profile avatar file is unavailable.") from error
        else:
            try:
                prefix, payload = avatar.split(",", 1)
                if not prefix.startswith("data:image/") or not prefix.endswith(";base64"):
                    raise ValueError()
                avatar_bytes = base64.b64decode(payload, validate=True)
            except (ValueError, TypeError) as error:
                raise WatchdogError("Profile avatar is not a base64 image data URL.") from error
        if not avatar_bytes or len(avatar_bytes) > MAX_PROFILE_BYTES:
            raise WatchdogError("Profile avatar must contain 1 byte to 8 MiB of image data.")
    source = {
        "name": identity["name"], "color": identity["color"],
        "avatar_sha256": hashlib.sha256(avatar_bytes).hexdigest() if avatar_bytes is not None else None,
        "revision": data.get("revision"),
    }
    if "user_name" in data:
        source["user_name"] = normalize_user_name(data["user_name"])
    return source


def uploaded_source_fields(identity):
    """Fingerprint a worker's actual upload without retaining image bytes."""
    avatar = identity["avatar_data_url"]
    avatar_bytes = None
    if avatar is not None:
        try:
            prefix, payload = avatar.split(",", 1)
            if not prefix.startswith("data:image/") or not prefix.endswith(";base64"):
                raise ValueError()
            avatar_bytes = base64.b64decode(payload, validate=True)
        except (ValueError, TypeError) as error:
            raise WatchdogError("Uploaded avatar is not a base64 image data URL.") from error
        if not avatar_bytes or len(avatar_bytes) > MAX_PROFILE_BYTES:
            raise WatchdogError("Uploaded avatar must contain 1 byte to 8 MiB of image data.")
    result = {
        "name": identity["name"], "color": identity["color"],
        "avatar_sha256": hashlib.sha256(avatar_bytes).hexdigest() if avatar_bytes is not None else None,
        "revision": None,
    }
    if "user_name" in identity:
        result["user_name"] = identity["user_name"]
    return result


def pilot_get(base_url, route):
    try:
        with urllib.request.urlopen(base_url.rstrip("/") + route, timeout=3) as response:
            raw = response.read(12 * 1024 * 1024 + 1)
        if len(raw) > 12 * 1024 * 1024:
            raise WatchdogError("Pilot response exceeds its size limit.")
        return json.loads(raw)
    except (OSError, ValueError) as error:
        # Do not copy response bodies or URLs with credentials into hook output.
        raise WatchdogError("Pilot request failed or returned invalid JSON.") from error


def new_state(base_url, scope):
    return {"version": 1, "pilot_url": base_url.rstrip("/"), "scope": scope,
            "handled_message_seq": 0, "identity": None, "pending": {}}


def load_state(path, default=None):
    if not path.exists():
        if default is not None:
            return default
        raise WatchdogError("Watchdog state file does not exist.")
    state = read_json(path)
    if (not isinstance(state, dict) or state.get("version") != 1 or
            type(state.get("handled_message_seq")) is not int or state["handled_message_seq"] < 0 or
            not isinstance(state.get("pending"), dict) or not isinstance(state.get("pilot_url"), str) or
            not isinstance(state.get("scope"), str) or
            (state.get("identity") is not None and not isinstance(state["identity"], dict))):
        raise WatchdogError("Watchdog state is invalid; restore it rather than resetting the inbox cursor.")
    for pending in state["pending"].values():
        if (not isinstance(pending, dict) or not isinstance(pending.get("lease"), str) or
                not isinstance(pending.get("signature"), str) or type(pending.get("leased_at_ms")) is not int):
            raise WatchdogError("Watchdog pending state is invalid; restore it before continuing.")
    messages = state["pending"].get("messages")
    if messages is not None and (type(messages.get("since")) is not int or type(messages.get("latest")) is not int or
                                 not 0 <= messages["since"] <= messages["latest"]):
        raise WatchdogError("Pending inbox batch is invalid; restore it before continuing.")
    identity = state["pending"].get("identity")
    if identity is not None:
        if identity.get("mode") == "worker":
            valid = "profile_file" not in identity and "source_fingerprint" not in identity
        else:
            valid = (isinstance(identity.get("profile_file"), str) and
                     isinstance(identity.get("source_fingerprint"), str))
        if not valid:
            raise WatchdogError("Pending identity synchronization is invalid; inspect its state before continuing.")
    return state


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".code-space-", delete=False) as handle:
            temporary = handle.name
            json.dump(state, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def state_lock(path, dry_run=False):
    if dry_run:
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def add_issue(state, issues, key, signature, now_ms, retry_ms, issue, pending=None):
    previous = state["pending"].get(key)
    if (previous and previous.get("signature") == signature and
            0 <= now_ms - previous.get("leased_at_ms", 0) < retry_ms):
        return
    lease = uuid.uuid4().hex
    state["pending"][key] = {"signature": signature, "lease": lease, "leased_at_ms": now_ms, **(pending or {})}
    issues.append({**issue, "lease": lease})


def inspect_state(path, base_url, profile_file, scope, *, dry_run=False, now_ms=None, retry_ms=RETRY_MS,
                  worker_identity=False):
    if worker_identity and profile_file:
        raise WatchdogError("--worker-identity cannot be combined with --profile-file.")
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    base_url = base_url.rstrip("/")
    issues = []
    metadata = {"state_file": str(path), "scope": scope}
    with state_lock(path, dry_run):
        state = load_state(path, new_state(base_url, scope))
        if state["pilot_url"] != base_url or state.get("scope") != scope:
            raise WatchdogError("State belongs to another pilot/artifact; configure a separate state file.")
        try:
            if profile_file:
                source = profile_fields(profile_file)
                source_hash = fingerprint(source)
            current = identity_fields(pilot_get(base_url, "/assistant"))
            target_hash = fingerprint(current)
            state["pending"].pop("identity_check", None)
            acknowledged = state.get("identity") or {}
            if profile_file:
                reason = ("not_synchronized" if not acknowledged else
                          "profile_changed" if acknowledged.get("source_fingerprint") != source_hash else
                          "saved_identity_changed" if acknowledged.get("target_fingerprint") != target_hash else None)
            else:
                reason = ("worker_source" if worker_identity or
                          acknowledged.get("target_fingerprint") != target_hash else None)
            if reason:
                if profile_file:
                    # A worker changes the saved identity before acknowledging it.
                    # Keep its lease while that upload is in progress.
                    add_issue(state, issues, "identity", fingerprint([source_hash, profile_file]), now_ms, retry_ms,
                              {"type": "assistant_identity_needs_sync", "reason": reason, "profile_file": profile_file, **metadata},
                              {"profile_file": str(profile_file), "source_fingerprint": source_hash})
                else:
                    # The worker alone can detect changes to its live identity.
                    # Its explicit claim bypasses throttling under the state lock.
                    add_issue(state, issues, "identity", fingerprint(["worker", target_hash]), now_ms,
                              0 if worker_identity else retry_ms,
                              {"type": "assistant_identity_needs_sync", "reason": reason, **metadata},
                              {"mode": "worker"})
            else:
                state["pending"].pop("identity", None)
        except WatchdogError as error:
            reason = str(error)
            profile_metadata = {"profile_file": profile_file} if profile_file else {}
            add_issue(state, issues, "identity_check", fingerprint(["error", profile_file, reason]), now_ms, retry_ms,
                      {"type": "assistant_identity_needs_sync", "reason": reason, **profile_metadata, **metadata},
                      {"profile_file": str(profile_file)} if profile_file else None)

        try:
            cursor = state["handled_message_seq"]
            inbox = pilot_get(base_url, f"/messages/muse?since={cursor}")
            if (not isinstance(inbox, dict) or type(inbox.get("latest")) is not int or
                    inbox["latest"] < cursor or not isinstance(inbox.get("messages"), list)):
                raise WatchdogError("Invalid inbox response or inbox sequence behind the handled cursor.")
            sequences = [message.get("seq") for message in inbox["messages"] if isinstance(message, dict)]
            if (len(sequences) != len(inbox["messages"]) or
                    any(type(seq) is not int or not cursor < seq <= inbox["latest"] for seq in sequences) or
                    sequences != sorted(set(sequences))):
                raise WatchdogError("Invalid inbox message sequences.")
            state["pending"].pop("messages_check", None)
            if sequences:
                add_issue(state, issues, "messages", f"messages:{cursor}", now_ms, retry_ms,
                          {"type": "muse_messages_pending", "since": cursor, "latest": inbox["latest"],
                           "count": len(sequences), **metadata},
                          {"since": cursor, "latest": inbox["latest"]})
            # A read-only empty check does not acknowledge or advance anything.
        except WatchdogError as error:
            add_issue(state, issues, "messages_check", str(error), now_ms, retry_ms,
                      {"type": "muse_messages_check_failed", "reason": str(error), **metadata})
        if not dry_run:
            save_state(path, state)
    return issues


def acknowledge_identity(path, lease, expected_file):
    with state_lock(path):
        state = load_state(path)
        pending = state["pending"].get("identity", {})
        if pending.get("lease") != lease:
            raise WatchdogError("Identity lease is stale; inspect again before acknowledging.")
        if pending.get("mode") == "worker":
            expected = identity_fields(read_json(expected_file))
            source = uploaded_source_fields(expected)
        else:
            source = profile_fields(pending.get("profile_file"))
            if fingerprint(source) != pending.get("source_fingerprint"):
                raise WatchdogError("Muse profile changed during synchronization; inspect again.")
            expected = identity_fields(read_json(expected_file))
            if expected["name"] != source["name"] or expected["color"] != source["color"]:
                raise WatchdogError("Uploaded identity does not match the Muse profile name/color.")
            if "user_name" in source and expected.get("user_name") != source["user_name"]:
                raise WatchdogError("Uploaded identity does not match the Muse profile user_name.")
            avatar = expected["avatar_data_url"]
            if (source["avatar_sha256"] is None) != (avatar is None):
                raise WatchdogError("The full profile avatar must be synchronized, including explicit removal.")
        current = identity_fields(pilot_get(state["pilot_url"], "/assistant"))
        # Compare user_name when included in the expected upload payload (or when
        # the pilot returned user_name and expected also specified user_name).
        comparable_current = dict(current)
        if "user_name" not in expected:
            comparable_current.pop("user_name", None)
        elif "user_name" not in comparable_current:
            comparable_current["user_name"] = None
        if comparable_current != expected:
            raise WatchdogError("Saved identity does not match the uploaded name/color/avatar/user_name; sync is incomplete.")
        state["identity"] = {"source_fingerprint": fingerprint(source), "target_fingerprint": fingerprint(current)}
        state["pending"].pop("identity", None)
        save_state(path, state)


def acknowledge_messages(path, lease, through, *, now_ms=None):
    with state_lock(path):
        state = load_state(path)
        if through < state["handled_message_seq"]:
            raise WatchdogError("The handled inbox cursor cannot move backwards.")
        if through == state["handled_message_seq"]:
            return  # An acknowledgement whose response was lost is safe to retry.
        pending = state["pending"].get("messages", {})
        if pending.get("lease") != lease or through > pending.get("latest", -1):
            raise WatchdogError("Message lease is stale or acknowledgement exceeds the observed batch.")
        state["handled_message_seq"] = through
        if through == pending["latest"]:
            state["pending"].pop("messages", None)
        else:
            pending.update(signature=f"messages:{through}", since=through,
                           leased_at_ms=now_ms if now_ms is not None else int(time.time() * 1000))
        save_state(path, state)


def initialize_state(path, base_url, scope, handled_through):
    """Import an existing worker's acknowledged cursor without overwriting state."""
    if handled_through < 0:
        raise WatchdogError("The imported cursor must be nonnegative.")
    with state_lock(path):
        if path.exists():
            raise WatchdogError("State already exists; initialization cannot reset or overwrite its cursor.")
        inbox = pilot_get(base_url, f"/messages/muse?since={handled_through}")
        if not isinstance(inbox, dict) or type(inbox.get("latest")) is not int or inbox["latest"] < handled_through:
            raise WatchdogError("The imported cursor is ahead of this pilot's inbox; verify the source before continuing.")
        state = new_state(base_url, scope)
        state["handled_message_seq"] = handled_through
        save_state(path, state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--pilot-url", default="http://127.0.0.1:18791")
    identity_source = inspect.add_mutually_exclusive_group()
    identity_source.add_argument("--profile-file")
    identity_source.add_argument("--worker-identity", action="store_true")
    inspect.add_argument("--scope", default="code-space")
    inspect.add_argument("--state-dir", default=str(Path.home() / "hooks/state/code-space-watchdog"))
    inspect.add_argument("--state-file")
    inspect.add_argument("--dry-run", action="store_true")
    initialize = commands.add_parser("init")
    initialize.add_argument("--pilot-url", default="http://127.0.0.1:18791")
    initialize.add_argument("--scope", default="code-space")
    initialize.add_argument("--state-dir", default=str(Path.home() / "hooks/state/code-space-watchdog"))
    initialize.add_argument("--state-file")
    initialize.add_argument("--handled-through", required=True, type=int)
    for name in ["ack-identity", "ack-messages"]:
        command = commands.add_parser(name)
        command.add_argument("--state-file", required=True)
        command.add_argument("--lease", required=True)
        if name == "ack-identity":
            command.add_argument("--identity-file", required=True)
        else:
            command.add_argument("--through", required=True, type=int)
    args = parser.parse_args()
    try:
        if args.command in {"inspect", "init"}:
            key = fingerprint([args.pilot_url.rstrip("/"), args.scope])[:24]
            path = Path(args.state_file or Path(args.state_dir) / f"{key}.json").expanduser().resolve()
        if args.command == "inspect":
            profile = str(Path(args.profile_file).expanduser().resolve()) if args.profile_file else None
            try:
                issues = inspect_state(path, args.pilot_url, profile, args.scope, dry_run=args.dry_run,
                                       worker_identity=args.worker_identity)
            except WatchdogError as error:
                issues = [{"type": "code_space_watchdog_state_invalid", "reason": str(error), "state_file": str(path)}]
            print(json.dumps(issues))
        elif args.command == "init":
            initialize_state(path, args.pilot_url, args.scope, args.handled_through)
            print(json.dumps({"ok": True, "state_file": str(path)}))
        else:
            path = Path(args.state_file).expanduser().resolve()
            if args.command == "ack-identity":
                acknowledge_identity(path, args.lease, args.identity_file)
            else:
                acknowledge_messages(path, args.lease, args.through)
            print(json.dumps({"ok": True}))
    except (WatchdogError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

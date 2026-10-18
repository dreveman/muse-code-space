# Pilot (backend) — source of truth: `pilot/` in this repo

The pilot is the Node service that owns one long-lived `muse serve` process
and exposes it to the app worker over localhost HTTP (`127.0.0.1:18791`).
The credential relay lets the CLI reach api.meta.ai through this VM's egress
proxy (`127.0.0.1:18790`). Everything needed to install them lives here;
the runtime dir only holds state, logs, and `node_modules`.

| Repo file | Deploys to | Purpose |
|---|---|---|
| `pilot/pilot.mjs` | `<runtime>/pilot.mjs` | pilot daemon (`@muse-code/sdk` ↔ a Muse CLI that grants `sessionMcp`) |
| `pilot/package.json`, `package-lock.json` | `<runtime>/` | pinned deps (`npm ci` at install) |
| `pilot/terminals.mjs`, `pilot/pty_bridge.py` | `<runtime>/` | UI terminals: shells on a PTY in session workspaces (stdlib Python, no native deps) |
| `pilot/files.mjs` | `<runtime>/` | Bounded read-only file tabs under a session workspace |
| `pilot/muse_relay.py` | `<runtime>/muse_relay.py` | credential relay (vendored, see below) |
| `pilot/github_broker.py` | `<runtime>/github_broker.py` | GitHub credential broker (see GitHub broker below) |
| `pilot/repoSetup.mjs` | `<runtime>/repoSetup.mjs` | Repo picker: list broker-visible repos, clone a pick into a new workspace |
| `pilot/watchdog.sh` | `<runtime>/watchdog.sh` | cron watchdog, single-supervisor rule |
| `pilot/systemd/muse-code-space-pilot.service` | `/etc/systemd/system/` | project pilot unit (`@PILOT_DIR@` etc.) |
| `pilot/systemd/muse-code-space-relay.service` | `/etc/systemd/system/` | project relay unit (configurable port) |
| `pilot/systemd/muse-code-space-github-broker.service` | `/etc/systemd/system/` | GitHub broker unit (configurable port) |
| `pilot/install.sh` | — | agent-run installer |
| `pilot/recovery.test.mjs` | `<runtime>/` | `node --test` regression suite |

## Install (for an agent on a Muse VM)

```
pilot/install.sh [--runtime DIR] [--no-enable] [--no-cron]
```

Checks prerequisites (node, python3, the selected Muse binary,
auth), then copies code into
`~/workspace/muse-code-space-pilot` without touching `state/` or logs.
It renders and enables both units, installs the 2-minute watchdog cron, and
verifies both ports. Re-runnable. Needs root
for the unit step (or pass `--no-enable` and supervise via cron).

Both units load the install-time proxy capture (`proxy.env`, mode 600) so the
relay *and* `muse serve` sessions inherit the VM's egress proxy — without it,
`git`/`curl` in agent shells and UI terminals fail with TLS errors. The pilot
also fills any missing proxy vars at startup from that file (then
`/etc/environment`), so watchdog/direct starts work too; explicit environment
always wins and proxy-less hosts are unaffected.

New sessions with no explicit workspace use `~/workspace/code/<short-token>`.
`MUSE_CODE_SPACE_WORKSPACES` overrides the parent. Existing sessions stay in
their saved `workspaceRoot`; the installer does not move workspaces.

Prerequisites the installer will NOT create (human/owner steps):
- A Muse CLI that grants **`sessionMcp`** during MSP initialize and accepts
  required per-session MCP servers. If `MUSE_CODE_SPACE_MUSE_BIN` is unset,
  the installer downloads the launcher from `https://api.meta.ai/muse-launcher.sh`,
  runs it once to fetch the latest CLI, and pins a copy at
  `~/.local/bin/muse-pilot` (a name the launcher won't auto-update or prune).
  Set `MUSE_CODE_SPACE_MUSE_BIN` to use a different verified binary instead.
  The installer writes this path into the systemd unit
  (previously it checked one binary but ran another).
  The pilot fails to boot with an actionable error if the grant is missing;
  no agent can run without its built-in `mcp__code_space__send_message` tool.
  The installer checks the installed SDK version against `pilot/package.json`
  and waits for `/health` to report ready after session reconciliation (which
  needs the pilot's HTTP MCP endpoint listening).
  Run with `--disable-sandbox` (bwrap can't mount /proc in this container).
- `~/.config/muse-code-space-pilot/muse/auth.json` — CLI credentials.

## Restart recovery

- The transcript file is the session. On boot, `resumeAll()` retries each
  registry id (aliased live id first, then original); on failure it calls
  `recoverSession()`: same workspace/model, new backend session, compact
  context from `state/events-<id>.jsonl` held as a seed and **prepended to
  the next user turn** (never auto-run on boot), plus a resume notice in the
  transcript. IDs stay stable from the app's perspective via
  `state/aliases.json`; the registry is keyed by stable id.
- `POST /sessions/:id/recover` covers turns submitted mid-restart; the app
  surfaces failed turns and retries `unknown session` turn errors.
- `POST /sessions/:id/tools/output` proxies bounded, read-only
  `item/readOutput` pages for a tool's stored output or structured patch.
  The app action first verifies that the event and DB-stored ref belong to
  the session. Full raw output is fetched only after **Show all**; patches
  load when an expanded edit row enters the visible transcript.
- `POST /sessions/:id/files/read` serves the **current** on-disk file for a
  read-only side-panel tab. The session's saved pilot workspace is the only
  root; only relative regular files are accepted, symlink components are
  refused, and UTF-8 output is capped at 256 KiB / 10,000 lines. The app
  action checks the owner and resolves the pilot session ID first. This is
  deliberately separate from historical tool output and never writes files.
- **Relay diagnostics in the UI:** the hamburger menu's Debug section can
  show a bounded relay log via `getRelayDebug` → pilot `/debug/relay` → the
  relay's loopback `/__code_space/diagnostics`. It records method, safe path
  category (never a URL query), HTTP status, elapsed time, byte counts and
  failure stage/type. No bodies, credential values, raw headers or exception
  messages are stored. The owner-only app action hides this from other
  viewers. The in-memory history holds the last 100 outcomes and resets on
  relay restart; the UI shows when collection started. Relay
  `/__code_space/health` is local liveness; it does not prove
  that auth, proxy egress or the model API succeeds. Use a real disposable
  turn to validate the full chain.
- **First turns queued during an outage:** the app DB keeps the first prompt
  and tries `recoverPendingAgents` while the UI is open (or when reopened).
  A DB retry lease expires if the worker dies. The pilot persists the app's
  stable `workspaceName` and the accepted first `turnId`; repeated
  `POST /sessions` requests reuse the same session/turn instead of creating
  duplicates when a response is lost. An explicit rejection fails visibly,
  with a Retry start button. See `docs/LOCAL_DEVELOPMENT.md` restart tests
  8–9.

## Repo picker (clone before the first turn)

The composer's repo row (above a new companion's first prompt) offers the
repos the broker credential can see via `GET /repos` (user/PAT repos from
`/user/repos`, GitHub App installs from `/installation/repositories`), plus
a pasted `owner/repo` or github.com URL. The pick rides `POST /sessions` as
`repo`; the pilot clones it into the companion's fresh workspace
(`pilot/repoSetup.mjs`) before starting the session, through the broker
gitconfig when GitHub is provisioned and plain https otherwise. No pick
keeps the blank generated workspace. A retry that finds the same repo
already cloned reuses it; any other content in the workspace is refused.
The app stores the slug on the session (`sessions.repo_slug`, migration
0025) so queued first-prompt retries clone the same repo.

## Supervision rules (learned from the 2026-09-30 incident)

- Exactly one supervisor per port: with the unit installed, manage ONLY via
  systemctl — the watchdog never direct-starts a unit-managed service.
- The relay is a first-class service now (own unit, `After`/`Wants` from the
  pilot unit, covered by the watchdog health check).
- `muse serve` gets the configured relay URL from
  `~/.config/muse-code-space-pilot/muse/settings.json`. The installer creates
  it only when absent and never overwrites existing settings.
- Off the VM (e.g. a Mac on AI Gateway) there is no relay: run the pilot
  with `MUSE_CODE_SPACE_RELAY_URL=none` to disable startup, turn and health
  relay checks (`"relay": "disabled"`).

## GitHub broker

`pilot/github_broker.py` (stdlib-only, port `MUSE_CODE_SPACE_GITHUB_BROKER_PORT`,
default 443 on loopback) gives spawned sessions GitHub access without any real
credential in the session, mirroring the relay pattern. Sessions reach it two
ways, both wired only into spawned-session environments by the pilot
(`GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`, `GIT_TERMINAL_PROMPT=0`, `SSL_CERT_FILE`
in `museServeEnv` / terminal extras, only when install generated the files):

- **git:** the generated `$RUNTIME/gitconfig` rewrites `https://github.com/`
  to the broker (with broker-scoped `sslCAInfo` and a sentinel credential
  helper). The host's `~/.gitconfig` is never touched.
- **`gh`:** the generated `$RUNTIME/gh-config` sets `api_host` to the broker
  with a sentinel token. `gh` forces https for `api_host`, so the broker
  serves TLS with the install-generated loopback cert; sessions trust it via
  the generated CA bundle (system roots + broker cert). The broker listens
  on 443 by default because some `gh` commands (`gh pr create`) reject an
  `api_host` containing a port; an unprivileged `MUSE_CODE_SPACE_GITHUB_BROKER_PORT`
  override still works for git and `gh api`, with that one caveat.

The broker strips incoming `Authorization` and attaches its own credential
per request (Basic `x-access-token:` for git paths, Bearer for API paths),
forwards only to `github.com` / `api.github.com`, streams bodies in chunks,
and keeps relay-style bounded diagnostics. Credential backing is selected
by the host-local `~/.config/muse-code-space-pilot/github-broker.json`
(chmod 600): on this platform, a `dynamic_credentials` surrogate from the
custom Secure Vault entry `custom.github-broker` (Secure Vault has no
read-back, so the config holds only the entry name, never a secret;
surrogates attach as Bearer on every surface, since the egress exchange
only rewrites Bearer placements; note GitHub rejects Bearer for git
transport, so surrogate mode covers `gh`/API only and the broker refuses
git paths in that mode with an explicit message). GitHub App (RS256 JWT via the `openssl`
CLI, in-memory installation-token cache) and fine-grained PAT file modes
remain for hosts where an operator can write that file securely out of
band. Pilot `/health`
reports `github_broker` beside `relay` (informational; never flips `ok`),
and the watchdog recovers the broker unit like the other two. With the
broker down, git/gh fail fast against loopback — the sentinel is never sent
to real GitHub. Verify with `python3 -m unittest pilot/test_github_broker.py`.

## Vendored file

`muse_relay.py` is maintained here in the repo; its local port option and
bounded, redacted UI diagnostics are the source of truth. Verify with
`python3 -m unittest pilot/test_muse_relay.py` and
`python3 -m py_compile pilot/muse_relay.py` before installing.

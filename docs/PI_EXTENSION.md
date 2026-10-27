# Using Muse Code Space as a Pi Extension

The extension in `extensions/muse-code-space/` lets any regular `pi` coding-agent
session act as the live **Muse Assistant** for a host while serving the
**Muse Code Space** web interface directly from that host.

## Installation

Install directly from GitHub using Pi's package manager:

```bash
pi install git:github.com/dreveman/muse-code-space
```

Or install from a local checkout:

```bash
pi install .
```

Or load for a single session without adding to settings:

```bash
pi -e .
```

## What It Does

1. **Starts the Pilot & Web UI on demand (`/code-space start`):**
   - Stays idle on `session_start` by default so the extension can remain
     installed globally without spawning background processes until you want it.
   - Running `/code-space start` installs `pilot/` dependencies if needed,
     starts `pilot/pilot.mjs` (`MUSE_CODE_SPACE_RELAY_URL=none`, using the
     host's native `muse serve` binary) and the standalone web server, and
     prints the full URL (`http(s)://<hostname>:<port>/?token=<token>`).
   - Visiting that URL sets an `HttpOnly` cookie so your desktop or phone
     browser stays authenticated across reloads.
2. **Acts as the Muse Assistant (`@Jolly`):**
   - Registers your user name (`user_name`) and assistant name via
     `setAssistantIdentity`.
   - Polls `/assistant/inbox` (`readMuseMessages`) and delivers messages from
     companions (`mcp__code_space__send_message`) or `@` mentions in the Web UI
     into your active `pi` session as new turns.
   - Automatically generates concise task summaries for newly started companion
     conversations.
3. **Registers `muse_code_space_*` Tools in Pi:**
   - `muse_code_space_status`
   - `muse_code_space_list_tasks`
   - `muse_code_space_read_task`
   - `muse_code_space_send_message`
   - `muse_code_space_start_task`
   - `muse_code_space_update_task`
   - `muse_code_space_set_identity`

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `MUSE_CODE_SPACE_PORT` | `4173` | Port for the web interface |
| `MUSE_CODE_SPACE_HOST` | `::` | Bind address for the web server |
| `MUSE_CODE_SPACE_PUBLIC_HOST` | `os.hostname()` | Hostname used in printed Web UI URLs |
| `MUSE_CODE_SPACE_TLS_PEM` | *(unset)* | Optional combined cert+key PEM path for HTTPS |
| `MUSE_CODE_SPACE_TLS_CERT` / `MUSE_CODE_SPACE_TLS_KEY` | *(unset)* | Optional separate TLS certificate and key paths |
| `MUSE_CODE_SPACE_WEB_TOKEN` | *(auto-generated)* | Secret token required to access the Web UI |
| `MUSE_CODE_SPACE_ASSISTANT_NAME` | `Jolly` | Assistant name shown in `@` mentions |
| `MUSE_CODE_SPACE_ASSISTANT_COLOR` | `#d0e4fc` | Assistant `#rrggbb` theme color |
| `MUSE_CODE_SPACE_ASSISTANT_AVATAR` | *(unset)* | Path to `.png`/`.jpg`/`.webp` avatar image |
| `MUSE_CODE_SPACE_ASSISTANT_PROFILE` | *(unset)* | Optional JSON file with `{name, color, avatar_path, user_name}` |
| `MUSE_CODE_SPACE_USER_NAME` | `$USER` | User name shown in the Welcome Card greeting |
| `MUSE_CODE_SPACE_AUTO_START` | `false` | Set `true` to auto-start pilot/web on `session_start` |

## Passing Environment Variables to the Pilot & `muse serve`

Any environment variable passed to the pilot is inherited by `muse serve` (for
example, `MUSE_BASE_URL`). You can supply environment variables in three ways:

1. **Inline via `/code-space start` or `/code-space env` (persisted across sessions):**
   ```text
   /code-space start MUSE_BASE_URL=https://...
   ```
   or:
   ```text
   /code-space env MUSE_BASE_URL=https://...
   /code-space restart
   ```
   These are saved to `~/.local/share/muse-code-space/pilot.env` (use
   `/code-space env KEY=` to remove a key).
2. **Via `~/.config/muse-code-space/env` or `~/.local/share/muse-code-space/pilot.env`:**
   Add `KEY=VALUE` lines to either file; the extension loads both before
   spawning `pilot/pilot.mjs` and automatically syncs the pilot's `/models`
   catalog into the Web UI.
3. **Via the shell environment before starting `pi`:**
   `pilot/pilot.mjs` inherits `process.env` from the `pi` process.

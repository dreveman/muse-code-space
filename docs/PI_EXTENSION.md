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

1. **Starts the Pilot & Web UI automatically:**
   - Installs `pilot/` dependencies if needed and starts `pilot/pilot.mjs`
     (`MUSE_CODE_SPACE_RELAY_URL=none`, using the host's native `muse serve`
     binary) and the standalone web server if they are not already running.
   - Generates a persistent access token in
     `~/.local/share/muse-code-space/web-token` and prints the full URL
     (`http(s)://<hostname>:<port>/?token=<token>`) when the session starts or
     when you run `/code-space`.
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
| `MUSE_CODE_SPACE_USER_NAME` | `$USER` | User name shown in the Welcome Card greeting |
| `MUSE_CODE_SPACE_AUTO_START` | `true` | Set `false` to disable auto-spawning pilot/web |

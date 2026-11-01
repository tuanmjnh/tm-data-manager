---
title: Configuration and stored data
description: Data directory, environment variables, storage root and credential protection
section: operations
order: 7
updated: 2026-11-01
tags: configuration, env, secret, storage
---

# Configuration and stored data

Everything UDMT needs lives under a single data directory.

## Default location

| OS | Path |
|---|---|
| Windows | `%APPDATA%\udmt` |
| macOS | `~/Library/Application Support/udmt` |
| Linux | `~/.local/share/udmt` |

Inside it:

```
udmt.db            metadata (SQLite): connections, runs, artifacts, schedules
artifacts/         export files, one folder per artifact id
logs/              core logs, plus desktop shell logs when applicable
tmp/               scratch files during a run
secrets.key        master key for encrypted credentials (0600)
```

## Environment variables

| Variable | Effect |
|---|---|
| `UDMT_DATA_DIR` | Change the data directory (portable builds, multiple environments) |
| `UDMT_UI_DIR` | Point the local server at a specific static GUI build |
| `UDMT_ACCESS_LOG=1` | Log every HTTP request to the core log |
| `UDMT_LOG_DIR` | Change the log directory |
| `UDMT_WEBVIEW_DATA_DIR` | WebView2 profile used by the desktop app |

The CLI also accepts `--data-dir <path>`. All CLI defaults are listed in `udmt --help`.

## Secrets

Credentials are encrypted with AES-256-GCM using the master key in `secrets.key`. That key is **not**
backed by an OS keyring yet — protect the file with your OS account permissions, and back it up if you
want to move machines.

- No password is ever stored in plaintext in the database, logs or API.
- Logs are redacted for URIs, passwords and tokens before they are written.
- To rotate a password: `udmt connection update <name> --password-stdin`.

## Storage backend

Exports are written to the storage root inside the data directory by default. The current backend and
path are shown on the **System** page. Writing outside the root still works but is recorded as
`external` with a warning.

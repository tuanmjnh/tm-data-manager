---
title: Troubleshooting
description: Common errors and quick fixes
section: operations
order: 8
updated: 2026-11-01
tags: errors, troubleshooting, port, sqlite
---

# Troubleshooting

## `unable to open database file` / `SQLite database file not found`

The connection's path no longer resolves (the file was moved or deleted). Paths are resolved **once**,
when the connection is saved, so `./data/x.db` is relative to the working directory at that moment.

```bash
udmt connection show local          # inspect the stored config.path
udmt connection update local --path ./data/fixtures/source.db
udmt connection test local
```

## `EADDRINUSE: address already in use 127.0.0.1:4004`

The GUI is already running. `udmt gui` reports the URL of the running instance and the data directory it
uses; reuse that window, or open a second instance with `--port 4005`.

## "The CLI shows different connections than the GUI"

Metadata lives in exactly one data directory. Two processes with different `--data-dir` values are two
independent installations. `udmt gui` prints `Data:` so you can compare.

## An artifact fails its checksum

```bash
udmt artifact verify <artifact-id>
```

If verify fails, the file was modified or corrupted after export. Export again from the source rather
than importing that file.

## `CONFIRMATION_REQUIRED`

A destructive write (`truncate_and_load`) or any write to a `production` connection needs explicit
confirmation: `--confirm <connection-name>` in the CLI, or typing the connection name in the GUI dialog.

## `VALIDATION_FAILED` during import

Some rows do not match the target types. Check the per-column warnings in the run result, fix the source
data or correct the target column type.

## A run is stuck in `interrupted`

The worker was stopped abruptly, so that run never completed. Re-run the job or export again; the next
worker start cleans up orphaned state.

## Full health check

```bash
udmt doctor     # version, paths, database integrity, secret backend, worker
```

The **System** page shows the same information along with recent logs and each provider's capabilities.

## Desktop build says `cargo metadata ... program not found`

`cargo` is not on the `PATH` of the build process — common when the script is started from an IDE or a
task runner, because `~/.cargo/bin` is only added by the shell profile. `pnpm run desktop` now adds it
automatically. If the error persists, Rust is not installed: install it from [rustup.rs](https://rustup.rs)
and, on Windows, add the **Desktop development with C++** workload from the Visual Studio Build Tools.

## There is no installer, only the `udmt-desktop` binary

`pnpm run desktop` produces both. The raw executable is `src-tauri/target/release/udmt-desktop.exe`
(Windows) and the installer is written to `src-tauri/target/release/bundle/`. If only the binary exists,
the bundle step was skipped — run with `pnpm run desktop` (not `--skip-frontend` + a manual `cargo build`).

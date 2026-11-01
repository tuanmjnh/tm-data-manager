---
title: Getting started
description: Install, launch the GUI and run your first export
section: gettingStarted
order: 1
updated: 2026-11-01
tags: install, pnpm, quickstart
---

# Getting started

UDMT is a data tool that runs entirely on your machine: it exports, imports and schedules data between
SQLite, PostgreSQL, MySQL/MariaDB and MongoDB without `mongodump`/`pg_dump`.

## Requirements

- **Node.js ≥ 22.5** — the bundled `node:sqlite` module is used, so no native compilation.
- **pnpm ≥ 12** — the repository is a pnpm workspace (`.`, plus the `app` GUI package).
  `corepack enable` picks up the pinned `packageManager` version.
- Optional: a Rust toolchain if you want to build the desktop app yourself.

## Install and run

```bash
pnpm install
pnpm run dev          # serve the GUI at http://127.0.0.1:4004
```

`pnpm run dev` is the "open the web app" command: it runs `udmt gui`, which starts the loopback API and
serves the built SPA from the same origin, then prints the URL. It does **not** launch a browser tab for
you — open the `GUI:` URL it prints, and keep the terminal open (closing it or pressing `Ctrl+C` stops the
server). **It serves an existing build** — it does not recompile the TypeScript or the GUI, so after
editing source code use:

```bash
pnpm run gui          # build (core + CLI) → build:gui (static SPA) → serve on :4004
```

| Command | What it does | When to use it |
|---|---|---|
| `pnpm run dev` | `udmt gui` — serves the current build on `http://127.0.0.1:4004` | Everyday use, no source changes |
| `pnpm run gui` | Builds both halves, then serves on `:4004` | After changing `.ts` or `.vue` files |
| `pnpm run dev:gui` | Nuxt dev server with hot reload on `:4320`, `/api` proxied to `:4004` | UI work with live reload |
| `pnpm run desktop` | Full desktop release: builds both halves, the runtime payload and the installers | Producing an installer |

For hot reload, keep `pnpm run dev` (or `pnpm run udmt -- serve`) running in one terminal and start
`pnpm run dev:gui` in another: the Nuxt dev server on port 4320 proxies `/api` to 4004.

If the browser shows `GUI build not found`, the SPA has never been generated — run `pnpm run build:gui`
once (or just use `pnpm run gui`). `pnpm run dev` right after `git clone` fails the same way until a build
exists.

`pnpm run build` and `pnpm run build:gui` only write files; they never start a server. Use
`pnpm run desktop` when you want the installable app instead — see [Desktop app](/docs/desktop-app).

`pnpm run fixtures` creates `data/fixtures/source.db` with 2,500 demo rows.

## Your first export

1. Open **Connections → Add connection** and pick `SQLite`, pointing at a real `.db` file.
2. Press **Test** to verify, then **Discover** to list the tables.
3. Go to **Export**, choose the connection and table, format `jsonl`, enable gzip.
4. Press **Run** — the job runs in the background; follow it on **Operations**.
5. The result lands in **Artifacts** with its SHA-256 checksum.

> The GUI and CLI share one loopback API, so every action in the interface has a matching CLI command.

## Ports and data

- The GUI listens on `http://127.0.0.1:4004`; change it with `--port 4005`.
- Metadata, artifacts and logs live in `%APPDATA%\udmt` (Windows),
  `~/Library/Application Support/udmt` (macOS) or `~/.local/share/udmt` (Linux).
  Override with `UDMT_DATA_DIR` or `--data-dir`.

# UDMT — Universal Data Management Tool

Desktop-first data tool for **exporting, importing and scheduling data movement** across databases and files.
Built from the roadmap in [`docs/universal-data-management-roadmap-hybrid-v1.md`](docs/universal-data-management-roadmap-hybrid-v1.md).

The Core owns every piece of business logic. The CLI and the Nuxt GUI are thin facades over the same
`UdmtApp` use cases, so a run started in the UI is the same durable run the CLI can inspect or cancel.

```
┌────────────┐   ┌────────────┐   ┌──────────────┐
│  CLI       │   │  GUI       │   │  Worker      │
│  (commander)│  │ (Nuxt 4)   │   │ (scheduler)  │
└─────┬──────┘   └─────┬──────┘   └──────┬───────┘
      │                │                 │
      └──────────► UdmtApp facade ◄──────┘
                       │
      ┌────────────────┼──────────────────┐
      │                │                  │
 Operation engine  Provider registry  Artifact storage
      │                │                  │
 SQLite metadata   sqlite / pg /      managed local
 (durable runs)    mysql / mongodb    files + manifests
```

## Requirements

- **Node.js ≥ 22.5** (`node:sqlite` is bundled; no native compilation).
- **pnpm ≥ 12** — this is a pnpm workspace (`.`, plus the `app` GUI package). `corepack enable` will
  pick up the pinned `packageManager` version; no `npm install` step exists.
- No `mongodump`/`pg_dump` needed — providers talk to the databases directly.

## Install & build

```bash
pnpm install
pnpm run build          # compiles the Core + CLI to dist/
pnpm run build:gui      # static Nuxt build (app/.output/public)
pnpm run fixtures       # (optional) creates data/fixtures/source.db with 2,500 demo rows
```

## Quick start (CLI)

```bash
# 0. Demo data (optional) — creates data/fixtures/source.db
pnpm run fixtures

# 1. Add connections (secrets go to the local encrypted vault)
udmt connection add --name local-src --provider sqlite --path ./data/fixtures/source.db
udmt connection add --name staging-pg --provider postgresql \
  --host db.example.com --database app --user app --password-stdin

# 2. Inspect what a provider supports and what the resource looks like
udmt provider list
udmt connection test local-src
udmt connection discover local-src
udmt connection schema local-src users

# 3. Export (streaming, checksummed artifact + manifest)
udmt export --conn local-src --resource users --format jsonl --compression gzip

# 4. Import into another connection
udmt import --conn staging-pg --resource public.users --artifact <artifact-id> --mode upsert --key-columns id

# 5. Inspect and verify
udmt operation list
udmt operation logs <run-id>
udmt artifact verify <artifact-id>
```

Run `udmt --help` for the full command set. `--json` on every command returns machine-readable output;
progress and logs go to stderr and exit codes are stable (`0` ok, `2` invalid input, `3` connection,
`4` operation, `5` cancelled).

## GUI

`pnpm run build` and `pnpm run build:gui` only write files — nothing runs until `udmt gui` starts.

```bash
pnpm run build          # Core → dist/
pnpm run build:gui      # static SPA → app/.output/public
pnpm run dev            # = udmt gui: serves API + GUI on http://127.0.0.1:4004
pnpm run gui            # build both halves, then serve on :4004
```

`pnpm run dev` does not open a browser tab itself; open the `GUI:` URL it prints and leave the terminal
running. For GUI development (`pnpm run dev:gui`, port 4320) start `pnpm run dev` (or `udmt serve`) first;
`/api` is proxied to `127.0.0.1:4004`. Pages: Overview, Connections, Export, Import, Operations, Artifacts, Schedules, System.

## Documentation centre

The GUI ships a user guide at `/docs` (sidebar → **Documentation**): articles grouped by section, full-text
search across title/description/tags/body, prev/next navigation, and deep links (`/docs/<slug>`).

Articles are plain markdown with frontmatter in [`app/docs/`](app/docs):

```markdown
---
title: Xuất dữ liệu
description: Định dạng file, nén, giới hạn dòng
section: data        # key trong docsPage.sections.* của file i18n
order: 3
updated: 2026-11-01
tags: export, csv
---
```

Drop the same file into `app/docs/en/` and `app/docs/vi/` and it appears automatically — no route, menu or
code change. `section` is an i18n key (add a label under `docsPage.sections.*` in both locale files), and
`order` decides both the article sequence and the sidebar order. Rendering is `marked` at build time, so the
page works offline.

## Desktop app (Tauri v2)

**Script cần dùng: `pnpm run desktop`.** Nó chạy đủ chuỗi `tsc` → `nuxt generate` → đóng gói payload
runtime → `tauri build`, rồi in ra đường dẫn installer vừa tạo. Không cần gọi `tauri` trực tiếp.

```bash
pnpm install         # một lần, sau khi clone
pnpm run desktop     # build bản release cho OS đang chạy
```

### Yêu cầu trước khi build

| Thành phần | Ghi chú |
|---|---|
| Node ≥ 22.5 + pnpm | `package.json` khai báo `engines.node >= 22.5`, `packageManager: pnpm@12.15.0` |
| Rust (stable) + `cargo` | cài bằng [rustup](https://rustup.rs); trên Windows cần thêm MSVC Build Tools |
| Windows | WebView2 Runtime (có sẵn trên Windows 11) |
| Linux | `libwebkit2gtk-4.1-dev build-essential libayatana-appindicator3-dev librsvg2-dev libssl-dev` |
| macOS | Xcode Command Line Tools (`xcode-select --install`) |

### Các script build

| Lệnh | Việc nó làm |
|---|---|
| `pnpm run desktop` | **Bản phát hành đầy đủ** — core + GUI + payload + installer |
| `pnpm run desktop -- --skip-frontend` | Chỉ build Rust + payload; dùng khi frontend/core không đổi |
| `pnpm run desktop -- --bundles=deb` | Giới hạn định dạng đóng gói (Linux: `deb`, `rpm`, `appimage`) |
| `pnpm run desktop:prepare` | Chỉ `build` + `build:gui` + payload, **không** chạy Rust (kiểm tra nhanh) |
| `pnpm run build:runtime` | Chỉ tạo payload `src-tauri/runtime/`; cần `build` + `build:gui` chạy trước |
| `pnpm run dev` | `udmt gui` — phục vụ bản build có sẵn ở `http://127.0.0.1:4004` (không build lại, không tự mở browser) |
| `pnpm run gui` | Build core + GUI rồi phục vụ ở `:4004` (dùng sau khi sửa code) |
| `pnpm run dev:gui` | Nuxt dev server có hot reload cho `app/` (cần `pnpm run dev` chạy song song) |

Build phải chạy trên **chính OS đích** — runtime Node được copy từ máy build nên `--target` khác host
sẽ bị từ chối (`prepare-desktop: cannot build for ... on ...`). Muốn có cả ba nền tảng thì dùng một CI
runner cho mỗi OS. Bundle target lấy từ `src-tauri/tauri.<platform>.conf.json`.

`pnpm run desktop` tự tìm `cargo` trong `~/.cargo/bin` (hoặc `$CARGO_HOME/bin`) và thêm vào `PATH`
cho tiến trình Tauri. Nhờ vậy build vẫn chạy khi script được gọi từ IDE / task runner — nơi profile
shell chưa được source. Nếu Rust thật sự chưa cài, script dừng ngay từ đầu kèm hướng dẫn thay vì đợi
build xong frontend rồi mới lỗi.

### Sản phẩm đầu ra

Tất cả nằm trong `src-tauri/target/release/`:

| OS | File cài đặt |
|---|---|
| Windows | `bundle/nsis/UDMT_0.1.0_x64-setup.exe` (kèm `udmt-desktop.exe` chạy trực tiếp, cần thư mục `runtime/` bên cạnh) |
| Linux | `bundle/deb/*.deb`, `bundle/appimage/*.AppImage` (kèm binary `udmt-desktop`) |
| macOS | `bundle/dmg/*.dmg` và `bundle/macos/UDMT.app` |

Installer tự chứa mọi thứ: `runtime/node` (~50 MB), `runtime/udmt-core.cjs` (core + CLI + API) và
`runtime/ui/` (bản Nuxt tĩnh). Máy đích không cần Node, pnpm hay mạng.

The shell bundles Node, the core (one esbuild file) and the static GUI under `runtime/`, then starts
the core on the first free port in `4004..4019` and opens the window on it. No IPC: the UI talks to the
same loopback HTTP facade as the browser GUI and the CLI. Details, payload layout and limitations:
[`docs/desktop/packaging.md`](docs/desktop/packaging.md).

## Worker (scheduled runs, headless)

```bash
udmt job add-export --name nightly-users --conn local-src --resource users \
  --format jsonl --compression gzip --schedule daily --hour 2 --timezone Asia/Ho_Chi_Minh
udmt worker run        # foreground; keeps running after the GUI is closed
udmt worker status
udmt worker once       # one scheduler pass (useful for cron/Windows Task Scheduler)
```

Schedules support `once`, `interval`, `daily`, `weekly`, `monthly` with IANA timezones, misfire policy
(`skip` | `run_once_on_recovery`) and overlap policy (`forbid` by default). A local worker lock and
per-schedule DB locks prevent double execution; runs left behind by a dead worker are marked
`interrupted` on the next start.

## Providers

| Provider | Read | Write | Schema | Bulk | Notes |
|---|---|---|---|---|---|
| `sqlite` | ✓ | ✓ | ✓ | ✓ | File based, `node:sqlite` |
| `postgresql` | ✓ | ✓ | ✓ | ✓ | Streaming via `pg-cursor`; profiles: supabase, neon |
| `mysql` | ✓ | ✓ | ✓ | ✓ | MySQL and MariaDB; profiles: planetscale |
| `mongodb` | ✓ | ✓ | sampled | ✓ | Atlas/self-hosted; schema inferred from documents |

Capabilities are declared by the provider and enforced by the engine — the UI never shows an action a
provider cannot actually perform (`CAPABILITY_UNSUPPORTED` otherwise).

## Data formats

`jsonl`, `json` (streamed array), `csv`, each with optional `gzip`. Exports write
`<file>.manifest.json` next to the data with columns, row count, checksum, provider and warnings, so an
artifact can be re-imported elsewhere without the catalog.

## Safety & security

- Credentials are AES-256-GCM encrypted in the metadata DB; the master key is a `0600` file in the app
  data dir. An OS keyring backend is planned — see [`docs/security/secret-management.md`](docs/security/secret-management.md).
- Full connection URLs with passwords are accepted and the password is moved to the vault.
- Destructive imports (`truncate_and_load`) and any non-append write to a `production` connection
  require typing the connection name (`--confirm <name>`).
- CSV/JSON imports validate types and report per-column warnings instead of writing silently wrong data.
- Artifacts get a SHA-256 checksum at write time and again before the run is marked completed.
  `udmt artifact verify` re-hashes the file and flags corruption.
- Paths are validated against the managed roots; exports to an explicit external directory are recorded
  as `output_mode: external` and logged as a warning.
- Logs and error messages are redacted for URIs, passwords, tokens and bearer headers.

## Troubleshooting

**`failed to run 'cargo metadata' ... program not found`**
`cargo` không nằm trên `PATH` của tiến trình build (thường gặp khi chạy từ IDE hoặc task runner, vì
`~/.cargo/bin` chỉ được thêm bởi profile shell). Bản mới của `pnpm run desktop` tự bổ sung đường dẫn
này. Nếu vẫn lỗi thì Rust chưa được cài: cài bằng [rustup](https://rustup.rs), trên Windows thêm
workload **Desktop development with C++** của Visual Studio Build Tools, rồi mở lại terminal.

**`export failed — unable to open database file` / `NOT_FOUND: SQLite database file not found`**
The path stored on the connection does not exist. It is resolved once, when the connection is saved
(so `./data/x.db` means the working directory at that moment). Check what is stored, then fix it:

```bash
udmt connection show local          # prints the resolved config.path
udmt connection update local --path ./data/fixtures/source.db
udmt connection test local
```

**`EADDRINUSE: address already in use 127.0.0.1:4004`**
The GUI is already running. Running `udmt gui` again now reports the existing URL and the data dir it
would have used; use that window, or pick another port with `--port 4005`.

**`os error 32` / “The process cannot access the file” during `pnpm run desktop`**
Tauri copies `runtime/` into `target/release/` on every build, so a desktop app started from there — or a
leftover `runtime\node.exe` from a force-killed window — blocks it. Close the app, end the orphaned
`node.exe` running `udmt-core.cjs`, then rebuild.

**"My CLI connection is not the one I see in the GUI"**
Metadata lives in one data dir: `%APPDATA%\udmt` on Windows, `~/Library/Application Support/udmt` on
macOS, `~/.local/share/udmt` elsewhere, or wherever `UDMT_DATA_DIR` / `--data-dir` points. Two processes
with different data dirs are two independent installations. `udmt gui` prints the dir it uses.

## Scripts

```bash
pnpm run check      # typecheck + unit/integration tests + build
pnpm run check:i18n # đối chiếu key i18n giữa app và en/vi, báo lệch ngay
pnpm test           # vitest (44 tests)
pnpm run fixtures   # (re)generate data/fixtures/source.db with 2,500 demo rows
pnpm run typecheck
pnpm run udmt -- --help
```

## Status & limitations

Implemented: Phase 0 (audit), Phase 1 (core, connections, providers, export/import, artifacts, CLI),
Phase 2 (worker + scheduler + task UI), Phase 3 (verification + retention + safe cleanup) and the GUI.

The desktop app (Tauri v2 + bundled Node core) is built and verified on Windows — see
[`docs/desktop/packaging.md`](docs/desktop/packaging.md).

Not implemented (documented in [`docs/IMPLEMENTATION-STATUS.md`](docs/IMPLEMENTATION-STATUS.md)):
external IPC plugin host, Data Sync engine (mapping/checkpoint), incremental/CDC, S3-compatible storage
backends, OS keyring, notifications, native dump formats (`mongodump`/`pg_dump`), code signing and
auto-update.

See [`docs/architecture/current-state.md`](docs/architecture/current-state.md) for the Phase 0 audit and
[`docs/decisions/`](docs/decisions/) for the architecture decisions, including the TypeScript-core deviation.

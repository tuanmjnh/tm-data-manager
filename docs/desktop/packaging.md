# Desktop packaging (Tauri v2)

Roadmap section 14 asks for a desktop shell around the GUI. This document describes how the
shipped app is assembled and what it contains.

## What the installer contains

```
udmt-desktop.exe             Tauri shell (Rust, ~4 MB)
runtime/
  node.exe                   Node 22 runtime (MIT licence), no system Node required
  udmt-core.cjs              Core + CLI + HTTP API bundled into one CommonJS file (~3.5 MB)
  ui/                        Static Nuxt build (same assets the browser GUI uses)
```

The binary keeps Cargo's `[[bin]]` name (`udmt-desktop`); the visible identity comes from `productName`
("UDMT") — Start Menu entry, install folder `%LOCALAPPDATA%\UDMT`, Add/Remove Programs. The window title
is set separately in `open_main_window`.

At launch the shell:

1. picks the first free loopback port in `4004..4019` (a CLI `udmt gui` already on 4004 is fine),
2. spawns `runtime/node.exe runtime/udmt-core.cjs gui --port <port>` with
   `UDMT_UI_DIR=runtime/ui` and `CREATE_NO_WINDOW` (no console flash),
3. polls `GET /api/health` until the response contains `"app":"udmt"` (45 s budget),
4. opens the window on `http://127.0.0.1:<port>/` — the same origin serves the SPA and `/api`,
5. kills the core when the last window closes.

There is **no IPC** between the shell and the UI: everything goes through the loopback HTTP facade,
which already enforces loopback-`Host` and same-origin mutations. That is deliberate — it keeps one
API surface for the browser GUI, the CLI and the desktop app.

Startup output (including crashes) is written to `%APPDATA%\udmt\logs\desktop-core.log` and the
shell's own trace to `desktop-shell.log` in the same folder. If that folder is not writable the shell
falls back to `%LOCALAPPDATA%\udmt\logs`, then to `%TEMP%\udmt-logs`.

Environment knobs (all optional, inherited by the core):

| Variable | Purpose |
|---|---|
| `UDMT_DATA_DIR` | metadata/artifact location (shared with the CLI by default) |
| `UDMT_LOG_DIR` | force the log folder |
| `UDMT_WEBVIEW_DATA_DIR` | WebView2 profile folder (default `%LOCALAPPDATA%\UDMT\WebView2`) |
| `UDMT_ACCESS_LOG=1` | log every HTTP request to the core log |
| `UDMT_RUNTIME_DIR` | point at a different `runtime/` payload (development) |

## Data location

The desktop app uses the same metadata directory as the CLI (`%APPDATA%\udmt` on Windows,
`~/Library/Application Support/udmt`, `~/.local/share/udmt`), so connections, artifacts and run
history are shared. Set `UDMT_DATA_DIR` to relocate it.

## Build

```bash
pnpm install
pnpm run desktop          # tsc + Nuxt generate + runtime bundle + tauri build
```

`scripts/desktop.mjs` runs the four steps in order and then lists the artifacts it found. Flags:

- `--skip-frontend` — only rebuild the runtime payload and Rust (when the SPA did not change)
- `--bundles=deb` — narrow the bundle targets for one run

`pnpm run desktop:prepare` only assembles `src-tauri/runtime/`; then `npx tauri build` manually.

### Per-platform bundle targets

Tauri merges `tauri.<platform>.conf.json` over `tauri.conf.json`, so the base config stays clean:

| File | Targets | Extra |
|---|---|---|
| `src-tauri/tauri.windows.conf.json` | `nsis` | per-user install, no language selector, `icons/icon.ico` as installer + uninstaller icon, `UDMT` Start Menu group |
| `src-tauri/tauri.linux.conf.json` | `deb`, `appimage` | deb depends on `libwebkit2gtk-4.1-0`, `libgtk-3-0` |
| `src-tauri/tauri.macos.conf.json` | `app`, `dmg` | `minimumSystemVersion: 10.15` |

### Linux

Prerequisites (Debian/Ubuntu naming):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

```bash
pnpm install
pnpm run desktop
# → src-tauri/target/release/bundle/deb/*.deb
# → src-tauri/target/release/bundle/appimage/*.AppImage
```

`patchelf` is only needed for AppImage; `file`/`wget` are used by the bundler. The end user needs the
WebKitGTK runtime (the `.deb` declares it; a bare AppImage expects the distro to provide GTK/WebKit).

### macOS

Prerequisites: Xcode command line tools (`xcode-select --install`) and a Rust toolchain.

```bash
pnpm install
pnpm run desktop
# → src-tauri/target/release/bundle/macos/UDMT.app
# → src-tauri/target/release/bundle/dmg/*.dmg
```

Build on the matching architecture to keep the bundled `node` binary correct (arm64 Mac → arm64 app).
An unsigned `.app` is quarantined by Gatekeeper on other machines: right-click → Open, or sign and
notarize before distributing.

### Why there is no cross-build

The payload embeds the host's `node` executable. `scripts/prepare-desktop.mjs --target=linux` run on
Windows exits with an explicit error instead of producing a broken installer; use one CI runner per OS
(`windows-latest`, `ubuntu-latest`, `macos-latest`).

Artifacts (Windows):

- `src-tauri/target/release/udmt-desktop.exe` — portable executable (needs the `runtime/` folder)
- `src-tauri/target/release/bundle/nsis/UDMT_0.1.0_x64-setup.exe` — installer

### `os error 32` on rebuild

`tauri build` copies `runtime/` into `target/release/`. A running desktop app from that folder, or an
orphaned `runtime\node.exe` (left behind when the window is force-killed), holds a handle on
`runtime\node.exe` and the copy fails:

```
error: failed to run custom build command for `udmt-desktop`
  The process cannot access the file because it is being used by another process. (os error 32)
```

Close the window, end that `node.exe` (check its command line for `udmt-core.cjs`), then rebuild. This
is a Windows file-lock, not a packaging bug.

## Why the core is bundled, not shipped as `node_modules`

The core pulls in `pg`, `mysql2`, `mongodb`, `zod`, `commander`, `csv-parse`/`csv-stringify` — roughly
70 MB of `node_modules`. `scripts/prepare-desktop.mjs` bundles it with esbuild into one CommonJS file,
so the payload stays ~3.5 MB and the app cannot break because of a missing transitive dependency.
Two source-level adjustments make that possible and are permanent:

- `src/core/db/sqlite-driver.ts` falls back to `__filename` when `import.meta.url` is unavailable.
- `src/api/server.ts` resolves the UI directory from `UDMT_UI_DIR` first.

## Two Windows-specific bugs this shell had to fix

- **Extended paths.** `resource_dir()` returns `\\?\D:\...`; Node treats `\\?\D:` as a device name
  and dies with `EISDIR: lstat 'D:'`. `simplify_path` strips the prefix before spawning.
- **WebView2 profile.** The default profile location is derived from the process environment; when it
  is redirected or locked, window creation fails with `Access is denied (os error 5)`. The shell now
  passes an explicit `data_directory` and also sets `WEBVIEW2_USER_DATA_FOLDER`.

## Known limitations

- Only Windows is built here; the same `tauri build` works on macOS/Linux but the shipped `node`
  binary must match the target platform (the script copies `process.execPath`).
- No auto-updater, no code signing certificate — SmartScreen will warn on first run of an unsigned
  installer.
- The `runtime/` folder must ship next to the executable; the portable `.exe` alone is not enough.
- Closing the window kills the core, but force-killing the shell (Task Manager → End task) leaves the
  core running, because Windows gives no chance to run the exit hook.
- The shell opens the GUI on loopback; it is still a local tool with no authentication, so anyone who
  can reach that port on the machine can use it.

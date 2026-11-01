---
title: Desktop app
description: Installer layout, where the unpackaged build runs and how to build it yourself
section: operations
order: 9
updated: 2026-11-01
tags: desktop, tauri, installer, offline
---

# Desktop app

The desktop app is a Tauri v2 shell wrapped around the exact same TypeScript core the CLI uses. There is
no second implementation of the business logic, and the target machine does not need Node installed.

## What the installer contains

```
udmt-desktop.exe        Rust shell (~3 MB)
runtime/node.exe        Node 22 (no system Node required)
runtime/udmt-core.cjs   core + CLI + API, one bundled file (~3.5 MB)
runtime/ui/             static GUI (SPA)
```

It is installed per user in `%LOCALAPPDATA%\UDMT`, so no administrator rights are needed.

On launch the shell:

1. Picks the first free port in `4004..4019` (a CLI already on 4004 is fine).
2. Spawns the core without a console window.
3. Waits for `/api/health` to answer `"app":"udmt"`, up to 45 seconds.
4. Opens the window on `http://127.0.0.1:<port>/`.
5. Stops the core when the last window closes.

There is no IPC: the desktop GUI, the browser GUI and the CLI all use the same loopback API, so they
behave identically.

## Installer identity

The setup file is not a generic `*-setup.exe`: the product name, the application icon and the installer
icon come from `src-tauri/tauri.conf.json` and `src-tauri/tauri.windows.conf.json`.

| What | Where it is defined |
|---|---|
| Product / app name (Start Menu entry, installed folder, Add/Remove Programs) | `productName` in `src-tauri/tauri.conf.json` |
| Setup file name (`UDMT_<version>_<arch>-setup.exe`) | Derived from `productName` + `version` + architecture |
| Window title | `.title(...)` in `open_main_window` (`src-tauri/src/lib.rs`) |
| App icon (`.exe`, shortcuts, Add/Remove Programs) | `bundle.icon` → `icons/icon.ico` (16–256 px, 6 sizes) |
| Installer window + uninstaller icon | `bundle.windows.nsis.installerIcon` / `uninstallerIcon` → `icons/icon.ico` |
| Start Menu group | `bundle.windows.nsis.startMenuFolder` (`UDMT`) |
| Publisher | `bundle.publisher` (`TM Data`) |

Renaming the product (say to `UDMT Data Studio`) renames the setup file too, because the installer name is
built from `productName` at bundle time. Change `productName` and `open_main_window` together, otherwise
the title bar still shows the old name.

To regenerate the icons from the vector source after editing `icons/source.svg`:

```bash
pnpm exec tauri icon src-tauri/icons/source.svg
```

## Where the unpackaged build runs

`pnpm run desktop` does **not** only produce an installer — it also leaves a full, runnable build behind,
and that is what you run while iterating:

| Path | What it is |
|---|---|
| `src-tauri/target/release/udmt-desktop.exe` | The shell binary. Double-click it and it starts its own core and window. |
| `src-tauri/target/release/runtime/` | The payload the shell looks for next to the binary. Must stay beside it. |
| `src-tauri/target/release/bundle/nsis/UDMT_0.1.0_x64-setup.exe` | The installer. |

The shell resolves `runtime/` in this order: the Tauri resource directory, then the folder containing the
executable, then the current working directory. So `target/release/udmt-desktop.exe` works in place —
moving the `.exe` alone without its `runtime/` folder does not. `UDMT_RUNTIME_DIR` overrides the search
entirely, which is handy when testing a payload from another folder.

For a browser instead of the shell, `pnpm run build && pnpm run build:gui` then `pnpm run dev` serves the
same GUI at `http://127.0.0.1:4004` with no Rust involved at all. Plain `pnpm run build` / `build:gui` on
their own only write `dist/` and `app/.output/public` — nothing runs until `udmt gui` starts.

## Logs

- `desktop-shell.log` — shell startup.
- `desktop-core.log` — core stdout/stderr, including database and port errors.

Both live in `logs/` under the data directory (`%APPDATA%\udmt\logs` on Windows). If that directory is not
writable the shell falls back to `%LOCALAPPDATA%`, then `%TEMP%`.

## Building it yourself

```bash
pnpm install
pnpm run desktop          # tsc + nuxt generate + runtime payload + tauri build
```

| OS | Output |
|---|---|
| Windows | `bundle/nsis/UDMT_<version>_x64-setup.exe` |
| Linux | `bundle/deb/*.deb`, `bundle/appimage/*.AppImage` |
| macOS | `bundle/macos/UDMT.app`, `bundle/dmg/*.dmg` |

Build on the target OS itself: the Node runtime is copied from the build machine, and the script refuses
a cross-build so a broken installer is never produced.

### `os error 32` while rebuilding

Tauri copies `runtime/` into `target/release/` on every build. If an app started from that folder is still
open — including an orphaned `runtime/node.exe` left behind by a force-killed window — Windows refuses the
copy and the build stops with an error like:

```
error: failed to run custom build command for `udmt-desktop`
  The process cannot access the file because it is being used by another process. (os error 32)
```

Close the desktop window, then end any leftover `node.exe` whose command line points at
`runtime\udmt-core.cjs`, and run `pnpm run desktop` again. Renaming `src-tauri/target/release` is not
necessary.

## Installer needs admin, or the app shows a blank window

Both symptoms have the same cause, and it is about **where the file sits**, not about Windows itself.

A folder can carry a **mandatory integrity label**. Files created in it inherit that label, and the two
below are the ones that break things:

```
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
Everyone:(DENY)(S,DC)
```

A `Low`-labelled executable runs at Low integrity. Low integrity **cannot write to `%TEMP%`** (Medium), so
the NSIS installer aborts with *"error writing temporary file"* — and it "works" only when you launch it
elevated, because High integrity may write everywhere. The same app also cannot start
`msedgewebview2.exe` (Medium), so the window opens with **no UI at all**.

Check any folder and its artifacts:

```bat
icacls "D:\Applications"
icacls "D:\Applications\tm-data-manager\src-tauri\target\release\udmt-desktop.exe"
```

Fix it by re-labelling the files to Medium (no admin needed when you own them):

```bat
icacls "<folder>" /setintegritylevel (OI)(CI)Medium /T
```

`pnpm run desktop` does this for you: it warns when the checkout is in a Low-integrity tree and re-labels
`udmt-desktop.exe`, `runtime/` and `bundle/nsis` as the last build step. The shell also refuses to start
from a Low-integrity process and shows a dialog naming the folder instead of opening a blank window.

None of this reaches an end user: the installer writes to `%LOCALAPPDATA%\UDMT`, which has no such label,
and integrity labels do not survive a copy or a download.

## Code signing

Unsigned builds trigger SmartScreen on first run ("Windows protected your PC" → *More info* → *Run
anyway*) and may warn about an unknown publisher. Signing removes that once the certificate has
reputation.

The build signs automatically when a certificate is configured — nothing is signed when it is not:

| Variable | Meaning |
|---|---|
| `UDMT_SIGN_CERT` | Path to a `.pfx`, **or** a certificate thumbprint read from a store |
| `UDMT_SIGN_CERT_PASSWORD` | Password for the `.pfx` |
| `UDMT_SIGN_CERT_SUBJECT` | Alternative to a thumbprint: pick the store certificate by subject |
| `UDMT_SIGN_CERT_STORE` | Store to read from (`CurrentUser` by default) |
| `UDMT_SIGN_TIMESTAMP_URL` | RFC 3161 timestamp server (`http://timestamp.digicert.com` by default) |

```powershell
$env:UDMT_SIGN_CERT = 'C:\certs\tm-data.pfx'
$env:UDMT_SIGN_CERT_PASSWORD = '…'
pnpm run desktop
```

The script locates `signtool.exe` on `PATH` or in the newest Windows SDK, signs the shell binary, everything
under `runtime/`, and the installer, then prints each file's `Get-AuthenticodeSignature` status. A signing
failure fails the build instead of shipping a half-signed installer. Signing runs **before** the integrity
re-label, because rewriting a file drops its label.

The signature is what actually fixes SmartScreen. An OV certificate needs days-to-weeks of download volume
before the warning disappears; an EV certificate is trusted immediately. Both need a real legal entity, so
budget for it — a self-signed certificate only helps on machines that imported your root.

To check a delivered installer:

```powershell
Get-AuthenticodeSignature .\UDMT_0.1.0_x64-setup.exe | Format-List Status, SignerCertificate
```

## Testing on a clean machine

A Windows Sandbox gives you a truly clean machine in seconds (Pro/Enterprise; the feature is off by
default and needs a reboot after enabling it):

```powershell
# elevated, once
Enable-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM'
# then
WindowsSandbox
```

Inside the sandbox, copy the installer in and check, in this order:

1. Double-click the setup as the sandbox's normal user — it must **not** ask for admin rights.
2. The window appears and the GUI loads within a few seconds (no blank window).
3. `%LOCALAPPDATA%\UDMT` exists; `%APPDATA%\udmt\logs` has both log files.
4. SmartScreen/should-not-run wording: note what it says, since the artifact is unsigned unless you signed it.
5. Add a connection, restart the app, confirm it is still there.
6. Uninstall from *Apps & features* and confirm `%LOCALAPPDATA%\UDMT` is gone.

> The installer is unsigned unless `UDMT_SIGN_CERT` is configured, so Windows SmartScreen warns on first
> run. On macOS you may need right-click → Open to get past Gatekeeper.

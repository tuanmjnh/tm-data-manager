# ADR-002 — TypeScript Core on Node instead of Rust + Tauri (for now)

**Status:** Accepted with a documented migration path.

## Context

The roadmap specifies a Rust Core with a Tauri v2 desktop shell, GUI and CLI sharing one executable.
The Phase 0 audit found:

- `cargo` and `rustc` are **not installed**, and there is no MSVC/LLVM target verified on this machine.
- `mongodump`/`pg_dump` are not installed, so the sidecar/native-tool strategy cannot be executed here.
- Node.js 22.22 is available and ships `node:sqlite`, which is sufficient for a durable local
  metadata store without native modules.

Shipping unbuildable Rust code would violate the roadmap's own quality gate ("the release target must
build", "UI actions must be wired to a real backend"). It would also prevent verifying export/import
end to end.

## Decision

Implement the Core in TypeScript on Node 22, keep every architectural boundary of the roadmap, and serve
the Nuxt SPA from a loopback HTTP facade instead of Tauri IPC:

| Roadmap | This build |
|---|---|
| `udmt-core` (Rust) | `src/core` |
| `udmt-provider-*` | `src/core/providers/*` |
| `udmt-database` | `src/core/db/*` |
| `udmt-storage` | `src/core/storage/local.ts` + `formats/` |
| `udmt-cli` (clap) | `src/cli` (commander) |
| Tauri commands | `src/api/server.ts` (loopback JSON HTTP) |
| Tauri + Nuxt GUI | Nuxt 4 SPA (same UI code) |

Data access uses native drivers (streaming cursors) instead of sidecar binaries.

## Consequences

**Good**

- The whole product builds, runs and is tested here (44 tests, real round trips).
- Same contracts, same schema, same UX; moving to Rust later is a port of `core`, not a rethink.
- No native dependency at all, so the CLI works on any machine with Node ≥ 22.5.

**Limits / debt**

- No native dump formats (`mongodump`, `pg_dump -Fc`), so restores into a *native* tool workflow are not
  supported yet. Logical export/import is the supported path.
- The HTTP facade is loopback-only and unauthenticated by design; a Tauri IPC boundary would remove the
  HTTP surface entirely.
- `node:sqlite` is marked experimental by Node. It is wrapped behind `db/sqlite-driver.ts` so switching
  to `better-sqlite3` is a one-file change if required.

## Update — the Tauri shell now exists (Rust installed)

A Rust toolchain became available, so the desktop shell was built: `src-tauri/` is a Tauri v2 app that
supervises the Node core as a child process and opens the window on its loopback URL. Rust is therefore
in the stack for *packaging*, while the Core logic stays TypeScript.

This keeps the decision above intact (one HTTP facade, no IPC, no duplicated business logic) and shrinks
the remaining migration to step 1–3 below: porting `core` to Rust would then only replace the child
process. See [`../desktop/packaging.md`](../desktop/packaging.md) for the payload layout and build.

## Migration plan (if the core is ever ported to Rust)

1. Port DTOs/errors/state machine to `udmt-provider-api` + `udmt-core`.
2. Port repositories/migrations to `rusqlite` with the same table definitions and versions.
3. Port the operation engine and providers; add contract tests that replay the same fixtures.
4. Replace the HTTP facade with Tauri commands; keep the `app/` UI and its API composable shape.
5. Keep the CLI command names, flags and exit codes to avoid breaking users.

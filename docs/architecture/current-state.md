# Phase 0 — Repository audit (current state)

> Date: 2026-11-01. Scope: `tm-data-manager` before any implementation.

## 1. What existed

| Item | Finding |
|---|---|
| Repository | Not a git repository at audit time; only `docs/` existed. |
| Source code | None. No Rust workspace, no `Cargo.toml`, no Nuxt app, no Tauri config. |
| Database | No existing `udmt.db`, no legacy SQLite file shipped with the repo. |
| Build/test scripts | None. No baseline to run. |
| Docs | `docs/universal-data-management-roadmap-hybrid-v1.md` (roadmap + implementation instructions). |

## 2. Toolchain audit (this machine)

| Tool | Result | Consequence |
|---|---|---|
| Node.js | `v22.22.0` | Usable; ships `node:sqlite` (experimental warning only). |
| npm / pnpm | `11.12.1` / `12.15.0` | Usable. |
| Rust (`cargo`, `rustc`) | **missing** | The roadmap's Rust Core + Tauri v2 shell cannot be built or verified here. |
| `mongodump` / `mongorestore` | **missing** | Native MongoDB tooling sidecar strategy is not executable. |
| `pg_dump` / `pg_restore` / `psql` | **missing** | Native PostgreSQL dump/restore is not executable. |
| OS | Windows 10 (MINGW64 shell) | Path handling must be cross-platform; 0600 semantics are best-effort. |

## 3. Functional inventory (implemented / partial / missing)

Everything in the roadmap was **missing** at audit time. There was no UI, no CLI, no DB schema, no
provider, no operation engine, and no test suite. Therefore no "implemented-not-tested" or "mock-only"
code had to be preserved, and no migration from a live local database was possible.

## 4. Risk register and how this build addresses it

| Risk | Mitigation in this build |
|---|---|
| Rust/Tauri unavailable → no buildable deliverable | TypeScript Core + CLI + Nuxt SPA served by a loopback API. Documented as a deviation with a migration path (ADR-002). |
| No native dump tools | Logical export/import through native drivers (`pg`, `mysql2`, `mongodb`, `node:sqlite`), streaming in batches. Native dump strategy remains a Phase 1+ enhancement gated on packaging. |
| Legacy schema unknown | Migrations detect the old `connections(provider, uri_encrypted, default_dir)` / `operation_logs(conn_id, …)` layout, rename it, import rows, and keep the raw rows in `legacy_imports`. Covered by an integration test. |
| Secrets leaking into SQLite/logs | AES-256-GCM vault + redaction + a test that greps the DB file for a known password. |
| Destructive import | Explicit `--confirm <connection-name>`; production connections always ask; dry-run that never writes. |
| Double scheduled execution | Worker lock file + DB lease locks + overlap policy; abandoned runs → `interrupted`. |
| UI showing features that do not exist | Capability registry drives the provider descriptors; the engine enforces capabilities; unsupported actions return `CAPABILITY_UNSUPPORTED`. |

## 5. Baseline build/test results

- `npm run build`: not applicable before implementation.
- `npm test`: not applicable before implementation.
- No GUI/CLI launch behaviour existed to verify.

## 6. Consequences for the plan

1. Build the Core contract first (DTOs, capability registry, error model, state machine).
2. Implement the SQLite metadata store with versioned migrations, including legacy import.
3. Ship two first-class providers for verification (`sqlite`) and the roadmap's V1 targets
   (`postgresql`, `mongodb`), plus MySQL since it shares the same SQL path.
4. Keep GUI and CLI behind the same facade; never let Vue or command handlers build queries.
5. Report the unbuildable Rust/Tauri target explicitly rather than pretending it works.

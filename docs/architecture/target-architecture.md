# Target architecture

## 1. Layers

```
src/core            business logic (no UI, no HTTP)
  ├── types.ts          canonical DTOs (Connection, Run, Artifact, Manifest, Schedule…)
  ├── errors.ts         typed error model + redaction
  ├── state-machine.ts  the only legal operation transitions
  ├── service.ts        UdmtApp facade used by CLI, API and worker
  ├── db/               node:sqlite metadata store, versioned migrations, repositories
  ├── providers/        contract + sqlite / postgresql / mysql / mongodb adapters + registry
  ├── formats/          CSV / JSONL / JSON (streaming) + XML / XLSX writers & readers (+ gzip)
  ├── operation/        unified operation engine (export, import, verify)
  ├── storage/          local artifact backend + manifest/checksum handling
  └── worker.ts         headless scheduler runtime, recovery, heartbeat

src/cli             commander CLI (thin; calls UdmtApp only)
src/api             loopback HTTP facade for the GUI (thin; calls UdmtApp only)
app/                Nuxt 4 SPA + Nuxt UI v4 (no business logic)
```

Dependency rule: `cli`/`api` → `core`; `core` never imports from `cli`, `api` or `app`.
Providers never write metadata themselves — they return data/results and the engine persists state.

## 2. Provider model

A provider is an adapter for one engine/protocol. Cloud services are **service profiles** on the engine:

| Connection | `provider_id` | `service_profile` |
|---|---|---|
| Supabase | `postgresql` | `supabase` |
| Neon | `postgresql` | `neon` |
| MongoDB Atlas | `mongodb` | `mongodb_atlas` |
| PlanetScale | `mysql` | `planetscale` |

Contract (`src/core/providers/contract.ts`):

- `validateConfig(config, secret)` → normalized config + sanitized endpoint hint.
- `testConnection` → server version, auth diagnostics, detected capabilities.
- `discoverResources` → databases / schemas / tables / collections.
- `readSchema` → columns with canonical types (`string|integer|number|boolean|timestamp|date|json|binary|unknown`).
- `readRows` (optional) → async generator of row batches, cancellation-aware.
- `writeRows` (optional) → streaming loader with `append` / `upsert` / `truncate_and_load`.

Built-in providers are `sqlite`, `postgresql`, `mysql`/`mariadb`, `mongodb` and `rest` (a paginated,
authenticated JSON API connector; see `docs/provider-contract/rest-connector.md`).

Capabilities are declared in `descriptor().capabilities` and asserted before every operation
(`ProviderRegistry.assertCapability`). External providers over IPC are Phase 7 and not implemented.

## 3. Data formats

Formats are transport, not providers. A single canonical row representation flows:

```
provider.readRows → canonical row (Date→ISO, ObjectId→hex, Binary→base64)
                  → format writer (CSV columns from schema; JSONL/JSON preserve nesting)
                  → artifact file (+ gzip) → sha256 → manifest
```

On import the reverse happens, with type coercion driven by the manifest columns. CSV has no types, so
the reader samples up to 200 rows when no manifest exists and coerces values per column.

## 4. One core, three entry points

| Entry point | How it uses the core |
|---|---|
| CLI | Creates `UdmtApp`, calls use cases, polls run state for progress. |
| API | Creates one `UdmtApp` per server process; `POST /export` and `POST /import` return the run and execute in-process; the GUI polls `/runs/:id`. |
| Worker | Creates `UdmtApp`, claims due schedules, creates the same runs with `job_id` + `worker_instance_id`. |

Because state is durable in SQLite, the GUI can be closed and reopened at any point without losing
progress; the worker keeps executing.

## 5. Deviation from the roadmap stack (see ADR-002)

The roadmap targets Rust + Tauri v2. Rust is not installed on this machine, so this implementation uses
TypeScript on Node 22 with a loopback HTTP boundary instead of Tauri IPC. The layer boundaries,
contracts and DB schema match the roadmap, so the Rust migration is a per-layer port rather than a
rewrite:

1. `src/core/providers/contract.ts` → `udmt-provider-api` Rust traits.
2. `src/core/operation/engine.ts` → `udmt-core` operation orchestrator.
3. `src/cli` → `udmt-cli` (clap) keeping the same commands and exit codes.
4. `src/api` → Tauri command adapters (`connection_*`, `backup_*`, `operation_*`…).
5. `app/` stays unchanged; only the transport composable changes.

## 6. What is intentionally absent

External plugin host, CDC, notifications, OS keyring and native dump tooling. S3 storage and the Data
Sync engine are implemented (Phases 4–5). Each has a documented state in
`docs/IMPLEMENTATION-STATUS.md`; none is mocked or faked.

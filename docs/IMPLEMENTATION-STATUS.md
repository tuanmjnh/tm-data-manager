# Implementation status

Roadmap phases are implemented in order; this file records exactly what works, what was verified,
and what remains. Nothing here is marked complete based on "it compiles".

**Package manager:** pnpm 12 only (workspace root + `app`). `package-lock.json` and `node_modules`
installed by npm were removed; dependency install scripts are whitelisted in `pnpm-workspace.yaml`
(`allowBuilds`). All commands in this repo, the docs and `scripts/*.mjs` use `pnpm`.

```
PHASE: 0 — Repository audit & architecture baseline
STATUS: completed

1. Implemented
- Audited the empty repository and the machine toolchain.
- Recorded the Rust/Tauri and native-dump-tool unavailability as a blocking constraint.
- Produced docs/architecture/current-state.md and ADR-002.

2. Files changed
- docs/architecture/current-state.md (new)
- docs/decisions/ADR-002-runtime-typescript-core.md (new)

3. Database migrations
- none (no existing DB)

4. Tests executed
- n/a (no baseline build/test existed)

5. Manual verification
- cargo/rustc/mongodump/pg_dump presence checks; node version check.

6. Known limitations / risks
- No git repository existed; history cannot be compared.
- Native dump formats cannot be executed on this machine.

7. Next recommended phase
- Phase 1.
```

```
PHASE: 1 — Core foundation + providers + export/import
STATUS: completed (logical export/import; native dump format deferred)

1. Implemented
- Canonical DTOs, typed error model, capability registry, provider contract.
- SQLite metadata store with versioned migrations incl. legacy schema import.
- Connection manager + encrypted secret vault + URI password extraction + redaction.
- Providers: sqlite, postgresql (pg + pg-cursor streaming), mysql/mariadb, mongodb.
- Streaming CSV/JSONL/JSON writers/readers with gzip and sidecar manifests.
- Unified operation engine: durable runs, state machine, progress, logs, cancellation,
  preflight/capability checks, checksum + verification, artifact catalog.
- CLI: provider/connection/export/import/operation/artifact/job/schedule/worker/doctor/serve/gui.

2. Files changed
- src/core/**, src/cli/**, src/api/**, tests/**

3. Database migrations
- v1 initial schema (connections, secrets, storage_backends, jobs, job_schedules, operation_runs,
  operation_logs, artifacts, task_locks, worker_instances, settings, audit_events, legacy_imports)
- v2 scheduler/expiry indexes

4. Tests executed
- pnpm run typecheck (clean)
- unit + integration suite: 43 tests passing (see docs/testing/provider-contract-tests.md)

5. Manual verification
- Real CLI round trip: SQLite 2500 rows → gzipped JSONL → SQLite (2500 rows), CSV limit export,
  dry-run, truncate confirmation guard, upsert idempotency, artifact verify (tamper detected),
  retention preview.

6. Known limitations / risks
- PostgreSQL/MySQL/MongoDB not tested against a live server here.
- No native dump/restore formats (mongodump/pg_dump -Fc).
- Cursor-based read does not open a repeatable-read snapshot; consistency is provider-default only.
- Master key is a file, not an OS keyring (documented in the UI).

7. Next recommended phase
- Phase 2.
```

```
PHASE: 2 — Worker + scheduler + task manager UI
STATUS: completed (Windows service registration not implemented)

1. Implemented
- Headless worker with heartbeat, instance record, graceful shutdown, crash recovery
  (abandoned runs → interrupted), local lock file, DB lease locks.
- Scheduler: once/interval/daily/weekly/monthly, IANA timezone, DST handling, misfire policy
  (skip | run_once_on_recovery), overlap policy (forbid default), next-run calculation.
- Jobs for export and import, JSON output, `worker run|once|status`.
- GUI Pages: Overview, Operations (filters + live log slideover + cancel), Schedules
  (enable/disable/delete/create), plus export/import/artifacts/system.

2. Files changed
- src/core/worker.ts, src/core/scheduler.ts, src/core/service.ts, src/core/db/*,
  src/cli/bin.ts, src/api/server.ts, app/**

3. Database migrations
- uses v1/v2 tables (jobs, job_schedules, task_locks, worker_instances)

4. Tests executed
- scheduler unit tests (10) incl. timezone/DST/clamping
- worker path exercised manually: due schedule → run created, next_run advanced, worker stopped cleanly
- GUI built; export + import flows exercised in the browser (100 rows, verified artifact, no console errors)

5. Manual verification
- `udmt worker once` produced a completed export run and advanced `next_run_at`; `worker status`
  reported Stopped with a recent heartbeat.

6. Known limitations / risks
- Windows Task Scheduler / macOS LaunchAgent / systemd unit installation is documented only;
  no installer integration.
- Only one worker per data dir (local lock); distributed locking out of scope.
- GUI logs are polled (not SSE/WebSocket); state remains durable in SQLite.

7. Next recommended phase
- Phase 3.
```

```
PHASE: 3 — Verification, retention, safe cleanup
STATUS: completed (notifications deferred)

1. Implemented
- SHA-256 at write time + recompute before `completed`; `artifact verify` creates a durable run.
- Verification status (`unverified|verified|failed`) on artifacts, shown in GUI.
- Retention cleanup: keep newest N per provider, delete older than N days, skip pinned and
  outside-root files, dry-run preview, audit event.

2. Files changed
- src/core/operation/engine.ts, src/core/service.ts, src/cli/bin.ts, app/pages/artifacts.vue

3. Database migrations
- none beyond v2 (verified_at, pin, expiry columns already present)

4. Tests executed
- tamper detection test, verify success test, retention pin test

5. Manual verification
- `artifact verify` OK, then appended a byte → FAILED + run failed + status failed.

6. Known limitations / risks
- Restore-test into a disposable environment is not implemented.
- Desktop notifications / notification channels are not implemented (UI toasts only).

7. Next recommended phase
- Phase 4 (MySQL/SQLite providers already shipped; S3/R2 backends remain) or Phase 5 (Data Sync).
```

```
PHASE: 4 — Artifact storage backends (local + S3-compatible)
STATUS: completed (tested against a real local HTTP endpoint; no live cloud account available)

1. Implemented
- Storage abstraction (`StorageBackend`): staging dir, put/get, stat, checksum, list, delete,
  locator, health test. The operation engine streams to local staging first, so providers and the
  import/export format layer stay backend-agnostic.
- Local backend: staging under `<data-dir>/tmp/staging/<run-id>`, managed artifacts under
  `<data-dir>/artifacts/<run-id>`, external `output_dir` preserved as `output_mode: external`.
- S3-compatible backend (AWS S3, Cloudflare R2, MinIO, Backblaze B2): SigV4 signing implemented with
  `crypto` + `fetch` (no vendor SDK), PUT/GET/HEAD/DELETE/ListObjectsV2, path-style and virtual-host
  addressing, prefix validation, XML key parsing, sanitized error hints, upload/download checksums.
- Export: stage locally → upload data + `.manifest.json` sidecar → catalog locator
  `s3://bucket/key` → verify checksum against the remote object.
- Import: materialize the remote object into staging, run the normal streaming import, then clean up;
  `artifact delete` deletes both objects through the backend. Attribution: database rows are still
  only written by `Store`.
- Catalog CRUD + health probe: create/update/delete/set default/test; delete is refused for
  `local-default`, the current default, or any backend that still owns artifacts; secrets are stored
  in the vault and only a `localvault:` reference is persisted.
- API: `GET/POST /api/storage/backends`, `GET/PATCH/DELETE /api/storage/backends/:id`,
  `POST .../:id/test`, `POST .../:id/default` (legacy `GET /api/storage` kept).
- CLI: `udmt storage list|inspect|add|test|default|remove`; `udmt artifact delete` now goes through the
  backend.
- GUI: Storage page with list, create/edit, connection test diagnostics, default switch and guarded
  delete; nav entry + en/vi locales.
- Migration v3 adds `endpoint_hint`, `last_tested_at`, `last_test_status`.

2. Files changed
- src/core/storage/{contract,local,s3,index}.ts (new), src/core/types.ts, src/core/errors.ts,
  src/core/db/{migrations,store}.ts, src/core/service.ts, src/core/operation/engine.ts,
  src/api/server.ts, src/cli/bin.ts, app/{pages/storage.vue,layouts/default.vue,types.ts,i18n/locales/*},
  tests/unit/storage-signing.test.ts, tests/integration/storage-s3.test.ts, docs/{decisions, database}.

3. Database migrations
- v3 `storage-backend-health` (additive columns on `storage_backends`).

4. Tests executed
- `pnpm run typecheck` clean; `pnpm test` 51/51 passing; `pnpm run check:i18n` clean;
  `pnpm --filter udmt-gui run build` succeeds.
- Unit: RFC3986 canonical encoding, S3 locator, config/prefix validation, credentials required.
- Integration (real HTTP server acting as S3): PUT/HEAD/GET/DELETE/ListObjectsV2 with a verified SigV4
  `Authorization` header and SHA-256 payload header; backend CRUD + health probe stored in the catalog;
  export → S3 → catalog locator → `artifact verify` → import round trip (25 rows) → artifact delete
  removes both remote objects; delete protection for a backend that owns artifacts.
- Existing round-trip suite still passes (local backend unchanged in behaviour).

5. Manual verification
- Exercised the storage page against the local API: create S3 backend, list, test (diagnostics),
  set default, edit, delete; GUI build served from the generated output. No live AWS/R2/MinIO/B2
  account was available in this environment, so real cloud credentials and CORS/bucket policies were
  **not** verified; the fake endpoint implements the S3 wire format used by the backend.

6. Known limitations / risks
- No multipart upload: single-PUT objects are limited to the provider's maximum (5 GiB on AWS S3).
- No server-side encryption headers, object lock, lifecycle or bucket auto-creation; configure these in
  the provider console.
- Virtual-host addressing is implemented but only path-style was exercised here.
- Remote import always downloads the whole object to staging before importing (no ranged import).
- No live cloud test; list pagination is implemented but only single-page responses were exercised.

7. Next recommended phase
- Phase 5 — Data Sync.
```

```
PHASE: 5 — Data Sync Engine
STATUS: completed for database providers (SQLite→SQLite verified end-to-end; other providers reuse the
same contract but were not run against live servers here)

1. Implemented
- Sync pipeline definition: source/target connection + resource, field mapping, load mode
  (`append`, `upsert`, `truncate_and_load`, `replace_resource`), key columns, filter, batch size,
  row-error policy, retry policy, row limit, target resource creation flag and an enabled switch.
- Mapping/transform pipeline (pure module): implicit name mapping or explicit rules; source type
  inheritance; explicit `cast`; `default`, `trim`, `mask` (`email`/`full`/`last4`) and `value_map`;
  dotted paths for nested JSON values. Lossy casts fail with `CAST_FAILED` instead of writing a
  corrupted value (e.g. `12.5` → integer, integers beyond JS safe range, non-boolean strings).
- Filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `is_null`, `not_null`.
- Engine preflight: source must declare `read_data` + `schema_read`, target `write_data`; both
  connections must be active and the pipeline enabled. Source schema drives the mapping; a target
  schema (when readable) produces missing-column/unknown-type warnings.
- Streaming batch load through the existing provider `readRows`/`writeRows` contract, so the engine
  stays provider-agnostic. Progress, logs, cancellation and terminal status use the existing durable
  run machinery.
- Safety: `truncate_and_load` (and the `replace_resource` alias) requires `--confirm
  <target_connection_name>`; any non-append load into a connection marked `production` requires the
  same confirmation. A rejected preflight never truncates. Full-pipeline retry is limited to
  idempotent modes (`upsert`/`truncate_and_load`) and transient failures; `append` is never retried.
- Error reporting: `on_error=fail` stops at the first bad row with `SYNC_ROW_ERROR`; `on_error=skip`
  persists each bad row (row index, code, sanitized message, capped at 500 per run) and finishes
  `completed_with_warnings`.
- Checkpoint/state: `sync_states` stores the last run, status, cumulative row count and a
  `checkpoint_version: 1`, `kind: full` snapshot; failures persist a `partial` snapshot without
  masking the original error. Full sync only — resumable cursors/watermarks are Phase 8.
- Dry run: samples up to 1,000 source rows, applies filter + transforms, reports matched rows and
  error samples, writes nothing and does not change checkpoint state.
- Surfaces: `UdmtApp` facade, worker execution of `operation_type: sync`, CLI `sync pipeline
  list|inspect|create|update|remove`, `sync run|validate|state|errors`, `job add-sync` (schedulable),
  REST endpoints under `/api/sync/pipelines` and `/api/runs/:id/errors`, and a GUI Sync page
  (list/create/edit/delete, dry-run validation, confirmed real run, live polling, state/checkpoint
  and row-error drawer) with en/vi locales.

2. Files changed
- `src/core/types.ts`, `src/core/errors.ts`, `src/core/state-machine.ts`,
  `src/core/sync/pipeline.ts` (new), `src/core/operation/engine.ts`, `src/core/service.ts`,
  `src/core/worker.ts`, `src/core/db/{migrations,store}.ts`, `src/cli/bin.ts`, `src/api/server.ts`,
  `app/{pages/sync.vue,types.ts,layouts/default.vue,i18n/locales/*}`,
  `tests/unit/sync-pipeline.test.ts` (new), `tests/integration/sync.test.ts` (new),
  `docs/architecture/data-sync.md` (new), this file, `docs/database/schema-and-migrations.md`.

3. Database migrations
- v4 `sync-engine` adds `sync_pipelines`, `sync_states` and `sync_run_errors` with source/target and
  run error indexes. All three cascade from their parent rows; no existing table is rewritten.

4. Tests executed
- `pnpm run typecheck` clean; `pnpm test` 66/66 passing; `pnpm run check:i18n` clean (en/vi parity);
  `pnpm --filter udmt-gui run build` succeeds.
- Unit (8): implicit mapping, unknown-source/duplicate-target rejection, target column/key metadata,
  deterministic transform order, lossy-cast rejection, masking, dotted path reads, all filter
  operators.
- Integration (7, real SQLite files and real metadata DB): append creates the target and copies 250
  rows; mapping+trim+cast+mask+filter writes the expected values; upsert idempotency and
  `truncate_and_load` confirmation (failed preflight leaves prior data intact); `on_error=skip`
  persists one `CAST_FAILED` row error and reports warnings; `on_error=fail` fails at row 251; dry
  run samples 25 rows without creating the target or checkpoint; key columns outside the mapping are
  rejected.

5. Manual verification
- Real CLI round trip in a temporary data dir: SQLite source (120 rows) → SQLite target with
  mapping (trim/mask/cast), filter `age >= 30`, batch size 25, upsert on `id`. Dry run sampled 40 /
  matched 30; the real run read 120, filtered 30, wrote 90; the target held 90 rows with masked
  emails, trimmed names and `min(age)=30`; `sync state` showed a `kind: full` checkpoint.
- `truncate_and_load` without `--confirm dst` exited 2 with `CONFIRMATION_REQUIRED` and kept the
  existing 90 rows; the confirmed rerun completed and left 90 rows.
- Scheduled path: `job add-sync --schedule once` + `worker once` produced a real `sync` run with
  status `completed` and 100% progress in `operation list`.
- This manual pass found and fixed a real CLI bug: `--options` JSON was read from the wrong commander
  property, so filters/batch options were silently dropped. Fixed to `options.options`; re-verified
  with the filter run above.

6. Known limitations / risks
- Only SQLite→SQLite was exercised end-to-end. PostgreSQL/MySQL/MariaDB/MongoDB sync goes through the
  same contract but was not run against live servers in this environment.
- Full sync only. The checkpoint is a run summary, not a resumable cursor; a failed run leaves
  `partial` state but never resumes automatically. Incremental watermarks/CDC are Phase 8.
- `replace_resource` is accepted by CLI/API/GUI and normalized to `truncate_and_load` (same
  truncate+load behaviour, no drop/recreate).
- Upsert semantics depend on the target provider's `writeRows` implementation and require a real
  unique/primary key; there is no conflict-resolution policy.
- Target column creation is delegated to the provider (`create_resource`, default true); missing
  columns are warnings and may fail at write time if the provider cannot add them.
- Retry does not roll back already-written batches; it is only enabled for idempotent modes.
- Row errors are persisted up to 500 per run; the remainder is reported as a warning count.
- The GUI mapping editor is JSON text (not a drag-and-drop builder), and requires a source schema to
  exist for name validation.
- No live cloud/provider test for sync; production confirmation covers misconfiguration, not data
  correctness.

7. Next recommended phase
- Phase 6 — File/API connectors.
```

```
PHASE: 6 — File/API connectors
STATUS: completed for XML/XLSX formats and the REST (JSON) connector (tested against local XML/XLSX
files and a real local HTTP server; no live third-party API was available here)

1. Implemented
- Format adapters extended with XML and XLSX alongside CSV/JSONL/JSON, in both directions:
  - XML: a self-describing `<rows><row><field name=".." type="..">value</field></row></rows>` writer
    (typed values, nested JSON, nulls, escaped text); the reader also accepts generic `<rows><row>`
    documents where child element names become columns. Gzip is supported for XML.
  - XLSX: streaming `exceljs` workbook writer with a header row, and a typed cell reader (dates to ISO,
    rich text/formula results normalized). Gzip is rejected up front because XLSX is already a zip
    container.
  - `detectFormat`/`defaultExtension`/CLI `--format` choices/export+import GUI selectors all include
    `xml` and `xlsx`; the export GUI switches compression to `none` when XLSX is selected.
- REST (JSON) provider (`rest`) registered as a first-class built-in provider with real capabilities:
  - Config: `base_url`, optional `resources` list, `items_path`, extra non-secret `headers`,
    `auth_type` (`none`/`bearer`/`api_key`/`basic`), `auth_header`/`auth_query_param`, `username`,
    pagination (`none`/`page`/`offset`/`cursor`/`link` with param names, page size and `next_path`),
    timeout, `rate_limit_per_minute`, retry attempts/backoff, `write_method`/`write_path`/`write_batch`.
  - Credentials (`token`, `api_key`, `password`) are moved out of the config into the encrypted vault
    by `normalizeInlineSecret`; the endpoint hint and diagnostics never contain them.
  - `testConnection`, `discoverResources` (from the configured list), `readSchema` (samples up to 5
    rows), streaming `readRows` with all pagination modes, rate limiting and retry (honours
    `Retry-After`, retries 429/5xx/network, maps 401/403→`AUTH_FAILED`, 404→`NOT_FOUND`), and append
    `writeRows` (`upsert`/`truncate_and_load` are refused, not faked).
  - Redirects are not followed and pagination links must stay on the configured origin (no SSRF).
- Sources/sinks compose with the existing engine: REST → file artifact → SQLite and REST POST writes
  all work through the normal export/import paths with capability checks and checksummed artifacts.
- CLI: `connection add --provider rest --config <json> [--token|--api-key|--password-stdin]`.
- GraphQL is intentionally not implemented (no use case requested in this environment) rather than
  shipping an untested stub.

2. Files changed
- `src/core/formats/index.ts`, `src/core/types.ts`, `src/core/operation/engine.ts`,
  `src/core/service.ts` (inline REST secrets), `src/core/providers/rest.ts` (new),
  `src/core/providers/registry.ts`, `src/cli/bin.ts`, `app/pages/export.vue`, `app/pages/import.vue`,
  `tests/unit/formats-xml-xlsx.test.ts` (new), `tests/integration/rest-connector.test.ts` (new),
  `package.json`/`pnpm-lock.yaml` (exceljs, fast-xml-parser),
  `docs/provider-contract/rest-connector.md` (new), this file, `docs/architecture/target-architecture.md`.

3. Database migrations
- none (formats and providers add no tables; REST secrets use the existing vault).

4. Tests executed
- `pnpm run typecheck` clean; `pnpm test` 76/76 passing; `pnpm run check:i18n` clean; server + GUI build.
- Unit (4): XML round-trip of typed values/nested JSON/nulls/escaped text, generic XML parsing, XLSX
  write+read with manifest coercion, XLSX gzip rejection.
- Integration (6, real HTTP server): config/endpoint secrecy, authenticated paginated connection test,
  auth-failure without leaking the secret, API key sent in a header (never the URL), missing-credential
  rejection, and REST→JSONL artifact→SQLite import over multiple pages.

5. Manual verification
- Real CLI round trip: SQLite (20 rows) → `--format xml` and `--format xlsx` exports (checksums
  verified), XLSX re-imported into a fresh SQLite table (20 rows, `id/name/score/ok` typed correctly,
  `Name <3> & co` preserved).
- Real CLI + real local HTTP API (12 rows, bearer auth, page size 5): `connection test` OK with token
  and FAILED HTTP 401 with a wrong token (both without echoing the secret); `export --conn posts-api
  --format csv` produced 12 rows across 3 pages; `import` into SQLite wrote 12 typed rows.
- Fixed a real CLI gap found here: REST credentials could not be supplied through `connection add`;
  `--token`/`--api-key` and inline bearer/API-key/base64 handling were added and re-verified.

6. Known limitations / risks
- REST `writeRows` is append-only; upsert/truncate must be implemented by the API (documented, refused
  when requested).
- XML/XLSX readers load the whole document into memory (CSV/JSONL/JSON remain streaming); not suitable
  for multi-GB workbooks. XLSX cannot be read from a `.gz`.
- Generic XML documents without a manifest are read as strings and rely on the import manifest to
  coerce types (our own XML export embeds `type` attributes and round-trips exactly).
- REST `items_path`/pagination settings are per connection; a single connection to an API with many
  differently-shaped endpoints needs multiple connections.
- No live third-party API, TLS pinning, OAuth2 refresh or GraphQL here; rate limiting is client-side
  and per process.
- No HTML/`multipart` format, no server-side pagination by `total`, no request signing beyond the four
  auth modes.

7. Next recommended phase
- Phase 7 — External plugin SDK & plugin host.
```

```
PHASE: 7 — External plugin SDK & plugin host
STATUS: completed (verified end-to-end with a real child process and the crash-isolation fixture;
no OS-level sandbox or package signing)

1. Implemented
- Manifest (`udmt-plugin.json`) schema and validator: id/version/protocol/runtime/permissions/provider
  metadata (`display_name`, `capabilities`, `config_fields`). Unknown protocol versions and malformed
  manifests are refused before anything is installed.
- Versioned wire protocol `udmt-provider/1`: newline-delimited JSON-RPC 2.0 over stdio with
  `initialize`, `provider.testConnection`, `discoverResources`, `readSchema`, `readBatch`,
  `writeBatch`, `provider.cancel` and `shutdown`. Documented in
  `docs/provider-contract/external-plugin-protocol-v1.md`.
- Process host (`PluginProcess`): spawns without a shell, per-call timeout, abort-signal cancellation,
  bounded/redacted diagnostics, and crash isolation (a dead process rejects only its own calls).
- `ExternalProvider` adapts the protocol to the existing provider contract, so external providers work
  in connection test, discovery, schema, export, import and sync without touching the engine.
  `readBatch` is looped into the contract's async generator; `writeRows` is split into `writeBatch`
  calls.
- Trust/permission model: plugins install disabled and untrusted, can only be enabled after trust, and
  grant at most the permissions they requested. Registered as `plugin:<id>` so they can never shadow a
  built-in provider. See `docs/security/plugin-trust-model.md`.
- Lifecycle surfaces: install / update / enable / disable / trust / untrust / remove / test, exposed in
  `UdmtApp`, the CLI (`udmt plugin ...`), REST (`/api/plugins`, `/api/plugins/:id`,
  `/api/plugins/:id/update`, `/api/plugins/:id/test`) and a GUI Plugins page (list, install by folder,
  permission-grant modal, enable switch, test, update, guarded remove) with en/vi locales.
- Developer sample: `plugins/sample-jsonapi/` (in-memory dataset, paginated reads, write echo,
  required-field validation) plus a deliberate crash fixture under `tests/fixtures/plugins/crash/`.

2. Files changed
- `src/core/plugins/{manifest,host,provider}.ts` (new), `src/core/types.ts`, `src/core/errors.ts`
  (`ERROR_CODES`/`isErrorCode`), `src/core/db/{migrations,store}.ts`, `src/core/providers/registry.ts`
  (register/remove), `src/core/service.ts`, `src/cli/bin.ts`, `src/api/server.ts`,
  `app/{pages/plugins.vue,layouts/default.vue,types.ts,i18n/locales/*}`,
  `plugins/sample-jsonapi/*` (new), `tests/fixtures/plugins/crash/*` (new),
  `tests/integration/plugin-host.test.ts` (new),
  `docs/provider-contract/external-plugin-protocol-v1.md` (new), `docs/security/plugin-trust-model.md`
  (new), this file, `docs/database/schema-and-migrations.md`, `docs/testing/provider-contract-tests.md`,
  `docs/architecture/target-architecture.md`.

3. Database migrations
- v5 `external-plugins` creates `plugins` (manifest, install path, enabled/trusted, requested/granted
  permissions, status, last error/handshake). New and additive.

4. Tests executed
- `pnpm run typecheck` clean; `pnpm test` 83/83 passing; `pnpm run check:i18n` clean; server + GUI build.
- Integration (7): install-no-exposure, enable-before-trust refusal, unrequested-permission refusal,
  trust+enable registration with a granted subset, malformed manifest / future protocol rejection,
  handshake+discover+export(25 rows)+import(25 rows) through the real engine with the secret kept out
  of diagnostics, crash isolation (plugin dies, built-in SQLite still connects), and remove/unregister.

5. Manual verification
- The sample plugin is a real Node child process; the integration suite runs it end-to-end through the
  same `UdmtApp` paths the GUI/CLI use (export produced a verified 25-row artifact, which was imported
  into SQLite).
- Crash fixture (`process.exit(3)`) reported `CONNECTION_FAILED` with "stopped unexpectedly"; the
  subsequent SQLite connection test succeeded, proving the core/GUI path survives a plugin crash.

6. Known limitations / risks
- No OS-level sandbox: a trusted plugin has the same machine rights as the core. Trust is a user
  decision; the manifest is declarative and capabilities can be over-claimed.
- No plugin package/signature verification, registry, or auto-update; install references a local folder.
- One process per plugin provider, started lazily and shared across connections; a hung call is bounded
  by the 30 s timeout but a plugin that ignores cancellation can keep running until stopped.
- `readBatch`/`writeBatch` transfer rows as JSON arrays, so very wide/large batches increase memory and
  IPC size; the engine's batch size still applies.
- Deterministic contract-test harness for third-party authors is the protocol doc + sample plugin +
  the host integration test; there is no separate `udmt plugin test-suite` command yet.

7. Next recommended phase
- Phase 8 — Incremental sync, CDC and advanced replication.
```

```
PHASE: GUI (roadmap section 14, delivered with Phase 1–3)
STATUS: completed for the implemented features

1. Implemented
- Nuxt 4 SPA + Nuxt UI v4 dashboard shell, dark-first, styled after the tm-studio admin template.
- Pages: Overview, Connections (add/edit/test/discover/schema/delete), Export, Import, Operations,
  Artifacts, Schedules, System.
- Capability-aware forms, destructive confirmations, live progress, log tail, prune preview.
- Lucide icons are bundled into the client build (`icon.clientBundle`) — the GUI never calls
  `api.iconify.design`, so it works offline.
- Documentation centre at `/docs` (menu item “Documentation”): markdown articles with frontmatter from
  `app/docs/*.md`, grouped by section, searchable across title/description/tags/body, prev/next links and
  deep-linkable routes (`/docs/<slug>`); rendered with `marked`, content bundled at build time.
- Served on loopback port **4004** by default (`udmt gui --port ...` to change).

2. Files changed
- app/**

3. Database migrations
- none

4. Tests executed
- `nuxt generate` build succeeds
- Manual browser checks: dashboard, connections schema slideover, export run → artifact panel,
  import run → result counters; API calls 200, zero console errors.
- Offline check: reloaded the generated build and inspected the network log — icons arrive as inline
  `data:image/svg+xml` payloads, no request to any external icon CDN.
- Documentation centre checked in the browser: `/docs` redirects to the first article, 10 seeded
  articles across 5 sections render (headings, tables, code blocks, blockquote), search for “worker”
  narrows to 3 articles and their sections, active item is highlighted, and a hard reload of
  `/docs/ket-noi-du-lieu` returns 200 through the SPA fallback. Zero console errors.

5. Manual verification
- Exported 100 rows from a real SQLite target; artifact verified; imported the same artifact
  through the GUI (100 read / 100 written).
- Edited a connection in the GUI (description persisted, modal closed, list reloaded, no console errors).

6. Known limitations / risks
- No authentication (loopback-only API + Host/Origin checks). Not intended for network exposure.
- No virtualized log rendering yet (bounded to 500 lines by the API).
- Nuxt dev server (port 4320) needs `udmt serve` running for `/api`.
- Connection `config.path` is resolved at save time, so a moved database file must be re-pointed
  (`udmt connection update <name> --path ...`). The error now names the missing absolute path instead
  of the raw driver message.

7. Next recommended phase
- Phase 5 Data Sync, or code signing + auto-update for the desktop build.
```

## Phase 8 — Desktop packaging (Tauri v2)

```
PHASE: Desktop shell (roadmap section 14 / Phase 8 'packaging')
STATUS: completed and built end-to-end on Windows

1. Implemented
- `src-tauri/` Tauri v2 shell: picks the first free port in 4004..4019, spawns the bundled core with
  CREATE_NO_WINDOW, waits for `/api/health` (`"app":"udmt"`), then opens the window on that URL.
- No IPC: one loopback HTTP facade serves the SPA and `/api` for the browser GUI, CLI and desktop app.
- Core is bundled by esbuild into `runtime/udmt-core.cjs`; the payload also ships `node.exe` and the
  static Nuxt build, so the app needs no system Node and no `node_modules`.
- Shutdown hook kills the core when the last window closes; startup failures show an error window with
  the reason and log path instead of a silent blank screen.

2. Files changed
- `src-tauri/**` (config + `tauri.{windows,linux,macos}.conf.json`, icons, Rust shell),
  `scripts/desktop.mjs` (cross-platform orchestrator), `scripts/prepare-desktop.mjs`,
  `src/api/server.ts` (UDMT_UI_DIR + opt-in access log),
  `src/core/db/sqlite-driver.ts` (CJS-bundle safe `createRequire`), package.json scripts.

3. Database migrations
- none

4. Tests executed
- `cargo test --lib`: 4/4 (urlencode, free-port selection, health probe, node fallback).
- `pnpm run check`: typecheck + 44/44 vitest + build.
- `pnpm run desktop` (tsc + `nuxt generate` + runtime bundle + `tauri build`): installer produced,
  23.48 MiB, `UDMT_0.1.0_x64-setup.exe`, exit 0, artifacts listed by the script.
- Cross-target guard: `prepare-desktop.mjs --target=linux` and `--target=mac` on Windows exit 1 with an
  explicit "build on the target OS" message; an unknown target is rejected too.
- `pnpm run desktop -- --skip-frontend` verified separately (Rust + payload only).
- Linux/macOS bundle targets are configured (`deb`+`appimage`, `app`+`dmg`) but were **not built** here:
  no Linux/macOS machine in this environment.

5. Manual verification (release build, real window)
- Window opens with title `UDMT — Universal Data Manager`; shell log reports `health: ok`.
- With `UDMT_ACCESS_LOG=1`, the core log shows the WebView2 user agent requesting `/`, every `_nuxt`
  chunk and the polling `/api/health`, `/api/worker`, `/api/runs`, `/api/artifacts` — the packaged UI
  really renders against the bundled core (98 webview requests in the first run).
- Closing the window exits the shell, kills the core and releases the port (verified: 0 shell
  processes, 0 core processes, port free).
- Early-crash path verified by pointing the app at an unwritable data dir: error window with reason
  instead of a 45 s hang.

6. Known limitations / risks
- Installer is unsigned: SmartScreen warns on first run; no auto-updater.
- Force-killing the shell (Task Manager) leaves the core running — no exit hook runs.
- Only the Windows build was produced here.

7. Next recommended phase
- Phase 5 Data Sync engine, or code signing + auto-update for distribution.
```

## Overall quality-gate check (roadmap 20.7)

| Gate | Result |
|---|---|
| Release target builds | ✅ `pnpm run build` + `nuxt generate` + `tauri build` (NSIS installer) |
| Important tests pass | ✅ 76/76 vitest + 4/4 cargo |
| UI actions wired to a real backend | ✅ no mock data in the app |
| Task state persisted | ✅ SQLite runs/logs |
| No secret in logs/DB plaintext | ✅ tested |
| Errors classified/explicable | ✅ typed codes in CLI/API/UI |
| Migration regression | ✅ legacy import test |
| Destructive actions gated | ✅ confirm + dry-run |

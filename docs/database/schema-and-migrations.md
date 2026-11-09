# Metadata database: schema and migrations

Engine: SQLite via `node:sqlite`. WAL journal, `foreign_keys=ON`, `busy_timeout=5000`.
Location: `<data-dir>/udmt.db` (`UDMT_DATA_DIR` overrides the data dir).

## Tables (version 1–3)

| Table | Purpose |
|---|---|
| `schema_migrations` | applied versions (patched with `applied_at` for old DBs) |
| `connections` | name, provider, service profile, non-secret config, `credential_ref`, environment, test state |
| `secrets` | encrypted credential payloads (AES-256-GCM) |
| `storage_backends` | artifact backends (`local`, `s3`), sanitized endpoint hint and last test state; `local-default` is seeded |
| `jobs` | reusable export/import job definitions (schedulable) |
| `job_schedules` | type/config/timezone/misfire/overlap/next_run_at |
| `operation_runs` | durable run state, progress, result, error, worker id |
| `operation_logs` | per-run sequenced log lines |
| `artifacts` | catalog: file, manifest, size, checksum, verification, pin, expiry |
| `task_locks` | local leases for worker/schedule/connection scopes |
| `worker_instances` | pid, host, version, heartbeat, task count, last error |
| `settings` | small key/value store |
| `audit_events` | sanitized actions (connection changes, retention deletions…) |
| `legacy_imports` | raw rows preserved from the pre-UDMT schema |

Indexes: run list/status, logs by run, artifacts by creation/expiry, schedules due.

Migration v3 (`storage-backend-health`) adds `endpoint_hint`, `last_tested_at` and `last_test_status` to
`storage_backends`; it is additive and idempotent for pre-existing catalogs.

## Migration policy

- Versions are applied inside a transaction and recorded; re-running is idempotent.
- Startup failure closes the DB handle (no locked files after a failed migration).
- **Legacy import (roadmap 11.3)**: if `connections` has `provider` and no `provider_id`, the old tables
  are renamed (`connections_legacy_v0`, `operation_logs_legacy_v0`), the new schema is created, then:
  - providers are mapped (`supabase` → `postgresql/supabase`, `atlas` → `mongodb/mongodb_atlas`, …),
  - old operation logs become `operation_runs` + log entries with a `LEGACY_FAILED` marker when needed,
  - the raw rows (including the unreadable `uri_encrypted`) are kept in `legacy_imports`,
  - the connection is kept and flagged for re-authentication instead of being dropped.
- Covered by a test that builds a legacy DB and asserts connections + history survive.

## Where writes happen

Only `Store` (repositories) writes. Providers never touch metadata. CLI, API and worker all go through
`UdmtApp` → `Store`, so there is a single writer path and no competing state updates.

## Backup of the metadata DB

The DB is small and uses WAL. Copying `udmt.db` while the app is stopped is safe; while running, use
SQLite's backup API or copy `udmt.db`, `-wal` and `-shm` together. (A built-in "backup my metadata"
command is not implemented.)

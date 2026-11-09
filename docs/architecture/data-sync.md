# Data sync engine (Phase 5)

The sync engine moves rows from a source provider/resource to a target provider/resource. It reuses the
provider contract (`schema_read`, `read_data`, `write_data`) and the durable operation engine; there is
no sync-only database driver and no provider-specific code in the orchestrator.

## Pipeline definition

A pipeline is persisted in `sync_pipelines`:

| Field | Meaning |
|---|---|
| `source_connection_id` / `target_connection_id` | Existing connections (must be active at run time) |
| `source_resource` / `target_resource` | Table, collection or file resource name |
| `mapping` | Array of field rules; empty means "map every source column by name" |
| `load_mode` | `append`, `upsert`, `truncate_and_load`, `replace_resource` |
| `key_columns` | Target columns forming the upsert key (required for `upsert`) |
| `options` | filter, batch size, row-error policy, retry, dry-run, `create_resource`, row limit |
| `enabled` | Disabled pipelines refuse to start |

`replace_resource` is an alias normalized to `truncate_and_load` at the service boundary. It truncates
and loads the target resource; it does **not** drop/recreate the resource.

## Mapping and transforms

Mapping rules are compiled once, after the source schema is read:

```json
[
  { "source": "id", "target": "person_id" },
  { "source": "name", "target": "full_name", "trim": true },
  { "source": "email", "target": "email_address", "mask": "email" },
  { "source": "age", "target": "age", "cast": "integer", "default": 18 }
]
```

- Without explicit `cast`, the target type is inherited from the source column.
- Transform order is deterministic: default → trim → value map → cast → mask.
- Nested JSON values can be read with dotted paths (`profile.city`).
- Lossy conversions fail with `CAST_FAILED` (for example `12.5` to integer, or an integer outside the
  exactly representable JS number range) instead of writing a silently corrupted value.
- Masks: `email` (`a***@example.com`), `last4` (`***5678`), `full` (`***`).

Filters run before transforms and support `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`,
`is_null` and `not_null`.

## Execution and safety

1. Validate the request, pipeline, connections and capabilities
   (`read_data` + `schema_read` on the source, `write_data` on the target).
2. Read the source and optional target schema; compile the mapping and warn about missing target
   columns or unknown types.
3. Require `confirm === target.name` for `truncate_and_load` and for any non-append load into a
   connection whose environment is `production`. A rejected preflight never truncates.
4. Stream source batches into the target provider's `writeRows`; progress, logs, cancellation and
   terminal state are the normal durable run records.
5. Persist row errors (capped at 500 per run) and the checkpoint in `sync_states`.

Row-error policy:

- `fail` (default): stop at the first bad row and fail the run with `SYNC_ROW_ERROR` including the row
  index.
- `skip`: persist the error, count the row as skipped, keep going, and finish
  `completed_with_warnings`.

Retries are opt-in through `options.retry`. A full-pipeline retry only happens for idempotent modes
(`upsert`, `truncate_and_load`) and transient errors; `append` is never retried. Written batches are
not rolled back before a retry.

Dry run (`sync validate`, `dry_run: true`) samples up to 1,000 rows, applies filters and transforms,
reports matched rows and error samples, writes nothing and does not update the checkpoint.

## Checkpoint state

A full run stores a summary:

```json
{
  "checkpoint_version": 1,
  "kind": "full",
  "completed_at": "...",
  "rows_read": 120,
  "rows_written": 90,
  "rows_filtered": 30
}
```

A failed run stores a `partial: true` snapshot with the failure time.

## Incremental (watermark) sync

Set `options.incremental = { column, initial? }` on a pipeline to sync only new rows:

```json
{ "incremental": { "column": "id" }, "batch_size": 500 }
```

- Requires the source provider to declare the `incremental_read` capability (SQLite does; the other
  built-ins do not yet). Otherwise the run fails with `CAPABILITY_UNSUPPORTED` — the engine never
  falls back to a full read silently.
- The provider reads `WHERE column > after ORDER BY column ASC`; `after: null` reads everything.
- The highest value seen is stored as `checkpoint.watermark` with `kind: "incremental"` **only after a
  successful run**, so a failure replays the same window:

```json
{
  "checkpoint_version": 1,
  "kind": "incremental",
  "column": "id",
  "watermark": { "column": "id", "value": 110 },
  "completed_at": "...",
  "rows_read": 10,
  "rows_written": 10
}
```

- Incremental cannot be combined with `truncate_and_load` (rejected at pipeline creation).
- `udmt sync reset <pipeline>` / `POST /api/sync/pipelines/:id/reset` clears the checkpoint to replay.
- Limitation: the watermark assumes a monotonic column. In-place updates to old rows are not seen; use
  `upsert` with `conflict_policy` or a full sync for those.

## Conflict policy and schema evolution

- `options.conflict_policy`: `overwrite` (default) or `ignore`. For `upsert`, `ignore` skips existing
  keys (`ON CONFLICT DO NOTHING` on SQLite); skipped keys are counted and the run ends
  `completed_with_warnings`.
- `options.schema_evolution`: `ignore` (default) or `add_columns`. `add_columns` lets a capable provider
  add missing target columns (`ALTER TABLE ... ADD COLUMN` on SQLite) instead of ignoring them.

CDC/change streams and replication lag metrics are not implemented; no provider declares them.

## Surfaces

- Core: `UdmtApp.createSyncPipeline/updateSyncPipeline/deleteSyncPipeline/runSync/validateSyncPipeline/
  syncState/syncErrors`.
- Worker: `operation_type: sync` jobs created with `job add-sync` (optionally scheduled).
- CLI: `udmt sync pipeline list|inspect|create|update|remove`,
  `udmt sync run|validate|state|errors`.
- REST: `/api/sync/pipelines`, `/api/sync/pipelines/:id`, `.../run`, `.../validate`, `.../state`,
  `/api/runs/:id/errors`.
- GUI: Sync page with pipeline CRUD, JSON mapping/options, dry-run validation, confirmed real runs and
  a state/error drawer.

## Verified scope and limitations

End-to-end verification is SQLite→SQLite (real files, real metadata DB, scheduled worker run). Other
providers go through the same contract but were not exercised against live servers here. See the
Phase 5 report in `docs/IMPLEMENTATION-STATUS.md` for the exact test list and remaining risks.

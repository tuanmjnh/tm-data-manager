# Testing strategy

Run with `pnpm test` (vitest). Current suite: **76 tests**, ~15 s, no external services required (the
REST and S3 integration tests start their own local HTTP servers).

## Unit

| File | Covers |
|---|---|
| `tests/unit/state-machine.test.ts` | legal/illegal run transitions, terminal immutability, dry-run shortcut |
| `tests/unit/scheduler.test.ts` | interval/daily/weekly/monthly/once, UTC + Asia/Ho_Chi_Minh, DST spring-forward, monthly day-31 clamp, invalid timezone/config |
| `tests/unit/formats.test.ts` | JSONL/CSV/JSON round trips, gzip, CSV escaping of quotes/commas, nested JSON, malformed JSON rejection, type coercion |
| `tests/unit/paths.test.ts` | path traversal/symlink-escape rejection, NUL bytes, unsafe segments, log/endpoint redaction |
| `tests/unit/sqlite-provider.test.ts` | create table with PK, streaming read, upsert idempotency, not-found error, cancellation |
| `tests/unit/storage-signing.test.ts` | S3 SigV4 canonical request, locator parsing, config/prefix validation |
| `tests/unit/sync-pipeline.test.ts` | mapping defaults, unknown-source/duplicate-target rejection, transform order, lossy-cast rejection, masks, dotted paths, all filter operators |
| `tests/unit/formats-xml-xlsx.test.ts` | XML typed/nested/null/escaped round trip, generic XML parsing, XLSX write+read with coercion, XLSX gzip rejection |

## Integration

`tests/integration/roundtrip.test.ts` — real SQLite source/target databases in a temp dir:

- 250-row export to gzipped JSONL, manifest/checksum assertions, verification.
- Import by artifact id, row count verified in the target database.
- Upsert twice → count unchanged.
- `truncate_and_load` without confirmation → `CONFIRMATION_REQUIRED`; with `confirm` → succeeds.
- Dry run does not create the target table.
- Tampered artifact → verification fails, run marked failed.
- Raw CSV import into a new table with inferred types.
- A password is not present in the SQLite file bytes (secret vault check).
- Missing resource → failed run with a sanitized message.
- Retention preview never deletes a pinned artifact.
- Editing a connection keeps the stored secret, can rename, and rotates the password only when one
  is supplied.

`tests/integration/sync.test.ts` — SQLite→SQLite sync pipelines: append, mapping/trim/cast/mask/filter,
upsert idempotency, `truncate_and_load` confirmation, `on_error=skip`/`fail`, dry run, key validation.

`tests/integration/storage-s3.test.ts` — a local HTTP endpoint speaking the S3 wire format: publish,
list, download, delete, export→S3→catalog→import round trip, delete protection.

`tests/integration/rest-connector.test.ts` — a local JSON HTTP API: config secrecy, authenticated
paginated connection test, 401 without leaking the secret, API key in a header, missing-credential
rejection, and REST → artifact → SQLite import over multiple pages.

`tests/integration/migrations.test.ts` — fresh DB is versioned and idempotent; a legacy
`connections`/`operation_logs` schema is migrated without losing rows, mapped to
`postgresql/supabase` and `mongodb/mongodb_atlas`, with raw legacy rows preserved.

## Not covered (honest gaps)

- PostgreSQL, MySQL and MongoDB adapters are **not** covered by automated tests here because no server
  is available in this environment. Their queries are validated only by typechecking and by manual
  review; run `udmt connection test`, `discover`, `export`, `import` against a disposable database
  before relying on them.
- No Tauri packaging tests (Tauri is not used in this build — see ADR-002).
- Worker crash/kill tests are not automated; recovery is implemented and can be exercised with
  `udmt worker once` after killing a run.
- GUI is verified manually (export and import flows exercised in a real browser) and via the Nuxt build,
  not with a Playwright suite.

## Contract test checklist for a new provider

1. `validateConfig` rejects malformed input with `INVALID_CONFIG`.
2. `testConnection` returns a server version and distinguishes auth vs network failures.
3. `discoverResources` lists the resources the descriptor promises.
4. `readSchema` returns canonical column types and primary keys.
5. `readRows` streams in batches, respects `limit`, and stops on cancellation.
6. `writeRows` supports every declared mode; upsert keeps the row count stable.
7. Errors are typed and sanitized; no credentials in messages.

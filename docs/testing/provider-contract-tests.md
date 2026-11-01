# Testing strategy

Run with `npm test` (vitest). Current suite: **43 tests**, ~13 s, no external services required.

## Unit

| File | Covers |
|---|---|
| `tests/unit/state-machine.test.ts` | legal/illegal run transitions, terminal immutability, dry-run shortcut |
| `tests/unit/scheduler.test.ts` | interval/daily/weekly/monthly/once, UTC + Asia/Ho_Chi_Minh, DST spring-forward, monthly day-31 clamp, invalid timezone/config |
| `tests/unit/formats.test.ts` | JSONL/CSV/JSON round trips, gzip, CSV escaping of quotes/commas, nested JSON, malformed JSON rejection, type coercion |
| `tests/unit/paths.test.ts` | path traversal/symlink-escape rejection, NUL bytes, unsafe segments, log/endpoint redaction |
| `tests/unit/sqlite-provider.test.ts` | create table with PK, streaming read, upsert idempotency, not-found error, cancellation |

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

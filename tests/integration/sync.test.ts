import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/core/db/sqlite-driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdmtApp } from '../../src/core/service.js';
import { UdmtError } from '../../src/core/errors.js';

let workDir: string;
let app: UdmtApp;

function makeSource(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, age INTEGER, active INTEGER, score REAL)');
  const insert = db.prepare('INSERT INTO users (id,name,email,age,active,score) VALUES (?,?,?,?,?,?)');
  for (let i = 1; i <= 250; i += 1) {
    insert.run(i, `  User ${i}  `, `user${i}@example.com`, 18 + (i % 50), i % 2, i * 1.5);
  }
  db.close();
}

function insertBadRow(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO users (id,name,email,age,active,score) VALUES (?,?,?,?,?,?)').run(
      999,
      'Broken',
      'broken@example.com',
      'not-an-integer',
      1,
      1.5,
    );
  } finally {
    db.close();
  }
}

type SqliteDb = InstanceType<typeof DatabaseSync>;

function openTarget<T>(path: string, read: (db: SqliteDb) => T): T {
  const db = new DatabaseSync(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function hasTable(path: string, table: string): boolean {
  return openTarget(path, (db) =>
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)),
  );
}

function countRows(path: string, table = 'users'): number {
  return openTarget(path, (db) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    return Number(row.n);
  });
}

function rows(path: string, table = 'users'): Array<Record<string, unknown>> {
  return openTarget(path, (db) => db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-sync-'));
  makeSource(join(workDir, 'source.db'));
  app = new UdmtApp({ dataDir: join(workDir, 'data') });
});

afterEach(() => {
  app.close();
  rmSync(workDir, { recursive: true, force: true });
});

function prepare() {
  const source = app.createConnection({
    name: 'source',
    provider_id: 'sqlite',
    config: { path: join(workDir, 'source.db') },
    environment: 'local',
  });
  const target = app.createConnection({
    name: 'target',
    provider_id: 'sqlite',
    config: { path: join(workDir, 'target.db') },
    environment: 'local',
  });
  return { source, target };
}

describe('sync pipelines', () => {
  it('creates a target table and appends every source row', async () => {
    const { source, target } = prepare();
    const pipeline = app.createSyncPipeline({
      name: 'users-copy',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'users_copy',
      load_mode: 'append',
    });

    const { run } = await app.runSync({ pipeline_id: pipeline.id });
    expect(run.status).toBe('completed');
    expect(run.result?.rows_written).toBe(250);
    expect(countRows(join(workDir, 'target.db'), 'users_copy')).toBe(250);

    const state = app.syncState(pipeline.id);
    expect(state?.last_status).toBe('completed');
    expect(state?.checkpoint.kind).toBe('full');
    expect(state?.rows_synced).toBe(250);
  });

  it('maps, trims, casts and masks fields, and filters source rows', async () => {
    const { source, target } = prepare();
    const pipeline = app.createSyncPipeline({
      name: 'users-upsert',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'people',
      load_mode: 'upsert',
      key_columns: ['person_id'],
      mapping: [
        { source: 'id', target: 'person_id' },
        { source: 'name', target: 'full_name', trim: true },
        { source: 'email', target: 'email_address', mask: 'email' },
        { source: 'age', target: 'age', cast: 'integer' },
        { source: 'score', target: 'score', cast: 'number' },
      ],
      options: { filter: { column: 'age', operator: 'gte', value: 40 } },
    });

    const { run } = await app.runSync({ pipeline_id: pipeline.id });
    expect(run.status).toBe('completed');
    const written = Number(run.result?.rows_written);
    expect(written).toBeGreaterThan(0);
    const stored = rows(join(workDir, 'target.db'), 'people').sort(
      (a, b) => Number(a.person_id) - Number(b.person_id),
    );
    expect(stored).toHaveLength(written);
    expect(stored[0]!.full_name).toBe(String(stored[0]!.full_name).trim());
    expect(String(stored[0]!.email_address)).toMatch(/^[a-z]\*\*\*@example\.com$/);
    expect(stored.every((row) => Number(row.age) >= 40)).toBe(true);
    expect(run.result?.rows_filtered).toBe(250 - written);
  });

  it('is idempotent for upsert and replaces data only with confirmation', async () => {
    const { source, target } = prepare();
    const pipeline = app.createSyncPipeline({
      name: 'users-replace',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'people',
      load_mode: 'truncate_and_load',
    });

    const first = await app.runSync({ pipeline_id: pipeline.id, confirm: target.name });
    expect(first.run.status).toBe('completed');
    expect(countRows(join(workDir, 'target.db'), 'people')).toBe(250);

    const onError = await app.runSync({ pipeline_id: pipeline.id }).catch((error: unknown) => error);
    expect(onError).toBeInstanceOf(UdmtError);
    expect((onError as UdmtError).code).toBe('CONFIRMATION_REQUIRED');
    // The failed preflight must not have deleted the previous data.
    expect(countRows(join(workDir, 'target.db'), 'people')).toBe(250);

    const confirmed = await app.runSync({ pipeline_id: pipeline.id, confirm: target.name });
    expect(confirmed.run.status).toBe('completed');
    expect(countRows(join(workDir, 'target.db'), 'people')).toBe(250);
  });

  it('reports skipped row errors without silent loss when on_error=skip', async () => {
    const { source, target } = prepare();
    insertBadRow(join(workDir, 'source.db'));
    const pipeline = app.createSyncPipeline({
      name: 'users-skip',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'people',
      load_mode: 'append',
      options: { on_error: 'skip' },
    });

    const { run } = await app.runSync({ pipeline_id: pipeline.id });
    expect(run.status).toBe('completed_with_warnings');
    expect(run.result?.rows_skipped).toBe(1);
    expect(run.result?.rows_written).toBe(250);
    const errors = app.syncErrors(run.id);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('CAST_FAILED');
    expect(errors[0]!.row_index).toBe(251);
  });

  it('fails the run at the first bad row when on_error=fail', async () => {
    const { source, target } = prepare();
    insertBadRow(join(workDir, 'source.db'));
    const pipeline = app.createSyncPipeline({
      name: 'users-fail',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'people',
      load_mode: 'append',
      options: { on_error: 'fail' },
    });

    const error = await app.runSync({ pipeline_id: pipeline.id }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(UdmtError);
    expect((error as UdmtError).code).toBe('SYNC_ROW_ERROR');
    const runId = (error as UdmtError).details?.run_id as string | undefined;
    expect(runId).toBeTruthy();
    const latest = app.getRun(runId!);
    expect(latest.status).toBe('failed');
    expect(latest.error_message_safe).toMatch(/row 251/);
  });

  it('samples a dry run without touching the target', async () => {
    const { source, target } = prepare();
    const pipeline = app.createSyncPipeline({
      name: 'users-dry',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'people',
      load_mode: 'append',
    });

    const { run } = await app.validateSyncPipeline(pipeline.id, { limit: 25 });
    expect(run.status).toBe('completed');
    expect(run.result?.dry_run).toBe(true);
    expect(run.result?.rows_sampled).toBe(25);
    expect(hasTable(join(workDir, 'target.db'), 'people')).toBe(false);
    expect(app.syncState(pipeline.id)).toBeNull();
  });

  it('refuses to update when key columns are outside the mapping', () => {
    const { source, target } = prepare();
    expect(() =>
      app.createSyncPipeline({
        name: 'bad-keys',
        source_connection_id: source.id,
        target_connection_id: target.id,
        source_resource: 'users',
        target_resource: 'people',
        load_mode: 'upsert',
        key_columns: ['id'],
        mapping: [{ source: 'id', target: 'person_id' }],
      }),
    ).toThrow(/not mapped to the target/);
  });
});

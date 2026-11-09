import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/core/db/sqlite-driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdmtApp } from '../../src/core/service.js';

let workDir: string;
let app: UdmtApp;

function createSource(path: string, startId: number, count: number, note = 'n'): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)');
  const insert = db.prepare('INSERT INTO users (id,name,note) VALUES (?,?,?)');
  for (let i = 0; i < count; i += 1) {
    const id = startId + i;
    insert.run(id, `User ${id}`, `${note}-${id}`);
  }
  db.close();
}

function countRows(path: string, table = 'users'): number {
  const db = new DatabaseSync(path);
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function single(path: string, id: number, table = 'users'): Record<string, unknown> | undefined {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

function columnNames(path: string, table: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((col) => col.name);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-incremental-'));
  app = new UdmtApp({ dataDir: join(workDir, 'data') });
});

afterEach(() => {
  app.close();
  rmSync(workDir, { recursive: true, force: true });
});

function connections() {
  const source = app.createConnection({
    name: 'inc-source',
    provider_id: 'sqlite',
    config: { path: join(workDir, 'source.db') },
    environment: 'local',
  });
  const target = app.createConnection({
    name: 'inc-target',
    provider_id: 'sqlite',
    config: { path: join(workDir, 'target.db') },
    environment: 'local',
  });
  return { source, target };
}

describe('incremental watermark sync (Phase 8)', () => {
  it('only reads rows past the stored watermark on the next run', async () => {
    createSource(join(workDir, 'source.db'), 1, 100);
    const { source, target } = connections();
    const pipeline = app.createSyncPipeline({
      name: 'users-incremental',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'users',
      load_mode: 'append',
      options: { incremental: { column: 'id' }, batch_size: 25 },
    });

    const first = await app.runSync({ pipeline_id: pipeline.id });
    expect(first.run.status).toBe('completed');
    expect(first.run.result?.rows_read).toBe(100);
    expect(first.run.result?.rows_written).toBe(100);
    const state = app.syncState(pipeline.id);
    expect(state?.checkpoint.kind).toBe('incremental');
    expect((state?.checkpoint.watermark as { column: string; value: number }).value).toBe(100);
    expect(countRows(join(workDir, 'target.db'))).toBe(100);

    createSource(join(workDir, 'source.db'), 101, 10, 'new');
    const second = await app.runSync({ pipeline_id: pipeline.id });
    expect(second.run.status).toBe('completed');
    expect(second.run.result?.rows_read).toBe(10);
    expect(second.run.result?.rows_written).toBe(10);
    expect(countRows(join(workDir, 'target.db'))).toBe(110);
    expect((app.syncState(pipeline.id)?.checkpoint.watermark as { value: number }).value).toBe(110);
  });

  it('replays from scratch after the checkpoint is reset', async () => {
    createSource(join(workDir, 'source.db'), 1, 20);
    const { source, target } = connections();
    const pipeline = app.createSyncPipeline({
      name: 'users-replay',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'users',
      load_mode: 'append',
      options: { incremental: { column: 'id' } },
    });

    await app.runSync({ pipeline_id: pipeline.id });
    expect(app.syncState(pipeline.id)?.checkpoint.kind).toBe('incremental');
    app.resetSyncState(pipeline.id);
    expect(app.syncState(pipeline.id)).toBeNull();

    // The same 20 rows are read again because the watermark was cleared.
    const replay = await app.validateSyncPipeline(pipeline.id, { limit: 1000 });
    expect(replay.run.result?.rows_sampled).toBe(20);
  });

  it('honours conflict_policy "ignore" for upserts', async () => {
    createSource(join(workDir, 'source.db'), 1, 5);
    const targetPath = join(workDir, 'target.db');
    const db = new DatabaseSync(targetPath);
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)');
    db.prepare('INSERT INTO users (id,name,note) VALUES (?,?,?)').run(3, 'target-3', 'keep-me');
    db.close();

    const { source, target } = connections();
    const pipeline = app.createSyncPipeline({
      name: 'users-ignore',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'users',
      load_mode: 'upsert',
      key_columns: ['id'],
      options: { conflict_policy: 'ignore' },
    });

    const { run } = await app.runSync({ pipeline_id: pipeline.id });
    // Skipping existing keys is reported as a warning, never silently.
    expect(run.status).toBe('completed_with_warnings');
    expect(run.result?.rows_written).toBe(4);
    expect(run.result?.rows_skipped).toBe(1);
    expect(single(targetPath, 3)?.name).toBe('target-3');
    expect(single(targetPath, 1)?.name).toBe('User 1');
  });

  it('adds missing target columns when schema_evolution is add_columns', async () => {
    createSource(join(workDir, 'source.db'), 1, 3);
    const targetPath = join(workDir, 'target.db');
    const db = new DatabaseSync(targetPath);
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.close();

    const { source, target } = connections();
    const pipeline = app.createSyncPipeline({
      name: 'users-evolve',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: 'users',
      target_resource: 'users',
      load_mode: 'append',
      options: { schema_evolution: 'add_columns' },
    });

    const { run } = await app.runSync({ pipeline_id: pipeline.id });
    expect(run.status).toBe('completed');
    expect(columnNames(targetPath, 'users')).toContain('note');
    expect(single(targetPath, 1)?.note).toBe('n-1');
    expect(countRows(targetPath)).toBe(3);
  });

  it('rejects incremental sync combined with a destructive load mode', () => {
    createSource(join(workDir, 'source.db'), 1, 3);
    const { source, target } = connections();
    expect(() =>
      app.createSyncPipeline({
        name: 'users-bad',
        source_connection_id: source.id,
        target_connection_id: target.id,
        source_resource: 'users',
        target_resource: 'users',
        load_mode: 'truncate_and_load',
        options: { incremental: { column: 'id' } },
      }),
    ).toThrow(/destructive/);
  });

  it('advertises the incremental_read capability on SQLite', () => {
    const descriptor = app.provider('sqlite');
    expect(descriptor.capabilities.find((cap) => cap.id === 'incremental_read')?.supported).toBe(true);
  });
});

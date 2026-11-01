import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/core/db/sqlite-driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdmtApp } from '../../src/core/service.js';
import { UdmtError } from '../../src/core/errors.js';
import type { ArtifactRecord } from '../../src/core/types.js';

let workDir: string;
let app: UdmtApp;

function makeDatabase(path: string, rowCount: number): void {
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, age INTEGER, active INTEGER, score REAL, meta TEXT, created_at TEXT)',
  );
  const insert = db.prepare('INSERT INTO users (id,name,email,age,active,score,meta,created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= rowCount; i += 1) {
    insert.run(
      i,
      `User ${i}`,
      `user${i}@example.com`,
      18 + (i % 50),
      i % 2,
      i * 1.5,
      JSON.stringify({ tier: i % 3 === 0 ? 'gold' : 'basic' }),
      new Date(Date.UTC(2024, 0, (i % 28) + 1)).toISOString(),
    );
  }
  db.close();
}

function countRows(path: string, table = 'users'): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function hasTable(path: string, table: string): boolean {
  const db = new DatabaseSync(path);
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-it-'));
  makeDatabase(join(workDir, 'source.db'), 250);
  app = new UdmtApp({ dataDir: join(workDir, 'data') });
});

afterEach(() => {
  app.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function prepareConnections() {
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

describe('export/import round trip', () => {
  it('exports, verifies and imports a gzipped JSONL artifact', async () => {
    const { source, target } = await prepareConnections();
    const { artifact, run } = await app.exportData({
      connection_id: source.id,
      resource: 'users',
      format: 'jsonl',
      compression: 'gzip',
      batch_size: 50,
    });

    expect(run.status).toBe('completed');
    expect(artifact.manifest.row_count).toBe(250);
    expect(artifact.checksum_value).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.verification_status).toBe('verified');
    expect(existsSync(artifact.absolute_path)).toBe(true);
    expect(existsSync(`${artifact.absolute_path}.manifest.json`)).toBe(true);
    expect(artifact.manifest.columns.map((column) => column.name)).toContain('email');

    const verified = await app.verifyArtifact(artifact.id);
    expect(verified.valid).toBe(true);

    const imported = await app.importData({
      connection_id: target.id,
      resource: 'users',
      source: { artifact_id: artifact.id },
      mode: 'append',
    });
    expect(imported.run.status).toBe('completed');
    expect(imported.run.result?.rows_written).toBe(250);
    expect(countRows(join(workDir, 'target.db'))).toBe(250);
  });

  it('upserts idempotently and keeps row counts stable', async () => {
    const { source, target } = await prepareConnections();
    const { artifact } = await app.exportData({
      connection_id: source.id,
      resource: 'users',
      format: 'jsonl',
      compression: 'none',
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await app.importData({
        connection_id: target.id,
        resource: 'users',
        source: { artifact_id: artifact.id },
        mode: 'upsert',
        key_columns: ['id'],
      });
    }
    expect(countRows(join(workDir, 'target.db'))).toBe(250);
  });

  it('requires explicit confirmation before a destructive import', async () => {
    const { source, target } = await prepareConnections();
    const { artifact } = await app.exportData({
      connection_id: source.id,
      resource: 'users',
      format: 'csv',
      compression: 'none',
    });

    await expect(
      app.importData({
        connection_id: target.id,
        resource: 'users',
        source: { artifact_id: artifact.id },
        mode: 'truncate_and_load',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });

    const confirmed = await app.importData({
      connection_id: target.id,
      resource: 'users',
      source: { artifact_id: artifact.id },
      mode: 'truncate_and_load',
      confirm: 'target',
    });
    expect(confirmed.run.status).toBe('completed');
    expect(countRows(join(workDir, 'target.db'))).toBe(250);
  });

  it('dry run validates without creating the target table', async () => {
    const { source, target } = await prepareConnections();
    const { artifact } = await app.exportData({
      connection_id: source.id,
      resource: 'users',
      format: 'jsonl',
      compression: 'none',
    });

    const dry = await app.importData({
      connection_id: target.id,
      resource: 'fresh_table',
      source: { artifact_id: artifact.id },
      mode: 'append',
      dry_run: true,
    });
    expect(dry.run.status).toBe('completed');
    expect(dry.run.result?.dry_run).toBe(true);
    expect(dry.run.result?.rows_written).toBeUndefined();
    expect(hasTable(join(workDir, 'target.db'), 'fresh_table')).toBe(false);
  });

  it('detects a tampered artifact instead of reporting success', async () => {
    const { source } = await prepareConnections();
    const { artifact } = await app.exportData({
      connection_id: source.id,
      resource: 'users',
      format: 'json',
      compression: 'none',
    });

    appendFileSync(artifact.absolute_path, ' ');
    const result = await app.verifyArtifact(artifact.id);
    expect(result.valid).toBe(false);
    expect(result.run.status).toBe('failed');
    expect(app.getArtifact(artifact.id).verification_status).toBe('failed');
  });

  it('imports a raw CSV file with inferred types and reports the run', async () => {
    const { target } = await prepareConnections();
    const csvPath = join(workDir, 'manual.csv');
    writeFileSync(csvPath, 'id,name,age,active\n1,Alice,30,true\n2,Bob,41,false\n');

    const { run } = await app.importData({
      connection_id: target.id,
      resource: 'people',
      source: { path: csvPath },
      mode: 'append',
      create_resource: true,
    });
    expect(run.result?.rows_read).toBe(2);
    expect(run.result?.rows_written).toBe(2);
    expect(countRows(join(workDir, 'target.db'), 'people')).toBe(2);
  });

  it('keeps the stored secret when config is edited and rotates it on demand', () => {
    const created = app.createConnection({
      name: 'editable',
      provider_id: 'postgresql',
      config: { host: 'db.example.com', port: 5432, database: 'app', user: 'admin', ssl: 'require' },
      secret: { password: 'first-password' },
      environment: 'staging',
    });

    const edited = app.updateConnection(created.id, {
      config: { ...created.config, user: 'admin2' },
      environment: 'production',
      description: 'edited from the GUI',
    });
    expect(edited.config.user).toBe('admin2');
    expect(edited.environment).toBe('production');
    expect(edited.description).toBe('edited from the GUI');
    expect(app.secrets.load(edited.credential_ref).password).toBe('first-password');

    const renamed = app.updateConnection(edited.id, { name: 'editable-renamed', secret: { password: 'second-password' } });
    expect(renamed.name).toBe('editable-renamed');
    expect(app.getConnection('editable-renamed').id).toBe(created.id);
    expect(app.secrets.load(renamed.credential_ref).password).toBe('second-password');
  });

  it('never stores credentials in plaintext in SQLite', () => {
    app.createConnection({
      name: 'secure',
      provider_id: 'postgresql',
      config: { host: 'db.example.com', port: 5432, database: 'app', user: 'admin', ssl: 'require' },
      secret: { password: 'super-secret-value' },
      environment: 'staging',
    });
    const raw = readFileSync(join(workDir, 'data', 'udmt.db'));
    expect(raw.includes(Buffer.from('super-secret-value'))).toBe(false);
    const loaded = app.getConnection('secure');
    expect(JSON.stringify(loaded)).not.toContain('super-secret-value');
  });

  it('rejects export of a missing resource and records a failed run', async () => {
    const { source } = await prepareConnections();
    await expect(
      app.exportData({ connection_id: source.id, resource: 'nope', format: 'jsonl', compression: 'none' }),
    ).rejects.toBeInstanceOf(UdmtError);
    const failed = app.listRuns({ limit: 5 }).find((run) => run.operation_type === 'export');
    expect(failed?.status).toBe('failed');
    expect(failed?.error_message_safe).toBeTruthy();
  });

  it('applies retention only to unpinned expired artifacts', async () => {
    const { source } = await prepareConnections();
    const first = await app.exportData({ connection_id: source.id, resource: 'users', format: 'jsonl', compression: 'none' });
    app.pinArtifact(first.artifact.id, true);

    const preview = await app.cleanupArtifacts({ older_than_days: 0, keep_last: 0, dry_run: true });
    expect(preview.deleted.map((item: ArtifactRecord) => item.id)).not.toContain(first.artifact.id);
    expect(preview.skipped_reasons.some((reason) => reason.includes('pinned'))).toBe(true);
  });
});

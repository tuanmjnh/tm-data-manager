import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/core/db/sqlite-driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdmtApp } from '../../src/core/service.js';
import { openDatabase } from '../../src/core/db/database.js';
import { migrationVersions } from '../../src/core/db/migrations.js';

let workDir: string;
let dataDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-mig-'));
  dataDir = join(workDir, 'data');
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function createLegacySchema(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      uri_encrypted TEXT,
      default_dir TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conn_id TEXT,
      action_type TEXT NOT NULL,
      target_path TEXT,
      status TEXT,
      executed_at TEXT
    );
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO connections (id,name,provider,uri_encrypted,default_dir,created_at) VALUES (?,?,?,?,?,?)').run(
    'legacy-1',
    'atlas-prod',
    'supabase',
    'ciphertext-blob',
    'D:/backups/atlas-prod',
    '2024-05-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO connections (id,name,provider,uri_encrypted,default_dir,created_at) VALUES (?,?,?,?,?,?)').run(
    'legacy-2',
    'mongo-old',
    'atlas',
    null,
    'D:/backups/mongo',
    '2024-06-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO operation_logs (conn_id,action_type,target_path,status,executed_at) VALUES (?,?,?,?,?)').run(
    'legacy-1',
    'backup',
    'D:/backups/atlas-prod/run-1',
    'success',
    '2024-07-01T10:00:00.000Z',
  );
  db.prepare('INSERT INTO operation_logs (conn_id,action_type,target_path,status,executed_at) VALUES (?,?,?,?,?)').run(
    'legacy-1',
    'restore',
    'D:/backups/atlas-prod/run-1',
    'error',
    '2024-07-02T10:00:00.000Z',
  );
  db.close();
}

describe('metadata migrations', () => {
  it('applies versioned migrations once and is idempotent', () => {
    const path = join(workDir, 'fresh.db');
    const db = openDatabase(path);
    expect(migrationVersions(db).length).toBeGreaterThanOrEqual(2);
    db.close();

    const reopened = openDatabase(path);
    expect(migrationVersions(reopened)).toEqual(migrationVersions(reopened));
    // No duplicate legacy tables or default storage rows.
    const backends = reopened.all<{ n: number }>('SELECT COUNT(*) AS n FROM storage_backends');
    expect(backends[0]?.n).toBe(1);
    reopened.close();
  });

  it('imports legacy connections and operation history without data loss', () => {
    createLegacySchema(join(dataDir, 'udmt.db'));
    const app = new UdmtApp({ dataDir });
    try {
      const connections = app.listConnections();
      expect(connections.map((connection) => connection.name).sort()).toEqual(['atlas-prod', 'mongo-old']);

      const supabase = connections.find((connection) => connection.name === 'atlas-prod');
      expect(supabase?.provider_id).toBe('postgresql');
      expect(supabase?.service_profile).toBe('supabase');
      expect(supabase?.description).toContain('Credentials must be re-entered');

      const mongo = connections.find((connection) => connection.name === 'mongo-old');
      expect(mongo?.provider_id).toBe('mongodb');
      expect(mongo?.service_profile).toBe('mongodb_atlas');

      const runs = app.listRuns({ limit: 10 });
      expect(runs.length).toBe(2);
      expect(runs.some((run) => run.status === 'completed')).toBe(true);
      expect(runs.some((run) => run.status === 'failed')).toBe(true);

      // Secrets were unreadable in the legacy schema; the raw blob is preserved.
      const legacy = app.db.all<{ raw_json: string }>("SELECT raw_json FROM legacy_imports WHERE source_table = 'connections_legacy_v0'");
      expect(legacy.some((row) => row.raw_json.includes('ciphertext-blob'))).toBe(true);
    } finally {
      app.close();
    }
  });
});

import type { Db } from './database.js';
import { nowIso } from '../utils.js';

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const V1_TABLES = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  service_profile TEXT NULL,
  config_json TEXT NOT NULL,
  credential_ref TEXT NULL,
  environment TEXT NOT NULL DEFAULT 'local',
  description TEXT NULL,
  default_storage_id TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  endpoint_hint TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_tested_at TEXT NULL,
  last_test_status TEXT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_backends (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  backend_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  credential_ref TEXT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  source_connection_id TEXT NULL REFERENCES connections(id) ON DELETE SET NULL,
  target_connection_id TEXT NULL REFERENCES connections(id) ON DELETE SET NULL,
  storage_backend_id TEXT NULL REFERENCES storage_backends(id) ON DELETE SET NULL,
  operation_config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_schedules (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  schedule_type TEXT NOT NULL,
  schedule_config_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  misfire_policy TEXT NOT NULL DEFAULT 'run_once_on_recovery',
  overlap_policy TEXT NOT NULL DEFAULT 'forbid',
  next_run_at TEXT NULL,
  last_run_at TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON job_schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS operation_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NULL REFERENCES jobs(id) ON DELETE SET NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL,
  source_connection_id TEXT NULL,
  target_connection_id TEXT NULL,
  source_label TEXT NULL,
  target_label TEXT NULL,
  resource TEXT NULL,
  stage TEXT NULL,
  progress_json TEXT NULL,
  config_json TEXT NOT NULL,
  result_json TEXT NULL,
  error_code TEXT NULL,
  error_message_safe TEXT NULL,
  retry_of_run_id TEXT NULL,
  worker_instance_id TEXT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON operation_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON operation_runs(status);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  level TEXT NOT NULL,
  stage TEXT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON operation_logs(run_id, sequence);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  provider_id TEXT NULL,
  storage_backend_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  size_bytes INTEGER NULL,
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  checksum_value TEXT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verified_at TEXT NULL,
  restore_test_status TEXT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS task_locks (
  scope TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  run_id TEXT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_instances (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  last_error TEXT NULL,
  tasks_running INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_imports (
  id TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
`;

function tableColumns(db: Db, table: string): string[] {
  if (!tableExists(db, table)) return [];
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
}

function tableExists(db: Db, table: string): boolean {
  return Boolean(
    db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table),
  );
}

function renameLegacyTables(db: Db): boolean {
  const cols = tableColumns(db, 'connections');
  const isLegacy = cols.length > 0 && cols.includes('provider') && !cols.includes('provider_id');
  if (!isLegacy) return false;
  db.exec('ALTER TABLE connections RENAME TO connections_legacy_v0');
  if (tableExists(db, 'operation_logs')) {
    db.exec('ALTER TABLE operation_logs RENAME TO operation_logs_legacy_v0');
  }
  return true;
}

const PROVIDER_ALIASES: Record<string, { provider_id: string; service_profile: string | null }> = {
  mongo: { provider_id: 'mongodb', service_profile: null },
  mongodb: { provider_id: 'mongodb', service_profile: null },
  atlas: { provider_id: 'mongodb', service_profile: 'mongodb_atlas' },
  'mongodb-atlas': { provider_id: 'mongodb', service_profile: 'mongodb_atlas' },
  postgres: { provider_id: 'postgresql', service_profile: null },
  postgresql: { provider_id: 'postgresql', service_profile: null },
  pg: { provider_id: 'postgresql', service_profile: null },
  supabase: { provider_id: 'postgresql', service_profile: 'supabase' },
  neon: { provider_id: 'postgresql', service_profile: 'neon' },
  mysql: { provider_id: 'mysql', service_profile: null },
  mariadb: { provider_id: 'mysql', service_profile: null },
  sqlite: { provider_id: 'sqlite', service_profile: null },
};

/**
 * Imports rows from the pre-UDMT schema (roadmap 11.3).
 * The old `uri_encrypted` value cannot be decrypted (the legacy key is not
 * available), so it is preserved verbatim in `legacy_imports` and the new
 * connection is flagged for re-authentication instead of being dropped.
 */
function importLegacyRows(db: Db): void {
  if (!tableExists(db, 'connections_legacy_v0')) return;
  const rows = db.all<Record<string, unknown>>('SELECT * FROM connections_legacy_v0');
  const now = nowIso();

  for (const row of rows) {
    const legacyProvider = String(row.provider ?? '').toLowerCase();
    const mapped = PROVIDER_ALIASES[legacyProvider] ?? { provider_id: legacyProvider || 'unknown', service_profile: null };
    const createdAt = String(row.created_at ?? now);
    const config = {
      imported_from_legacy: true,
      legacy_provider: row.provider ?? null,
      default_dir: row.default_dir ?? null,
    };
    db.run(
      `INSERT OR IGNORE INTO connections
       (id, name, provider_id, service_profile, config_json, credential_ref, environment, description,
        default_storage_id, is_active, endpoint_hint, created_at, updated_at, last_tested_at, last_test_status)
       VALUES (?, ?, ?, ?, ?, NULL, 'local', ?, NULL, 1, NULL, ?, ?, NULL, NULL)`,
      String(row.id ?? crypto.randomUUID()),
      String(row.name ?? `legacy-${String(row.id ?? 'connection')}`),
      mapped.provider_id,
      mapped.service_profile,
      JSON.stringify(config),
      'Imported from legacy schema. Credentials must be re-entered.',
      createdAt,
      createdAt,
    );
    db.run(
      'INSERT INTO legacy_imports (id, source_table, raw_json, imported_at) VALUES (?, ?, ?, ?)',
      String(row.id ?? crypto.randomUUID()),
      'connections_legacy_v0',
      JSON.stringify(row),
      now,
    );
  }

  if (tableExists(db, 'operation_logs_legacy_v0')) {
    const logs = db.all<Record<string, unknown>>('SELECT * FROM operation_logs_legacy_v0 ORDER BY id ASC');
    for (const log of logs) {
      const status = /success|completed|ok/i.test(String(log.status ?? '')) ? 'completed' : 'failed';
      const runId = crypto.randomUUID();
      const executedAt = String(log.executed_at ?? now);
      const connectionId = log.conn_id === null || log.conn_id === undefined ? null : String(log.conn_id);
      const targetPath = log.target_path === null || log.target_path === undefined ? null : String(log.target_path);
      db.run(
        `INSERT INTO operation_runs
         (id, job_id, operation_type, status, source_connection_id, target_connection_id, source_label,
          target_label, resource, stage, progress_json, config_json, result_json, error_code,
          error_message_safe, retry_of_run_id, worker_instance_id, started_at, finished_at, created_at)
         VALUES (?, NULL, 'export', ?, ?, NULL, NULL, NULL, ?, NULL, NULL, '{}', ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        runId,
        status,
        connectionId,
        String(log.action_type ?? 'legacy_operation'),
        JSON.stringify({ target_path: targetPath, legacy: true }),
        status === 'failed' ? 'LEGACY_FAILED' : null,
        status === 'failed' ? 'Imported legacy operation marked as failed.' : null,
        executedAt,
        executedAt,
        executedAt,
      );
      db.run(
        'INSERT INTO operation_logs (run_id, sequence, level, stage, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        runId,
        1,
        'info',
        'legacy',
        `Imported legacy operation (${String(log.action_type ?? 'unknown')}) status=${String(log.status ?? 'unknown')}`,
        executedAt,
      );
    }
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-metadata-schema',
    up: (db) => {
      const hadLegacy = renameLegacyTables(db);
      db.exec(V1_TABLES);
      if (hadLegacy) importLegacyRows(db);
      const now = nowIso();
      db.run(
        `INSERT OR IGNORE INTO storage_backends (id, name, backend_type, config_json, credential_ref, is_default, created_at, updated_at)
         VALUES ('local-default', 'Local artifacts', 'local', ?, NULL, 1, ?, ?)`,
        JSON.stringify({ root: 'artifacts' }),
        now,
        now,
      );
    },
  },
  {
    version: 2,
    name: 'run-indexes-for-scheduler',
    up: (db) => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_runs_job ON operation_runs(job_id, created_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_expiry ON artifacts(expires_at)');
    },
  },
  {
    version: 3,
    name: 'storage-backend-health',
    up: (db) => {
      const columns = new Set(tableColumns(db, 'storage_backends'));
      if (!columns.has('last_tested_at')) db.exec('ALTER TABLE storage_backends ADD COLUMN last_tested_at TEXT NULL');
      if (!columns.has('last_test_status')) db.exec('ALTER TABLE storage_backends ADD COLUMN last_test_status TEXT NULL');
      if (!columns.has('endpoint_hint')) db.exec('ALTER TABLE storage_backends ADD COLUMN endpoint_hint TEXT NULL');
    },
  },
];

export function runMigrations(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  // Older builds shipped a two-column migration table; extend it in place
  // instead of failing on a pre-existing user database.
  const migrationColumns = new Set(tableColumns(db, 'schema_migrations'));
  if (!migrationColumns.has('applied_at')) {
    db.exec('ALTER TABLE schema_migrations ADD COLUMN applied_at TEXT');
    db.run('UPDATE schema_migrations SET applied_at = ? WHERE applied_at IS NULL', nowIso());
  }
  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((row) => Number(row.version)),
  );
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', migration.version, migration.name, nowIso());
    });
    count += 1;
  }
  return count;
}

/** Convenience for tests: verify migrations are idempotent. */
export function migrationVersions(db: Db): number[] {
  return db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((row) => Number(row.version));
}

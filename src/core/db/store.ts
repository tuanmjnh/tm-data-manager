import type { Db } from './database.js';
import { assertTransition } from '../state-machine.js';
import { newId, nowIso } from '../utils.js';
import { UdmtError } from '../errors.js';
import type {
  ArtifactManifest,
  ArtifactRecord,
  ConnectionRecord,
  JobRecord,
  OperationLogEntry,
  OperationRun,
  OperationStatus,
  RunProgress,
  PluginRecord,
  ScheduleRecord,
  StorageBackendRecord,
  SyncPipelineRecord,
  SyncRunError,
  SyncStateRecord,
  WorkerInstance,
} from '../types.js';

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type ConnectionRow = {
  id: string;
  name: string;
  provider_id: string;
  service_profile: string | null;
  config_json: string;
  credential_ref: string | null;
  environment: string;
  description: string | null;
  default_storage_id: string | null;
  is_active: number;
  endpoint_hint: string | null;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  last_test_status: string | null;
};

type RunRow = {
  id: string;
  job_id: string | null;
  operation_type: string;
  status: string;
  source_connection_id: string | null;
  target_connection_id: string | null;
  source_label: string | null;
  target_label: string | null;
  resource: string | null;
  stage: string | null;
  progress_json: string | null;
  config_json: string;
  result_json: string | null;
  error_code: string | null;
  error_message_safe: string | null;
  retry_of_run_id: string | null;
  worker_instance_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type ArtifactRow = {
  id: string;
  run_id: string;
  artifact_type: string;
  provider_id: string | null;
  storage_backend_id: string;
  object_key: string;
  absolute_path: string;
  manifest_json: string;
  size_bytes: number | null;
  checksum_algorithm: string;
  checksum_value: string | null;
  verification_status: string;
  verified_at: string | null;
  restore_test_status: string | null;
  created_at: string;
  expires_at: string | null;
  pinned: number;
};

type ScheduleRow = {
  id: string;
  job_id: string;
  schedule_type: string;
  schedule_config_json: string;
  timezone: string;
  misfire_policy: string;
  overlap_policy: string;
  next_run_at: string | null;
  last_run_at: string | null;
  enabled: number;
};

export class Store {
  constructor(readonly db: Db) {}

  // ---------------------------------------------------------------- connections
  listConnections(): ConnectionRecord[] {
    return this.db
      .all<ConnectionRow>('SELECT * FROM connections ORDER BY name COLLATE NOCASE')
      .map(mapConnection);
  }

  getConnection(idOrName: string): ConnectionRecord | undefined {
    const row =
      this.db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', idOrName) ??
      this.db.get<ConnectionRow>('SELECT * FROM connections WHERE name = ?', idOrName);
    return row ? mapConnection(row) : undefined;
  }

  requireConnection(idOrName: string): ConnectionRecord {
    const found = this.getConnection(idOrName);
    if (!found) throw new UdmtError('NOT_FOUND', `Connection not found: ${idOrName}`);
    return found;
  }

  createConnection(input: {
    name: string;
    provider_id: string;
    service_profile: string | null;
    config: Record<string, unknown>;
    credential_ref: string | null;
    environment: string;
    description: string | null;
    endpoint_hint: string | null;
    default_storage_id?: string | null;
  }): ConnectionRecord {
    if (this.getConnection(input.name)) {
      throw new UdmtError('ALREADY_EXISTS', `A connection named "${input.name}" already exists.`);
    }
    const id = newId();
    const now = nowIso();
    this.db.run(
      `INSERT INTO connections
       (id, name, provider_id, service_profile, config_json, credential_ref, environment, description,
        default_storage_id, is_active, endpoint_hint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      input.name,
      input.provider_id,
      input.service_profile,
      JSON.stringify(input.config),
      input.credential_ref,
      input.environment,
      input.description,
      input.default_storage_id ?? null,
      input.endpoint_hint,
      now,
      now,
    );
    return this.requireConnection(id);
  }

  updateConnection(
    id: string,
    patch: {
      name?: string;
      service_profile?: string | null;
      config?: Record<string, unknown>;
      credential_ref?: string | null;
      environment?: string;
      description?: string | null;
      is_active?: boolean;
      endpoint_hint?: string | null;
      default_storage_id?: string | null;
    },
  ): ConnectionRecord {
    const existing = this.requireConnection(id);
    if (patch.name && patch.name !== existing.name && this.getConnection(patch.name)) {
      throw new UdmtError('ALREADY_EXISTS', `A connection named "${patch.name}" already exists.`);
    }
    this.db.run(
      `UPDATE connections SET
        name = ?, service_profile = ?, config_json = ?, credential_ref = ?, environment = ?,
        description = ?, is_active = ?, endpoint_hint = ?, default_storage_id = ?, updated_at = ?
       WHERE id = ?`,
      patch.name ?? existing.name,
      patch.service_profile === undefined ? existing.service_profile : patch.service_profile,
      JSON.stringify(patch.config ?? existing.config),
      patch.credential_ref === undefined ? existing.credential_ref : patch.credential_ref,
      patch.environment ?? existing.environment,
      patch.description === undefined ? existing.description : patch.description,
      patch.is_active === undefined ? (existing.is_active ? 1 : 0) : patch.is_active ? 1 : 0,
      patch.endpoint_hint === undefined ? existing.endpoint_hint : patch.endpoint_hint,
      patch.default_storage_id === undefined ? existing.default_storage_id : patch.default_storage_id,
      nowIso(),
      existing.id,
    );
    return this.requireConnection(existing.id);
  }

  deleteConnection(id: string): void {
    const existing = this.requireConnection(id);
    this.db.run('DELETE FROM connections WHERE id = ?', existing.id);
  }

  recordConnectionTest(id: string, status: 'success' | 'failed'): void {
    this.db.run(
      'UPDATE connections SET last_tested_at = ?, last_test_status = ?, updated_at = ? WHERE id = ?',
      nowIso(),
      status,
      nowIso(),
      id,
    );
  }

  // ---------------------------------------------------------------- storage
  listStorageBackends(): StorageBackendRecord[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM storage_backends ORDER BY name').map(mapStorage);
  }

  getStorageBackend(idOrName: string): StorageBackendRecord | undefined {
    const row =
      this.db.get<Record<string, unknown>>('SELECT * FROM storage_backends WHERE id = ?', idOrName) ??
      this.db.get<Record<string, unknown>>('SELECT * FROM storage_backends WHERE name = ?', idOrName);
    return row ? mapStorage(row) : undefined;
  }

  requireStorageBackend(idOrName?: string | null): StorageBackendRecord {
    if (idOrName) {
      const found = this.getStorageBackend(idOrName);
      if (!found) throw new UdmtError('NOT_FOUND', `Storage backend not found: ${idOrName}`);
      return found;
    }
    const rows = this.listStorageBackends();
    const def = rows.find((row) => row.is_default);
    if (!def) throw new UdmtError('NOT_FOUND', 'No default storage backend is configured.');
    return def;
  }

  createStorageBackend(input: {
    name: string;
    backend_type: StorageBackendRecord['backend_type'];
    config: Record<string, unknown>;
    credential_ref?: string | null;
    endpoint_hint?: string | null;
    is_default?: boolean;
  }): StorageBackendRecord {
    const id = newId();
    const now = nowIso();
    if (this.getStorageBackend(input.name)) {
      throw new UdmtError('ALREADY_EXISTS', `A storage backend named "${input.name}" already exists.`);
    }
    this.db.transaction(() => {
      if (input.is_default) this.db.run('UPDATE storage_backends SET is_default = 0');
      this.db.run(
        `INSERT INTO storage_backends
         (id, name, backend_type, config_json, credential_ref, is_default, endpoint_hint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        input.backend_type,
        JSON.stringify(input.config),
        input.credential_ref ?? null,
        input.is_default ? 1 : 0,
        input.endpoint_hint ?? null,
        now,
        now,
      );
    });
    return this.requireStorageBackend(id);
  }

  updateStorageBackend(
    idOrName: string,
    patch: {
      name?: string;
      config?: Record<string, unknown>;
      credential_ref?: string | null;
      endpoint_hint?: string | null;
      is_default?: boolean;
    },
  ): StorageBackendRecord {
    const existing = this.requireStorageBackend(idOrName);
    if (patch.name && patch.name !== existing.name && this.getStorageBackend(patch.name)) {
      throw new UdmtError('ALREADY_EXISTS', `A storage backend named "${patch.name}" already exists.`);
    }
    this.db.transaction(() => {
      if (patch.is_default) this.db.run('UPDATE storage_backends SET is_default = 0');
      this.db.run(
        `UPDATE storage_backends
         SET name = ?, config_json = ?, credential_ref = ?, endpoint_hint = ?, is_default = ?, updated_at = ?
         WHERE id = ?`,
        patch.name ?? existing.name,
        JSON.stringify(patch.config ?? existing.config),
        patch.credential_ref === undefined ? existing.credential_ref : patch.credential_ref,
        patch.endpoint_hint === undefined ? existing.endpoint_hint : patch.endpoint_hint,
        (patch.is_default ?? existing.is_default) ? 1 : 0,
        nowIso(),
        existing.id,
      );
    });
    return this.requireStorageBackend(existing.id);
  }

  deleteStorageBackend(idOrName: string): StorageBackendRecord {
    const existing = this.requireStorageBackend(idOrName);
    if (existing.id === 'local-default') {
      throw new UdmtError('PRECONDITION_FAILED', 'The built-in local storage backend cannot be removed.');
    }
    if (existing.is_default) {
      throw new UdmtError('CONFLICT', 'Choose another default backend before removing this one.');
    }
    const artifacts = this.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM artifacts WHERE storage_backend_id = ?',
      existing.id,
    );
    if (Number(artifacts?.count ?? 0) > 0) {
      throw new UdmtError('CONFLICT', 'Storage backend still has artifacts. Delete or prune them first.');
    }
    this.db.run('DELETE FROM storage_backends WHERE id = ?', existing.id);
    return existing;
  }

  setDefaultStorageBackend(idOrName: string): StorageBackendRecord {
    const existing = this.requireStorageBackend(idOrName);
    this.db.transaction(() => {
      this.db.run('UPDATE storage_backends SET is_default = 0');
      this.db.run('UPDATE storage_backends SET is_default = 1, updated_at = ? WHERE id = ?', nowIso(), existing.id);
    });
    return this.requireStorageBackend(existing.id);
  }

  recordStorageTest(id: string, status: 'success' | 'failed', endpointHint: string | null): void {
    this.db.run(
      'UPDATE storage_backends SET last_tested_at = ?, last_test_status = ?, endpoint_hint = COALESCE(?, endpoint_hint), updated_at = ? WHERE id = ?',
      nowIso(),
      status,
      endpointHint,
      nowIso(),
      id,
    );
  }

  // ---------------------------------------------------------------- plugins
  listPlugins(): PluginRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM plugins ORDER BY name COLLATE NOCASE')
      .map(mapPlugin);
  }

  getPlugin(id: string): PluginRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM plugins WHERE id = ?', id);
    return row ? mapPlugin(row) : undefined;
  }

  requirePlugin(id: string): PluginRecord {
    const found = this.getPlugin(id);
    if (!found) throw new UdmtError('NOT_FOUND', `Plugin not found: ${id}`);
    return found;
  }

  createPlugin(record: {
    id: string;
    name: string;
    version: string;
    protocol_version: string;
    description: string | null;
    manifest: PluginRecord['manifest'];
    install_path: string;
    enabled: boolean;
    trusted: boolean;
    requested_permissions: PluginRecord['requested_permissions'];
    granted_permissions: PluginRecord['granted_permissions'];
    status: PluginRecord['status'];
  }): PluginRecord {
    const now = nowIso();
    this.db.run(
      `INSERT INTO plugins (
         id, name, version, protocol_version, description, manifest_json, install_path,
         enabled, trusted, requested_permissions_json, granted_permissions_json, status,
         last_error, last_handshake_at, installed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      record.id,
      record.name,
      record.version,
      record.protocol_version,
      record.description,
      JSON.stringify(record.manifest),
      record.install_path,
      record.enabled ? 1 : 0,
      record.trusted ? 1 : 0,
      JSON.stringify(record.requested_permissions),
      JSON.stringify(record.granted_permissions),
      record.status,
      now,
      now,
    );
    return this.requirePlugin(record.id);
  }

  updatePlugin(
    id: string,
    patch: {
      name?: string;
      version?: string;
      protocol_version?: string;
      description?: string | null;
      manifest?: PluginRecord['manifest'];
      install_path?: string;
      enabled?: boolean;
      trusted?: boolean;
      requested_permissions?: PluginRecord['requested_permissions'];
      granted_permissions?: PluginRecord['granted_permissions'];
      status?: PluginRecord['status'];
      last_error?: string | null;
      last_handshake_at?: string | null;
    },
  ): PluginRecord {
    const existing = this.requirePlugin(id);
    const next = {
      name: patch.name ?? existing.name,
      version: patch.version ?? existing.version,
      protocol_version: patch.protocol_version ?? existing.protocol_version,
      description: patch.description === undefined ? existing.description : patch.description,
      manifest: patch.manifest ?? existing.manifest,
      install_path: patch.install_path ?? existing.install_path,
      enabled: patch.enabled ?? existing.enabled,
      trusted: patch.trusted ?? existing.trusted,
      requested_permissions: patch.requested_permissions ?? existing.requested_permissions,
      granted_permissions: patch.granted_permissions ?? existing.granted_permissions,
      status: patch.status ?? existing.status,
      last_error: patch.last_error === undefined ? existing.last_error : patch.last_error,
      last_handshake_at: patch.last_handshake_at === undefined ? existing.last_handshake_at : patch.last_handshake_at,
    };
    this.db.run(
      `UPDATE plugins SET
         name = ?, version = ?, protocol_version = ?, description = ?, manifest_json = ?,
         install_path = ?, enabled = ?, trusted = ?, requested_permissions_json = ?,
         granted_permissions_json = ?, status = ?, last_error = ?, last_handshake_at = ?, updated_at = ?
       WHERE id = ?`,
      next.name,
      next.version,
      next.protocol_version,
      next.description,
      JSON.stringify(next.manifest),
      next.install_path,
      next.enabled ? 1 : 0,
      next.trusted ? 1 : 0,
      JSON.stringify(next.requested_permissions),
      JSON.stringify(next.granted_permissions),
      next.status,
      next.last_error,
      next.last_handshake_at,
      nowIso(),
      id,
    );
    return this.requirePlugin(id);
  }

  deletePlugin(id: string): void {
    this.db.run('DELETE FROM plugins WHERE id = ?', id);
  }

  // ---------------------------------------------------------------- sync
  listSyncPipelines(): SyncPipelineRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM sync_pipelines ORDER BY created_at DESC')
      .map(mapSyncPipeline);
  }

  getSyncPipeline(idOrName: string): SyncPipelineRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM sync_pipelines WHERE id = ? OR name = ? LIMIT 1',
      idOrName,
      idOrName,
    );
    return row ? mapSyncPipeline(row) : undefined;
  }

  requireSyncPipeline(idOrName: string): SyncPipelineRecord {
    const pipeline = this.getSyncPipeline(idOrName);
    if (!pipeline) throw new UdmtError('NOT_FOUND', `Sync pipeline not found: ${idOrName}`);
    return pipeline;
  }

  createSyncPipeline(input: Omit<SyncPipelineRecord, 'id' | 'created_at' | 'updated_at'>): SyncPipelineRecord {
    const id = newId();
    const now = nowIso();
    this.db.run(
      `INSERT INTO sync_pipelines
       (id, name, source_connection_id, target_connection_id, source_resource, target_resource,
        mapping_json, load_mode, key_columns_json, options_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.source_connection_id,
      input.target_connection_id,
      input.source_resource,
      input.target_resource,
      JSON.stringify(input.mapping),
      input.load_mode,
      JSON.stringify(input.key_columns),
      JSON.stringify(input.options),
      input.enabled ? 1 : 0,
      now,
      now,
    );
    return this.requireSyncPipeline(id);
  }

  updateSyncPipeline(
    id: string,
    patch: Partial<Omit<SyncPipelineRecord, 'id' | 'created_at' | 'updated_at'>>,
  ): SyncPipelineRecord {
    const existing = this.requireSyncPipeline(id);
    const next = {
      name: patch.name ?? existing.name,
      source_connection_id: patch.source_connection_id ?? existing.source_connection_id,
      target_connection_id: patch.target_connection_id ?? existing.target_connection_id,
      source_resource: patch.source_resource ?? existing.source_resource,
      target_resource: patch.target_resource ?? existing.target_resource,
      mapping: patch.mapping ?? existing.mapping,
      load_mode: patch.load_mode ?? existing.load_mode,
      key_columns: patch.key_columns ?? existing.key_columns,
      options: patch.options ? { ...existing.options, ...patch.options } : existing.options,
      enabled: patch.enabled ?? existing.enabled,
    };
    this.db.run(
      `UPDATE sync_pipelines SET name = ?, source_connection_id = ?, target_connection_id = ?,
        source_resource = ?, target_resource = ?, mapping_json = ?, load_mode = ?, key_columns_json = ?,
        options_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      next.name,
      next.source_connection_id,
      next.target_connection_id,
      next.source_resource,
      next.target_resource,
      JSON.stringify(next.mapping),
      next.load_mode,
      JSON.stringify(next.key_columns),
      JSON.stringify(next.options),
      next.enabled ? 1 : 0,
      nowIso(),
      id,
    );
    return this.requireSyncPipeline(id);
  }

  deleteSyncPipeline(id: string): void {
    const pipeline = this.requireSyncPipeline(id);
    this.db.run('DELETE FROM sync_pipelines WHERE id = ?', pipeline.id);
  }

  getSyncState(pipelineId: string): SyncStateRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM sync_states WHERE pipeline_id = ?', pipelineId);
    return row ? mapSyncState(row) : undefined;
  }

  upsertSyncState(input: {
    pipeline_id: string;
    checkpoint: Record<string, unknown>;
    last_run_id: string | null;
    last_run_at: string | null;
    last_status: OperationStatus | null;
    rows_synced: number;
  }): SyncStateRecord {
    this.db.run(
      `INSERT INTO sync_states (pipeline_id, checkpoint_json, last_run_id, last_run_at, last_status, rows_synced, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pipeline_id) DO UPDATE SET
         checkpoint_json = excluded.checkpoint_json,
         last_run_id = excluded.last_run_id,
         last_run_at = excluded.last_run_at,
         last_status = excluded.last_status,
         rows_synced = excluded.rows_synced,
         updated_at = excluded.updated_at`,
      input.pipeline_id,
      JSON.stringify(input.checkpoint),
      input.last_run_id,
      input.last_run_at,
      input.last_status,
      input.rows_synced,
      nowIso(),
    );
    const state = this.getSyncState(input.pipeline_id);
    if (!state) throw new UdmtError('OPERATION_FAILED', `Sync state missing after write: ${input.pipeline_id}`);
    return state;
  }

  recordSyncError(input: {
    run_id: string;
    pipeline_id: string | null;
    batch_index: number | null;
    row_index: number | null;
    code: string;
    message: string;
  }): void {
    this.db.run(
      `INSERT INTO sync_run_errors (run_id, pipeline_id, batch_index, row_index, code, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.run_id,
      input.pipeline_id,
      input.batch_index,
      input.row_index,
      input.code,
      input.message,
      nowIso(),
    );
  }

  clearSyncErrors(runId: string): void {
    this.db.run('DELETE FROM sync_run_errors WHERE run_id = ?', runId);
  }

  listSyncErrors(runId: string, limit = 200): SyncRunError[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM sync_run_errors WHERE run_id = ? ORDER BY id ASC LIMIT ?',
        runId,
        Math.min(Math.max(limit, 1), 1000),
      )
      .map(mapSyncError);
  }

  countSyncErrors(runId: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_run_errors WHERE run_id = ?', runId);
    return Number(row?.n ?? 0);
  }

  // ---------------------------------------------------------------- runs
  createRun(input: {
    operation_type: OperationRun['operation_type'];
    status: OperationStatus;
    source_connection_id: string | null;
    target_connection_id: string | null;
    source_label: string | null;
    target_label: string | null;
    resource: string | null;
    config: Record<string, unknown>;
    job_id?: string | null;
    retry_of_run_id?: string | null;
    worker_instance_id?: string | null;
  }): OperationRun {
    const id = newId();
    const now = nowIso();
    this.db.run(
      `INSERT INTO operation_runs
       (id, job_id, operation_type, status, source_connection_id, target_connection_id, source_label,
        target_label, resource, stage, progress_json, config_json, result_json, error_code,
        error_message_safe, retry_of_run_id, worker_instance_id, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`,
      id,
      input.job_id ?? null,
      input.operation_type,
      input.status,
      input.source_connection_id,
      input.target_connection_id,
      input.source_label,
      input.target_label,
      input.resource,
      JSON.stringify(input.config),
      input.retry_of_run_id ?? null,
      input.worker_instance_id ?? null,
      now,
    );
    return this.requireRun(id);
  }

  getRun(id: string): OperationRun | undefined {
    const row = this.db.get<RunRow>('SELECT * FROM operation_runs WHERE id = ?', id);
    return row ? mapRun(row) : undefined;
  }

  requireRun(id: string): OperationRun {
    const run = this.getRun(id);
    if (!run) throw new UdmtError('NOT_FOUND', `Run not found: ${id}`);
    return run;
  }

  /** Resolve by full id or unique prefix (CLI convenience). */
  resolveRun(idOrPrefix: string): OperationRun {
    const exact = this.getRun(idOrPrefix);
    if (exact) return exact;
    const matches = this.db.all<RunRow>(
      'SELECT * FROM operation_runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 5',
      `${idOrPrefix}%`,
    );
    if (matches.length === 1) return mapRun(matches[0]!);
    if (matches.length > 1) {
      throw new UdmtError('CONFLICT', `Run id prefix "${idOrPrefix}" is ambiguous.`);
    }
    throw new UdmtError('NOT_FOUND', `Run not found: ${idOrPrefix}`);
  }

  updateRunStatus(id: string, status: OperationStatus, patch: Partial<{
    stage: string;
    progress: RunProgress;
    result: Record<string, unknown>;
    error_code: string;
    error_message_safe: string;
    started_at: string;
    finished_at: string;
    worker_instance_id: string;
  }> = {}): OperationRun {
    const run = this.requireRun(id);
    if (run.status !== status) assertTransition(run.status, status, id);
    this.db.run(
      `UPDATE operation_runs SET status = ?, stage = COALESCE(?, stage), progress_json = COALESCE(?, progress_json),
        result_json = COALESCE(?, result_json), error_code = COALESCE(?, error_code),
        error_message_safe = COALESCE(?, error_message_safe), started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at), worker_instance_id = COALESCE(?, worker_instance_id)
       WHERE id = ?`,
      status,
      patch.stage ?? null,
      patch.progress ? JSON.stringify(patch.progress) : null,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.error_code ?? null,
      patch.error_message_safe ?? null,
      patch.started_at ?? null,
      patch.finished_at ?? null,
      patch.worker_instance_id ?? null,
      id,
    );
    return this.requireRun(id);
  }

  updateRunProgress(id: string, progress: RunProgress): void {
    this.db.run(
      'UPDATE operation_runs SET progress_json = ?, stage = ? WHERE id = ?',
      JSON.stringify(progress),
      progress.stage,
      id,
    );
  }

  listRuns(options: { limit?: number; status?: string; operation_type?: string } = {}): OperationRun[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.operation_type) {
      clauses.push('operation_type = ?');
      params.push(options.operation_type);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(options.limit ?? 50, 500));
    return this.db
      .all<RunRow>(`SELECT * FROM operation_runs ${where} ORDER BY created_at DESC LIMIT ?`, ...params)
      .map(mapRun);
  }

  listActiveRunsForJob(jobId: string): OperationRun[] {
    return this.db
      .all<RunRow>(
        `SELECT * FROM operation_runs
         WHERE job_id = ? AND status IN ('queued','preparing','preflight','running','finalizing','verifying','cancel_requested')`,
        jobId,
      )
      .map(mapRun);
  }

  /** Runs still marked active but owned by a worker that stopped heartbeating. */
  findAbandonedRuns(staleBeforeIso: string): OperationRun[] {
    return this.db
      .all<RunRow>(
        `SELECT r.* FROM operation_runs r
         LEFT JOIN worker_instances w ON w.id = r.worker_instance_id
         WHERE r.status IN ('preparing','preflight','running','finalizing','verifying','cancel_requested')
           AND (r.worker_instance_id IS NULL OR w.id IS NULL OR w.heartbeat_at < ?)`,
        staleBeforeIso,
      )
      .map(mapRun);
  }

  markRunInterrupted(runId: string, message: string): void {
    const run = this.requireRun(runId);
    if (run.status === 'completed' || run.status === 'completed_with_warnings') return;
    this.db.run(
      `UPDATE operation_runs SET status = 'interrupted', error_code = COALESCE(error_code, 'INTERRUPTED'),
        error_message_safe = ?, finished_at = ? WHERE id = ?`,
      message,
      nowIso(),
      runId,
    );
  }

  appendLog(runId: string, level: OperationLogEntry['level'], message: string, stage?: string | null): void {
    const next = this.db.get<{ seq: number | null }>(
      'SELECT MAX(sequence) AS seq FROM operation_logs WHERE run_id = ?',
      runId,
    );
    const sequence = (next?.seq ?? 0) + 1;
    this.db.run(
      'INSERT INTO operation_logs (run_id, sequence, level, stage, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      runId,
      sequence,
      level,
      stage ?? null,
      message,
      nowIso(),
    );
  }

  listLogs(runId: string, options: { limit?: number; afterSequence?: number } = {}): OperationLogEntry[] {
    return this.db.all<OperationLogEntry>(
      'SELECT id, run_id, sequence, level, stage, message, created_at FROM operation_logs WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
      runId,
      options.afterSequence ?? 0,
      Math.min(options.limit ?? 500, 5000),
    );
  }

  // ---------------------------------------------------------------- artifacts
  createArtifact(input: {
    run_id: string;
    artifact_type: string;
    provider_id: string | null;
    storage_backend_id: string;
    object_key: string;
    absolute_path: string;
    manifest: ArtifactManifest;
    size_bytes: number;
    checksum_value: string;
    expires_at?: string | null;
  }): ArtifactRecord {
    const id = input.manifest.artifact_id;
    this.db.run(
      `INSERT INTO artifacts
       (id, run_id, artifact_type, provider_id, storage_backend_id, object_key, absolute_path, manifest_json,
        size_bytes, checksum_algorithm, checksum_value, verification_status, verified_at, restore_test_status,
        created_at, expires_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sha256', ?, 'unverified', NULL, NULL, ?, ?, 0)`,
      id,
      input.run_id,
      input.artifact_type,
      input.provider_id,
      input.storage_backend_id,
      input.object_key,
      input.absolute_path,
      JSON.stringify(input.manifest),
      input.size_bytes,
      input.checksum_value,
      input.manifest.created_at,
      input.expires_at ?? null,
    );
    return this.requireArtifact(id);
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.get<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', id);
    return row ? mapArtifact(row) : undefined;
  }

  requireArtifact(id: string): ArtifactRecord {
    const artifact = this.getArtifact(id);
    if (!artifact) throw new UdmtError('NOT_FOUND', `Artifact not found: ${id}`);
    return artifact;
  }

  listArtifacts(options: { limit?: number; pinnedOnly?: boolean } = {}): ArtifactRecord[] {
    return this.db
      .all<ArtifactRow>(
        `SELECT * FROM artifacts ${options.pinnedOnly ? 'WHERE pinned = 1' : ''} ORDER BY created_at DESC LIMIT ?`,
        Math.min(options.limit ?? 100, 1000),
      )
      .map(mapArtifact);
  }

  updateArtifactVerification(
    id: string,
    status: 'unverified' | 'verified' | 'failed',
    checksum?: string,
  ): void {
    this.db.run(
      'UPDATE artifacts SET verification_status = ?, verified_at = ?, checksum_value = COALESCE(?, checksum_value) WHERE id = ?',
      status,
      nowIso(),
      checksum ?? null,
      id,
    );
  }

  setArtifactPinned(id: string, pinned: boolean): void {
    this.db.run('UPDATE artifacts SET pinned = ? WHERE id = ?', pinned ? 1 : 0, id);
  }

  setArtifactExpiry(id: string, expiresAt: string | null): void {
    this.db.run('UPDATE artifacts SET expires_at = ? WHERE id = ?', expiresAt, id);
  }

  deleteArtifactRecord(id: string): void {
    this.db.run('DELETE FROM artifacts WHERE id = ?', id);
  }

  // ---------------------------------------------------------------- jobs & schedules
  createJob(input: {
    name: string;
    operation_type: JobRecord['operation_type'];
    source_connection_id: string | null;
    target_connection_id: string | null;
    storage_backend_id: string | null;
    config: Record<string, unknown>;
    enabled?: boolean;
  }): JobRecord {
    const id = newId();
    const now = nowIso();
    this.db.run(
      `INSERT INTO jobs (id, name, operation_type, source_connection_id, target_connection_id, storage_backend_id,
        operation_config_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.operation_type,
      input.source_connection_id,
      input.target_connection_id,
      input.storage_backend_id,
      JSON.stringify(input.config),
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    return this.requireJob(id);
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM jobs WHERE id = ?', id);
    return row ? mapJob(row) : undefined;
  }

  requireJob(id: string): JobRecord {
    const job = this.getJob(id);
    if (!job) throw new UdmtError('NOT_FOUND', `Job not found: ${id}`);
    return job;
  }

  listJobs(): JobRecord[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM jobs ORDER BY created_at DESC').map(mapJob);
  }

  setJobEnabled(id: string, enabled: boolean): void {
    this.db.run('UPDATE jobs SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, nowIso(), id);
  }

  deleteJob(id: string): void {
    this.db.run('DELETE FROM jobs WHERE id = ?', id);
  }

  createSchedule(input: {
    job_id: string;
    schedule_type: ScheduleRecord['schedule_type'];
    schedule_config: Record<string, unknown>;
    timezone: string;
    misfire_policy?: ScheduleRecord['misfire_policy'];
    overlap_policy?: ScheduleRecord['overlap_policy'];
    next_run_at: string | null;
    enabled?: boolean;
  }): ScheduleRecord {
    this.requireJob(input.job_id);
    const id = newId();
    this.db.run(
      `INSERT INTO job_schedules (id, job_id, schedule_type, schedule_config_json, timezone, misfire_policy,
        overlap_policy, next_run_at, last_run_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id,
      input.job_id,
      input.schedule_type,
      JSON.stringify(input.schedule_config),
      input.timezone,
      input.misfire_policy ?? 'run_once_on_recovery',
      input.overlap_policy ?? 'forbid',
      input.next_run_at,
      input.enabled === false ? 0 : 1,
    );
    return this.requireSchedule(id);
  }

  getSchedule(id: string): ScheduleRecord | undefined {
    const row = this.db.get<ScheduleRow>('SELECT * FROM job_schedules WHERE id = ?', id);
    return row ? mapSchedule(row) : undefined;
  }

  requireSchedule(id: string): ScheduleRecord {
    const schedule = this.getSchedule(id);
    if (!schedule) throw new UdmtError('NOT_FOUND', `Schedule not found: ${id}`);
    return schedule;
  }

  listSchedules(): ScheduleRecord[] {
    return this.db.all<ScheduleRow>('SELECT * FROM job_schedules ORDER BY rowid').map(mapSchedule);
  }

  listSchedulesForJob(jobId: string): ScheduleRecord[] {
    return this.db
      .all<ScheduleRow>('SELECT * FROM job_schedules WHERE job_id = ? ORDER BY rowid', jobId)
      .map(mapSchedule);
  }

  listDueSchedules(now: string): ScheduleRecord[] {
    return this.db
      .all<ScheduleRow>(
        'SELECT * FROM job_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC',
        now,
      )
      .map(mapSchedule);
  }

  updateSchedule(
    id: string,
    patch: Partial<{
      next_run_at: string | null;
      last_run_at: string | null;
      enabled: boolean;
      schedule_config: Record<string, unknown>;
      timezone: string;
      misfire_policy: ScheduleRecord['misfire_policy'];
      overlap_policy: ScheduleRecord['overlap_policy'];
    }>,
  ): ScheduleRecord {
    const existing = this.requireSchedule(id);
    this.db.run(
      `UPDATE job_schedules SET next_run_at = ?, last_run_at = ?, enabled = ?, schedule_config_json = ?,
        timezone = ?, misfire_policy = ?, overlap_policy = ? WHERE id = ?`,
      patch.next_run_at === undefined ? existing.next_run_at : patch.next_run_at,
      patch.last_run_at === undefined ? existing.last_run_at : patch.last_run_at,
      patch.enabled === undefined ? (existing.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      JSON.stringify(patch.schedule_config ?? existing.schedule_config),
      patch.timezone ?? existing.timezone,
      patch.misfire_policy ?? existing.misfire_policy,
      patch.overlap_policy ?? existing.overlap_policy,
      id,
    );
    return this.requireSchedule(id);
  }

  deleteSchedule(id: string): void {
    this.db.run('DELETE FROM job_schedules WHERE id = ?', id);
  }

  // ---------------------------------------------------------------- locks
  acquireLock(scope: string, owner: string, runId: string | null, leaseMs: number): boolean {
    const now = Date.now();
    const existing = this.db.get<{ owner: string; heartbeat_at: string }>(
      'SELECT owner, heartbeat_at FROM task_locks WHERE scope = ?',
      scope,
    );
    if (existing) {
      const age = now - new Date(existing.heartbeat_at).getTime();
      if (age < leaseMs && existing.owner !== owner) return false;
      this.db.run(
        'UPDATE task_locks SET owner = ?, run_id = ?, acquired_at = ?, heartbeat_at = ? WHERE scope = ?',
        owner,
        runId,
        nowIso(),
        nowIso(),
        scope,
      );
      return true;
    }
    this.db.run(
      'INSERT INTO task_locks (scope, owner, run_id, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)',
      scope,
      owner,
      runId,
      nowIso(),
      nowIso(),
    );
    return true;
  }

  heartbeatLock(scope: string, owner: string): void {
    this.db.run(
      'UPDATE task_locks SET heartbeat_at = ? WHERE scope = ? AND owner = ?',
      nowIso(),
      scope,
      owner,
    );
  }

  releaseLock(scope: string, owner: string): void {
    this.db.run('DELETE FROM task_locks WHERE scope = ? AND owner = ?', scope, owner);
  }

  purgeStaleLocks(staleBeforeIso: string): number {
    return this.db.run('DELETE FROM task_locks WHERE heartbeat_at < ?', staleBeforeIso).changes;
  }

  // ---------------------------------------------------------------- worker
  upsertWorkerInstance(instance: WorkerInstance): void {
    this.db.run(
      `INSERT INTO worker_instances (id, pid, hostname, version, status, started_at, heartbeat_at, last_error, tasks_running)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, heartbeat_at = excluded.heartbeat_at,
         last_error = excluded.last_error, tasks_running = excluded.tasks_running`,
      instance.id,
      instance.pid,
      instance.hostname,
      instance.version,
      instance.status,
      instance.started_at,
      instance.heartbeat_at,
      instance.last_error,
      instance.tasks_running,
    );
  }

  getWorkerInstance(id: string): WorkerInstance | undefined {
    const row = this.db.get<WorkerInstance>('SELECT * FROM worker_instances WHERE id = ?', id);
    return row ?? undefined;
  }

  latestWorkerInstance(): WorkerInstance | undefined {
    return this.db.get<WorkerInstance>('SELECT * FROM worker_instances ORDER BY heartbeat_at DESC LIMIT 1');
  }

  listWorkerInstances(): WorkerInstance[] {
    return this.db.all<WorkerInstance>('SELECT * FROM worker_instances ORDER BY heartbeat_at DESC');
  }

  // ---------------------------------------------------------------- settings / audit
  getSetting(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      nowIso(),
    );
  }

  audit(action: string, detail: Record<string, unknown>, runId?: string | null): void {
    this.db.run(
      'INSERT INTO audit_events (run_id, action, detail_json, created_at) VALUES (?, ?, ?, ?)',
      runId ?? null,
      action,
      JSON.stringify(detail),
      nowIso(),
    );
  }

  counts(): { connections: number; runs: number; artifacts: number; schedules: number } {
    const one = (sql: string): number => Number(this.db.get<{ n: number }>(sql)?.n ?? 0);
    return {
      connections: one('SELECT COUNT(*) AS n FROM connections'),
      runs: one('SELECT COUNT(*) AS n FROM operation_runs'),
      artifacts: one('SELECT COUNT(*) AS n FROM artifacts'),
      schedules: one('SELECT COUNT(*) AS n FROM job_schedules'),
    };
  }
}

function mapConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    provider_id: row.provider_id,
    service_profile: row.service_profile,
    config: json(row.config_json, {}),
    credential_ref: row.credential_ref,
    environment: (row.environment as ConnectionRecord['environment']) ?? 'local',
    description: row.description,
    default_storage_id: row.default_storage_id,
    is_active: Boolean(row.is_active),
    endpoint_hint: row.endpoint_hint,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_tested_at: row.last_tested_at,
    last_test_status: (row.last_test_status as 'success' | 'failed' | null) ?? null,
  };
}

function mapRun(row: RunRow): OperationRun {
  return {
    id: row.id,
    job_id: row.job_id,
    operation_type: row.operation_type as OperationRun['operation_type'],
    status: row.status as OperationStatus,
    source_connection_id: row.source_connection_id,
    target_connection_id: row.target_connection_id,
    source_label: row.source_label,
    target_label: row.target_label,
    resource: row.resource,
    stage: row.stage,
    progress: json<RunProgress | null>(row.progress_json, null),
    config: json(row.config_json, {}),
    result: json<Record<string, unknown> | null>(row.result_json, null),
    error_code: row.error_code,
    error_message_safe: row.error_message_safe,
    retry_of_run_id: row.retry_of_run_id,
    worker_instance_id: row.worker_instance_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    artifact_type: row.artifact_type,
    provider_id: row.provider_id,
    storage_backend_id: row.storage_backend_id,
    object_key: row.object_key,
    absolute_path: row.absolute_path,
    manifest: json<ArtifactManifest>(row.manifest_json, {} as ArtifactManifest),
    size_bytes: row.size_bytes ?? 0,
    checksum_algorithm: 'sha256',
    checksum_value: row.checksum_value ?? '',
    verification_status: row.verification_status as ArtifactRecord['verification_status'],
    verified_at: row.verified_at,
    restore_test_status: row.restore_test_status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    pinned: Boolean(row.pinned),
  };
}

function mapSyncPipeline(row: Record<string, unknown>): SyncPipelineRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    source_connection_id: String(row.source_connection_id),
    target_connection_id: String(row.target_connection_id),
    source_resource: String(row.source_resource),
    target_resource: String(row.target_resource),
    mapping: json<SyncPipelineRecord['mapping']>(row.mapping_json as string, []),
    load_mode: String(row.load_mode) as SyncPipelineRecord['load_mode'],
    key_columns: json<string[]>(row.key_columns_json as string | null, []),
    options: json<SyncPipelineRecord['options']>(row.options_json as string, {}),
    enabled: Boolean(row.enabled),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapSyncState(row: Record<string, unknown>): SyncStateRecord {
  return {
    pipeline_id: String(row.pipeline_id),
    checkpoint: json<Record<string, unknown>>(row.checkpoint_json as string, {}),
    last_run_id: (row.last_run_id as string | null) ?? null,
    last_run_at: (row.last_run_at as string | null) ?? null,
    last_status: (row.last_status as OperationStatus | null) ?? null,
    rows_synced: Number(row.rows_synced ?? 0),
    updated_at: String(row.updated_at),
  };
}

function mapSyncError(row: Record<string, unknown>): SyncRunError {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    pipeline_id: (row.pipeline_id as string | null) ?? null,
    batch_index: row.batch_index === null || row.batch_index === undefined ? null : Number(row.batch_index),
    row_index: row.row_index === null || row.row_index === undefined ? null : Number(row.row_index),
    code: String(row.code),
    message: String(row.message),
    created_at: String(row.created_at),
  };
}

function mapStorage(row: Record<string, unknown>): StorageBackendRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    backend_type: String(row.backend_type) as StorageBackendRecord['backend_type'],
    config: json<Record<string, unknown>>(row.config_json as string, {}),
    credential_ref: (row.credential_ref as string | null) ?? null,
    is_default: Boolean(row.is_default),
    endpoint_hint: (row.endpoint_hint as string | null) ?? null,
    last_tested_at: (row.last_tested_at as string | null) ?? null,
    last_test_status: (row.last_test_status as 'success' | 'failed' | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapPlugin(row: Record<string, unknown>): PluginRecord {
  const manifest = json<PluginRecord['manifest']>(row.manifest_json as string, {} as PluginRecord['manifest']);
  return {
    id: String(row.id),
    name: String(row.name),
    version: String(row.version),
    protocol_version: String(row.protocol_version),
    description: (row.description as string | null) ?? null,
    manifest,
    install_path: String(row.install_path),
    enabled: Boolean(row.enabled),
    trusted: Boolean(row.trusted),
    requested_permissions: json<PluginRecord['requested_permissions']>(row.requested_permissions_json as string, []),
    granted_permissions: json<PluginRecord['granted_permissions']>(row.granted_permissions_json as string, []),
    status: String(row.status) as PluginRecord['status'],
    last_error: (row.last_error as string | null) ?? null,
    last_handshake_at: (row.last_handshake_at as string | null) ?? null,
    installed_at: String(row.installed_at),
    updated_at: String(row.updated_at),
  };
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    operation_type: String(row.operation_type) as JobRecord['operation_type'],
    source_connection_id: (row.source_connection_id as string | null) ?? null,
    target_connection_id: (row.target_connection_id as string | null) ?? null,
    storage_backend_id: (row.storage_backend_id as string | null) ?? null,
    config: json<Record<string, unknown>>(row.operation_config_json as string, {}),
    enabled: Boolean(row.enabled),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    job_id: row.job_id,
    schedule_type: row.schedule_type as ScheduleRecord['schedule_type'],
    schedule_config: json<Record<string, unknown>>(row.schedule_config_json, {}),
    timezone: row.timezone,
    misfire_policy: row.misfire_policy as ScheduleRecord['misfire_policy'],
    overlap_policy: row.overlap_policy as ScheduleRecord['overlap_policy'],
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    enabled: Boolean(row.enabled),
  };
}

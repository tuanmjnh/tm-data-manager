import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, type Db } from './db/database.js';
import { Store } from './db/store.js';
import { ensureAppDirs, resolveAppPaths, type AppPaths } from './paths.js';
import { ProviderRegistry } from './providers/registry.js';
import { SecretStore } from './secrets.js';
import { LocalStorageBackend } from './storage/local.js';
import { createStorageBackend as buildStorageBackend, managedLocalBackend } from './storage/index.js';
import type { StorageBackend } from './storage/contract.js';
import { OperationEngine } from './operation/engine.js';
import { describeSchedule, nextRunAt, validateSchedule, type ScheduleInput } from './scheduler.js';
import { UdmtError, toUdmtError } from './errors.js';
import { APP_VERSION, newId, nowIso, sanitizeName, sha256File, truncate } from './utils.js';
import type {
  ArtifactRecord,
  CapabilityId,
  ColumnSchema,
  ConnectionRecord,
  ConnectionTestResult,
  DoctorReport,
  Environment,
  ExportRequest,
  ImportRequest,
  JobRecord,
  OperationLogEntry,
  OperationRun,
  ProviderDescriptor,
  ResourceDescriptor,
  ResourceSchema,
  RowBatch,
  RowsPreview,
  ScheduleRecord,
  StorageBackendRecord,
  StorageBackendType,
  StorageTestResult,
  SyncFieldMapping,
  SyncLoadMode,
  SyncOptions,
  SyncPipelineRecord,
  SyncRequest,
  SyncRunError,
  SyncStateRecord,
  WorkerInstance,
} from './types.js';
import { ENVIRONMENTS, PREVIEW_ROW_LIMIT, STORAGE_BACKEND_TYPES, SYNC_LOAD_MODES } from './types.js';

export interface CreateSyncPipelineInput {
  name: string;
  source_connection_id: string;
  target_connection_id: string;
  source_resource: string;
  target_resource: string;
  mapping?: SyncFieldMapping[];
  load_mode?: SyncLoadMode;
  key_columns?: string[];
  options?: SyncOptions;
  enabled?: boolean;
}

export type UpdateSyncPipelineInput = Partial<Omit<CreateSyncPipelineInput, 'name'>> & { name?: string };

export interface CreateStorageBackendInput {
  name: string;
  backend_type: StorageBackendType;
  config?: Record<string, unknown>;
  secret?: Record<string, unknown>;
  is_default?: boolean;
}

export interface UpdateStorageBackendInput {
  name?: string;
  config?: Record<string, unknown>;
  secret?: Record<string, unknown>;
}

export interface CreateConnectionInput {
  name: string;
  provider_id: string;
  service_profile?: string | null;
  config: Record<string, unknown>;
  secret?: Record<string, unknown>;
  environment?: Environment;
  description?: string | null;
  default_storage_id?: string | null;
}

export interface UpdateConnectionInput {
  name?: string;
  service_profile?: string | null;
  config?: Record<string, unknown>;
  secret?: Record<string, unknown>;
  environment?: Environment;
  description?: string | null;
  is_active?: boolean;
  default_storage_id?: string | null;
}

export interface WorkerStatus {
  running: boolean;
  stale: boolean;
  instance: WorkerInstance | null;
  heartbeat_age_seconds: number | null;
}

/**
 * Application facade: the single entry point used by the CLI, the local API
 * server and the worker. No business logic lives above this layer.
 */
export class UdmtApp {
  readonly paths: AppPaths;
  readonly db: Db;
  readonly store: Store;
  readonly secrets: SecretStore;
  readonly registry: ProviderRegistry;
  /** Always-present local backend; used for staging and safe fallback. */
  readonly managedStorage: LocalStorageBackend;
  readonly engine: OperationEngine;

  constructor(options: { dataDir?: string } = {}) {
    this.paths = resolveAppPaths(options.dataDir);
    ensureAppDirs(this.paths);
    this.db = openDatabase(this.paths.dbPath);
    try {
      this.store = new Store(this.db);
      this.secrets = new SecretStore(this.db, this.paths);
      this.registry = new ProviderRegistry();
      this.managedStorage = managedLocalBackend(this.paths);
      this.engine = new OperationEngine({
        store: this.store,
        registry: this.registry,
        secrets: this.secrets,
        paths: this.paths,
        managedStorage: this.managedStorage,
        resolveStorage: (idOrName) => this.storageBackend(idOrName),
      });
    } catch (error) {
      // Never leak a locked metadata database when startup fails.
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ providers
  providers(): ProviderDescriptor[] {
    return this.registry.list();
  }

  provider(providerId: string): ProviderDescriptor {
    return this.registry.descriptor(providerId);
  }

  // ------------------------------------------------------------------ connections
  listConnections(): ConnectionRecord[] {
    return this.store.listConnections();
  }

  getConnection(idOrName: string): ConnectionRecord {
    return this.store.requireConnection(idOrName);
  }

  createConnection(input: CreateConnectionInput): ConnectionRecord {
    if (!input.name?.trim()) throw new UdmtError('INVALID_INPUT', 'Connection name is required.');
    const environment = input.environment ?? 'local';
    if (!ENVIRONMENTS.includes(environment)) {
      throw new UdmtError('INVALID_INPUT', `Unknown environment: ${environment}`);
    }
    const provider = this.registry.get(input.provider_id);
    const descriptor = provider.descriptor();
    const profile = input.service_profile ?? null;
    if (profile && !descriptor.service_profiles.some((entry) => entry.id === profile)) {
      throw new UdmtError(
        'INVALID_INPUT',
        `Provider ${input.provider_id} has no service profile "${profile}". Available: ${descriptor.service_profiles.map((p) => p.id).join(', ') || 'none'}`,
      );
    }
    const normalized = normalizeInlineSecret(input.provider_id, input.config, input.secret ?? {});
    const validated = provider.validateConfig(normalized.config, normalized.secret);
    const credentialRef = this.secrets.save(normalized.secret);
    const created = this.store.createConnection({
      name: input.name.trim(),
      provider_id: input.provider_id,
      service_profile: profile,
      config: validated.config,
      credential_ref: credentialRef,
      environment,
      description: input.description ?? null,
      endpoint_hint: validated.endpoint_hint,
      default_storage_id: input.default_storage_id ?? null,
    });
    this.store.audit('connection.created', { connection: created.name, provider: created.provider_id });
    return created;
  }

  updateConnection(idOrName: string, patch: UpdateConnectionInput): ConnectionRecord {
    const existing = this.store.requireConnection(idOrName);
    const provider = this.registry.get(existing.provider_id);
    let config = patch.config ?? existing.config;
    let secret = this.secrets.load(existing.credential_ref);
    if (patch.secret) secret = { ...secret, ...patch.secret };
    if (patch.config) {
      const normalized = normalizeInlineSecret(existing.provider_id, config, secret);
      config = normalized.config;
      secret = normalized.secret;
    }
    const validated = provider.validateConfig(config, secret);
    const credentialRef = patch.secret || patch.config
      ? this.secrets.replace(existing.credential_ref, secret)
      : existing.credential_ref;
    const updated = this.store.updateConnection(existing.id, {
      name: patch.name,
      service_profile: patch.service_profile,
      config: validated.config,
      credential_ref: credentialRef,
      environment: patch.environment,
      description: patch.description,
      is_active: patch.is_active,
      endpoint_hint: validated.endpoint_hint,
      default_storage_id: patch.default_storage_id,
    });
    this.store.audit('connection.updated', { connection: updated.name });
    return updated;
  }

  deleteConnection(idOrName: string): void {
    const existing = this.store.requireConnection(idOrName);
    const active = this.store
      .listRuns({ limit: 500 })
      .filter((run) => !isTerminal(run.status))
      .some((run) => run.source_connection_id === existing.id || run.target_connection_id === existing.id);
    if (active) {
      throw new UdmtError('CONFLICT', 'Connection has active operations. Cancel or wait for them to finish first.');
    }
    this.store.deleteConnection(existing.id);
    if (existing.credential_ref) this.secrets.delete(existing.credential_ref);
    this.store.audit('connection.deleted', { connection: existing.name, provider: existing.provider_id });
  }

  async testConnection(idOrName: string): Promise<ConnectionTestResult> {
    const connection = this.store.requireConnection(idOrName);
    const provider = this.registry.get(connection.provider_id);
    const secret = this.secrets.load(connection.credential_ref);
    const startedAt = Date.now();
    const result = await provider.testConnection(connection.config, secret, this.operationContextForTest());
    this.store.recordConnectionTest(connection.id, result.success ? 'success' : 'failed');
    return {
      ...result,
      latency_ms: result.latency_ms ?? Date.now() - startedAt,
      provider_id: connection.provider_id,
      service_profile: connection.service_profile,
      tested_at: nowIso(),
      error: result.success ? undefined : { code: 'CONNECTION_FAILED', message: result.diagnostics[0] ?? 'Connection failed' },
    };
  }

  async discoverResources(idOrName: string): Promise<ResourceDescriptor[]> {
    const connection = this.store.requireConnection(idOrName);
    const provider = this.registry.get(connection.provider_id);
    this.registry.assertCapability(connection.provider_id, 'discover_resources');
    const secret = this.secrets.load(connection.credential_ref);
    return provider.discoverResources(connection.config, secret, this.operationContextForTest());
  }

  async resourceSchema(idOrName: string, resource: string): Promise<ResourceSchema> {
    const connection = this.store.requireConnection(idOrName);
    const provider = this.registry.get(connection.provider_id);
    this.registry.assertCapability(connection.provider_id, 'schema_read');
    const secret = this.secrets.load(connection.credential_ref);
    return provider.readSchema!(connection.config, secret, resource, this.operationContextForTest());
  }

  /**
   * Reads one page of rows for the browse view. Never used by exports: the hard
   * limit keeps an interactive read from turning into a full table scan.
   */
  async previewRows(idOrName: string, resource: string, options: { limit?: number } = {}): Promise<RowsPreview> {
    const connection = this.store.requireConnection(idOrName);
    const provider = this.registry.get(connection.provider_id);
    this.registry.assertCapability(connection.provider_id, 'read_data');
    if (!provider.readRows) {
      throw new UdmtError('CAPABILITY_UNSUPPORTED', `Provider "${connection.provider_id}" cannot read rows.`);
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? PREVIEW_ROW_LIMIT), 1), PREVIEW_ROW_LIMIT);
    const secret = this.secrets.load(connection.credential_ref);
    const startedAt = Date.now();
    const ctx = this.operationContextForTest();
    let columns: ColumnSchema[] = [];
    try {
      columns = (await provider.readSchema?.(connection.config, secret, resource, ctx))?.columns ?? [];
    } catch {
      // Schema is a nice-to-have here: rows are still worth showing when a
      // sampled collection cannot be inferred under the current permissions.
      columns = [];
    }
    const rows: RowBatch = [];
    for await (const batch of provider.readRows(
      connection.config,
      secret,
      { resource, limit, batchSize: Math.min(limit, 500) },
      ctx,
    )) {
      rows.push(...batch);
      if (rows.length >= limit) break;
    }
    return {
      resource,
      columns,
      rows: rows.slice(0, limit),
      limit,
      truncated: rows.length >= limit,
      latency_ms: Date.now() - startedAt,
    };
  }

  // ------------------------------------------------------------------ operations
  exportData(request: ExportRequest) {
    return this.engine.export(request);
  }

  startExport(request: ExportRequest) {
    return this.engine.startExport(request);
  }

  importData(request: ImportRequest) {
    return this.engine.import(request);
  }

  startImport(request: ImportRequest) {
    return this.engine.startImport(request);
  }

  cancelRun(runId: string): OperationRun {
    return this.engine.cancel(runId);
  }

  verifyArtifact(artifactId: string) {
    return this.engine.verifyArtifact(artifactId);
  }

  listRuns(options: { limit?: number; status?: string; operation_type?: string } = {}): OperationRun[] {
    return this.store.listRuns(options);
  }

  getRun(idOrPrefix: string): OperationRun {
    return this.store.resolveRun(idOrPrefix);
  }

  runLogs(runIdOrPrefix: string, options: { limit?: number; afterSequence?: number } = {}): OperationLogEntry[] {
    const run = this.store.resolveRun(runIdOrPrefix);
    return this.store.listLogs(run.id, options);
  }

  // ------------------------------------------------------------------ artifacts
  listArtifacts(options: { limit?: number } = {}): ArtifactRecord[] {
    return this.store.listArtifacts(options);
  }

  getArtifact(id: string): ArtifactRecord {
    return this.store.requireArtifact(id);
  }

  pinArtifact(id: string, pinned: boolean): ArtifactRecord {
    this.store.requireArtifact(id);
    this.store.setArtifactPinned(id, pinned);
    return this.store.requireArtifact(id);
  }

  async deleteArtifact(id: string): Promise<void> {
    const artifact = this.store.requireArtifact(id);
    if (artifact.pinned) throw new UdmtError('CONFLICT', 'Artifact is pinned. Unpin it before deleting.');
    const verifying = this.store
      .listRuns({ limit: 100 })
      .some((run) => run.operation_type === 'verify' && run.source_label === id && !isTerminal(run.status));
    if (verifying) throw new UdmtError('CONFLICT', 'Artifact is being verified right now.');
    await this.removeArtifactObject(artifact);
    this.store.deleteArtifactRecord(id);
    this.store.audit('artifact.deleted', { artifact_id: id, path: artifact.absolute_path });
  }

  /**
   * Deletes the bytes behind an artifact without touching its record. External
   * files are removed by absolute path; managed artifacts go through the storage
   * backend so S3/R2 objects and named local roots behave the same.
   */
  private async removeArtifactObject(artifact: ArtifactRecord): Promise<void> {
    if (artifact.manifest.output_mode === 'external' || /^[A-Za-z]:[\\/]|^\//.test(artifact.object_key)) {
      await rm(artifact.absolute_path, { force: true }).catch(() => undefined);
      await rm(`${artifact.absolute_path}.manifest.json`, { force: true }).catch(() => undefined);
      return;
    }
    try {
      const backend = this.storageBackend(artifact.storage_backend_id);
      await backend.deleteObject(artifact.object_key);
      await backend.deleteObject(`${artifact.object_key}.manifest.json`).catch(() => undefined);
    } catch (error) {
      // A missing backend should not strand the metadata row; surface the reason.
      if ((error as UdmtError).code !== 'NOT_FOUND') throw error;
    }
  }

  /**
   * Retention cleanup (roadmap 9.3): keeps the newest `keep_last` artifacts per
   * provider, deletes unpinned artifacts older than `older_than_days`, and never
   * touches artifacts used by a running operation.
   */
  async cleanupArtifacts(options: { older_than_days: number; keep_last?: number; dry_run?: boolean }): Promise<{
    deleted: ArtifactRecord[];
    kept: number;
    skipped_reasons: string[];
  }> {
    if (!Number.isFinite(options.older_than_days) || options.older_than_days < 0) {
      throw new UdmtError('INVALID_INPUT', 'older_than_days must be a positive number.');
    }
    const keepLast = Math.max(0, options.keep_last ?? 0);
    const all = this.store.listArtifacts({ limit: 5000 });
    const cutoff = Date.now() - options.older_than_days * 86_400_000;
    const byProvider = new Map<string, ArtifactRecord[]>();
    for (const artifact of all) {
      const key = artifact.provider_id ?? 'unknown';
      const list = byProvider.get(key) ?? [];
      list.push(artifact);
      byProvider.set(key, list);
    }

    const deleted: ArtifactRecord[] = [];
    const skipped: string[] = [];
    for (const [, artifacts] of byProvider) {
      const sorted = [...artifacts].sort((a, b) => b.created_at.localeCompare(a.created_at));
      sorted.forEach((artifact, index) => {
        if (index < keepLast) return;
        if (new Date(artifact.created_at).getTime() >= cutoff) return;
        if (artifact.pinned) {
          skipped.push(`${artifact.id}: pinned`);
          return;
        }
        if (options.dry_run) {
          deleted.push(artifact);
          return;
        }
        try {
          if (artifact.manifest.output_mode !== 'external') {
            // Only delete inside a managed root. A named backend resolves its
            // own root; remote artifacts never have a local file to inspect.
            try {
              const backend = this.storageBackend(artifact.storage_backend_id);
              const local = !backend.isRemote && existsSync(artifact.absolute_path);
              if (local && !artifact.absolute_path.startsWith((backend as LocalStorageBackend).root)) {
                skipped.push(`${artifact.id}: outside managed root`);
                return;
              }
            } catch {
              skipped.push(`${artifact.id}: storage backend missing`);
              return;
            }
          }
          this.store.deleteArtifactRecord(artifact.id);
          deleted.push(artifact);
        } catch (error) {
          skipped.push(`${artifact.id}: ${(error as Error).message}`);
        }
      });
    }

    if (!options.dry_run) {
      for (const artifact of deleted) {
        try {
          await this.removeArtifactObject(artifact);
        } catch (error) {
          skipped.push(`${artifact.id}: ${(error as Error).message}`);
        }
      }
      // Remove empty run directories owned by the managed local backend.
      for (const artifact of deleted) {
        if (!artifact.absolute_path.startsWith(this.managedStorage.root)) continue;
        const dir = resolve(artifact.absolute_path, '..');
        if (dir.startsWith(this.managedStorage.root)) {
          await rm(dir, { recursive: false }).catch(() => undefined);
        }
      }
      this.store.audit('retention.cleanup', {
        deleted: deleted.length,
        older_than_days: options.older_than_days,
        keep_last: keepLast,
      });
    }
    return { deleted, kept: all.length - deleted.length, skipped_reasons: skipped };
  }

  // ------------------------------------------------------------------ storage
  listStorageBackends(): StorageBackendRecord[] {
    return this.store.listStorageBackends();
  }

  getStorageBackend(idOrName: string): StorageBackendRecord {
    return this.store.requireStorageBackend(idOrName);
  }

  /** Instantiates a backend from its catalog record and vault secret. */
  storageBackend(idOrName?: string | null): StorageBackend {
    const record = this.store.requireStorageBackend(idOrName ?? null);
    const secret = record.credential_ref ? this.secrets.load(record.credential_ref) : {};
    return buildStorageBackend(this.paths, record, secret);
  }

  createStorageBackend(input: CreateStorageBackendInput): StorageBackendRecord {
    if (!input.name?.trim()) throw new UdmtError('INVALID_INPUT', 'Storage backend name is required.');
    if (!STORAGE_BACKEND_TYPES.includes(input.backend_type)) {
      throw new UdmtError('INVALID_INPUT', `Unknown storage backend type: ${input.backend_type}`);
    }
    const name = input.name.trim();
    const config =
      input.backend_type === 'local'
        ? { ...(input.config ?? {}), root: resolve(String(input.config?.root ?? resolve(this.paths.artifactsDir, sanitizeName(name)))) }
        : { ...(input.config ?? {}) };
    const secret = input.secret ?? {};
    // Validate before persisting so an invalid backend never lands in the catalog.
    const candidate = buildStorageBackend(
      this.paths,
      {
        id: 'pending',
        name,
        backend_type: input.backend_type,
        config,
        credential_ref: null,
        is_default: false,
        endpoint_hint: null,
        last_tested_at: null,
        last_test_status: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      secret,
    );
    const credentialRef = Object.keys(secret).length > 0 ? this.secrets.save(secret) : null;
    const created = this.store.createStorageBackend({
      name,
      backend_type: input.backend_type,
      config,
      credential_ref: credentialRef,
      endpoint_hint: candidate.endpoint_hint,
      is_default: input.is_default ?? false,
    });
    this.store.audit('storage.created', { storage: created.name, type: created.backend_type });
    return created;
  }

  updateStorageBackend(idOrName: string, patch: UpdateStorageBackendInput): StorageBackendRecord {
    const existing = this.store.requireStorageBackend(idOrName);
    if (existing.id === 'local-default' && patch.config) {
      throw new UdmtError('PRECONDITION_FAILED', 'The built-in local backend location cannot be changed.');
    }
    const config = patch.config ?? existing.config;
    const secret = patch.secret ? { ...this.secrets.load(existing.credential_ref), ...patch.secret } : this.secrets.load(existing.credential_ref);
    const candidate = buildStorageBackend(this.paths, { ...existing, config }, secret);
    const credentialRef = patch.secret || patch.config
      ? this.secrets.replace(existing.credential_ref, secret)
      : existing.credential_ref;
    const updated = this.store.updateStorageBackend(existing.id, {
      name: patch.name,
      config,
      credential_ref: credentialRef,
      endpoint_hint: candidate.endpoint_hint,
    });
    this.store.audit('storage.updated', { storage: updated.name });
    return updated;
  }

  deleteStorageBackend(idOrName: string): void {
    const existing = this.store.requireStorageBackend(idOrName);
    this.store.deleteStorageBackend(existing.id);
    if (existing.credential_ref) this.secrets.delete(existing.credential_ref);
    this.store.audit('storage.deleted', { storage: existing.name });
  }

  setDefaultStorageBackend(idOrName: string): StorageBackendRecord {
    const updated = this.store.setDefaultStorageBackend(idOrName);
    this.store.audit('storage.default', { storage: updated.name });
    return updated;
  }

  async testStorageBackend(idOrName: string): Promise<StorageTestResult> {
    const record = this.store.requireStorageBackend(idOrName);
    const backend = this.storageBackend(record.id);
    const result = await backend.test();
    this.store.recordStorageTest(record.id, result.success ? 'success' : 'failed', result.endpoint_hint);
    return { ...result, tested_at: nowIso() };
  }

  // ------------------------------------------------------------------ sync
  listSyncPipelines(): SyncPipelineRecord[] {
    return this.store.listSyncPipelines();
  }

  getSyncPipeline(idOrName: string): SyncPipelineRecord {
    return this.store.requireSyncPipeline(idOrName);
  }

  createSyncPipeline(input: CreateSyncPipelineInput): SyncPipelineRecord {
    const name = input.name?.trim();
    if (!name) throw new UdmtError('INVALID_INPUT', 'Sync pipeline name is required.');
    const source = this.store.requireConnection(input.source_connection_id);
    const target = this.store.requireConnection(input.target_connection_id);
    const sourceResource = input.source_resource?.trim();
    const targetResource = input.target_resource?.trim();
    if (!sourceResource) throw new UdmtError('INVALID_INPUT', 'Source resource is required.');
    if (!targetResource) throw new UdmtError('INVALID_INPUT', 'Target resource is required.');
    const loadMode = this.normalizeSyncLoadMode(input.load_mode ?? 'append');
    const keyColumns = this.normalizeSyncKeys(loadMode, input.key_columns ?? [], input.mapping ?? []);
    if (this.store.getSyncPipeline(name)) {
      throw new UdmtError('ALREADY_EXISTS', `Sync pipeline "${name}" already exists.`);
    }
    const created = this.store.createSyncPipeline({
      name,
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: sourceResource,
      target_resource: targetResource,
      mapping: this.normalizeSyncMapping(input.mapping ?? []),
      load_mode: loadMode,
      key_columns: keyColumns,
      options: this.normalizeSyncOptions(input.options ?? {}),
      enabled: input.enabled ?? true,
    });
    this.store.audit('sync.pipeline_created', { pipeline: created.name, mode: created.load_mode });
    return created;
  }

  updateSyncPipeline(idOrName: string, patch: UpdateSyncPipelineInput): SyncPipelineRecord {
    const existing = this.store.requireSyncPipeline(idOrName);
    const source = patch.source_connection_id
      ? this.store.requireConnection(patch.source_connection_id)
      : this.store.requireConnection(existing.source_connection_id);
    const target = patch.target_connection_id
      ? this.store.requireConnection(patch.target_connection_id)
      : this.store.requireConnection(existing.target_connection_id);
    if (patch.name && patch.name.trim() !== existing.name) {
      const duplicate = this.store.getSyncPipeline(patch.name.trim());
      if (duplicate) throw new UdmtError('ALREADY_EXISTS', `Sync pipeline "${patch.name}" already exists.`);
    }
    const loadMode = patch.load_mode ? this.normalizeSyncLoadMode(patch.load_mode) : existing.load_mode;
    const mapping = patch.mapping ? this.normalizeSyncMapping(patch.mapping) : existing.mapping;
    const keyColumns = this.normalizeSyncKeys(
      loadMode,
      patch.key_columns ?? existing.key_columns,
      mapping,
    );
    const updated = this.store.updateSyncPipeline(existing.id, {
      name: patch.name?.trim() ?? existing.name,
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_resource: patch.source_resource?.trim() ?? existing.source_resource,
      target_resource: patch.target_resource?.trim() ?? existing.target_resource,
      mapping,
      load_mode: loadMode,
      key_columns: keyColumns,
      options: patch.options ? this.normalizeSyncOptions({ ...existing.options, ...patch.options }) : existing.options,
      enabled: patch.enabled ?? existing.enabled,
    });
    this.store.audit('sync.pipeline_updated', { pipeline: updated.name });
    return updated;
  }

  deleteSyncPipeline(idOrName: string): void {
    const pipeline = this.store.requireSyncPipeline(idOrName);
    const active = this.store
      .listRuns({ limit: 500 })
      .filter((run) => !isTerminal(run.status) && run.operation_type === 'sync')
      .some((run) => (run.config as { pipeline_id?: string }).pipeline_id === pipeline.id);
    if (active) throw new UdmtError('CONFLICT', 'Sync pipeline has an active run. Cancel or wait for it to finish first.');
    this.store.deleteSyncPipeline(pipeline.id);
    this.store.audit('sync.pipeline_deleted', { pipeline: pipeline.name });
  }

  syncState(idOrName: string): SyncStateRecord | null {
    const pipeline = this.store.requireSyncPipeline(idOrName);
    return this.store.getSyncState(pipeline.id) ?? null;
  }

  syncErrors(runIdOrPrefix: string, limit = 200): SyncRunError[] {
    const run = this.store.resolveRun(runIdOrPrefix);
    return this.store.listSyncErrors(run.id, limit);
  }

  runSync(request: SyncRequest) {
    return this.engine.sync(request);
  }

  /**
   * Dry-run preflight used by the UI/API before the first real run. Samples a
   * bounded number of rows so a broken mapping never touches the target.
   */
  validateSyncPipeline(idOrName: string, options: { limit?: number; batch_size?: number } = {}) {
    const pipeline = this.store.requireSyncPipeline(idOrName);
    return this.engine.sync({
      pipeline_id: pipeline.id,
      dry_run: true,
      limit: Math.min(Math.max(options.limit ?? 100, 1), 5000),
      ...(options.batch_size ? { batch_size: options.batch_size } : {}),
    });
  }

  createSyncJob(input: {
    name: string;
    pipeline_id: string;
    dry_run?: boolean;
    limit?: number;
    batch_size?: number;
    on_error?: 'fail' | 'skip';
    confirm?: string;
    schedule?: ScheduleInput;
  }): { job: JobRecord; schedule: ScheduleRecord | null } {
    const pipeline = this.store.requireSyncPipeline(input.pipeline_id);
    if (!input.name?.trim()) throw new UdmtError('INVALID_INPUT', 'Job name is required.');
    const job = this.store.createJob({
      name: input.name.trim(),
      operation_type: 'sync',
      source_connection_id: pipeline.source_connection_id,
      target_connection_id: pipeline.target_connection_id,
      storage_backend_id: null,
      config: {
        pipeline_id: pipeline.id,
        ...(input.dry_run !== undefined ? { dry_run: input.dry_run } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.batch_size !== undefined ? { batch_size: input.batch_size } : {}),
        ...(input.on_error !== undefined ? { on_error: input.on_error } : {}),
        ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
      },
    });
    const schedule = input.schedule ? this.addSchedule(job.id, input.schedule) : null;
    return { job, schedule };
  }

  private normalizeSyncLoadMode(mode: SyncLoadMode): SyncLoadMode {
    if (!SYNC_LOAD_MODES.includes(mode)) {
      throw new UdmtError('INVALID_INPUT', `Unknown sync load mode: ${String(mode)}`);
    }
    return mode === 'replace_resource' ? 'truncate_and_load' : mode;
  }

  private normalizeSyncMapping(mapping: SyncFieldMapping[]): SyncFieldMapping[] {
    const seen = new Set<string>();
    for (const entry of mapping) {
      const source = entry.source?.trim();
      const target = (entry.target ?? entry.source)?.trim();
      if (!source || !target) {
        throw new UdmtError('INVALID_INPUT', 'Every mapping entry needs a source and target field.');
      }
      if (seen.has(target)) {
        throw new UdmtError('INVALID_INPUT', `Two mapping entries write the same target field "${target}".`);
      }
      seen.add(target);
      if (entry.mask && !['email', 'full', 'last4'].includes(entry.mask)) {
        throw new UdmtError('INVALID_INPUT', `Unknown mask "${String(entry.mask)}".`);
      }
    }
    return mapping.map((entry) => ({ ...entry, source: entry.source.trim(), target: (entry.target ?? entry.source).trim() }));
  }

  private normalizeSyncKeys(mode: SyncLoadMode, keyColumns: string[], mapping: SyncFieldMapping[]): string[] {
    const keys = [...new Set(keyColumns.map((key) => key.trim()).filter(Boolean))];
    if (mode === 'upsert' && keys.length === 0) {
      throw new UdmtError('INVALID_INPUT', 'Sync mode upsert requires at least one key column.');
    }
    if (keys.length > 0 && mapping.length > 0) {
      const targets = new Set(mapping.map((entry) => (entry.target ?? entry.source).trim()));
      const invalid = keys.filter((key) => !targets.has(key));
      if (invalid.length > 0) {
        throw new UdmtError('INVALID_INPUT', `Key columns are not mapped to the target: ${invalid.join(', ')}`);
      }
    }
    return keys;
  }

  private normalizeSyncOptions(options: SyncOptions): SyncOptions {
    if (options.batch_size !== undefined && (!Number.isInteger(options.batch_size) || options.batch_size < 1 || options.batch_size > 5000)) {
      throw new UdmtError('INVALID_INPUT', 'Sync batch_size must be between 1 and 5000.');
    }
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
      throw new UdmtError('INVALID_INPUT', 'Sync limit must be a positive integer.');
    }
    if (options.filter && !options.filter.column) {
      throw new UdmtError('INVALID_INPUT', 'Sync filter needs a column.');
    }
    if (options.filter?.operator === 'in' && !Array.isArray(options.filter.value)) {
      throw new UdmtError('INVALID_INPUT', 'Sync filter operator "in" needs an array value.');
    }
    return options;
  }

  // ------------------------------------------------------------------ jobs & schedules
  listJobs(): JobRecord[] {
    return this.store.listJobs();
  }

  createExportJob(input: {
    name: string;
    connection_id: string;
    resource: string;
    format: 'jsonl' | 'csv' | 'json';
    compression?: 'none' | 'gzip';
    output_dir?: string;
    batch_size?: number;
    schedule?: ScheduleInput;
  }): { job: JobRecord; schedule: ScheduleRecord | null } {
    const connection = this.store.requireConnection(input.connection_id);
    const job = this.store.createJob({
      name: input.name,
      operation_type: 'export',
      source_connection_id: connection.id,
      target_connection_id: null,
      storage_backend_id: connection.default_storage_id,
      config: {
        connection_id: connection.id,
        resource: input.resource,
        format: input.format,
        compression: input.compression ?? 'gzip',
        output_dir: input.output_dir,
        batch_size: input.batch_size,
      },
    });
    const schedule = input.schedule ? this.addSchedule(job.id, input.schedule) : null;
    return { job, schedule };
  }

  createImportJob(input: {
    name: string;
    connection_id: string;
    resource: string;
    source_path: string;
    format?: 'jsonl' | 'csv' | 'json';
    mode: 'append' | 'upsert' | 'truncate_and_load';
    key_columns?: string[];
    confirm?: string;
    dry_run?: boolean;
    schedule?: ScheduleInput;
  }): { job: JobRecord; schedule: ScheduleRecord | null } {
    const connection = this.store.requireConnection(input.connection_id);
    const job = this.store.createJob({
      name: input.name,
      operation_type: 'import',
      source_connection_id: null,
      target_connection_id: connection.id,
      storage_backend_id: null,
      config: {
        connection_id: connection.id,
        resource: input.resource,
        source: { path: input.source_path },
        format: input.format,
        mode: input.mode,
        key_columns: input.key_columns,
        dry_run: input.dry_run,
        confirm: input.confirm,
      },
    });
    const schedule = input.schedule ? this.addSchedule(job.id, input.schedule) : null;
    return { job, schedule };
  }

  addSchedule(jobId: string, input: ScheduleInput): ScheduleRecord {
    validateSchedule(input);
    const next = nextRunAt(input);
    return this.store.createSchedule({
      job_id: jobId,
      schedule_type: input.schedule_type,
      schedule_config: input.schedule_config,
      timezone: input.timezone,
      next_run_at: next ? next.toISOString() : null,
      enabled: input.enabled ?? true,
    });
  }

  listSchedules(): Array<ScheduleRecord & { job: JobRecord | null; description: string }> {
    return this.store.listSchedules().map((schedule) => ({
      ...schedule,
      job: this.store.getJob(schedule.job_id) ?? null,
      description: describeSchedule({
        schedule_type: schedule.schedule_type,
        schedule_config: schedule.schedule_config,
        timezone: schedule.timezone,
      }),
    }));
  }

  setScheduleEnabled(id: string, enabled: boolean): ScheduleRecord {
    const schedule = this.store.requireSchedule(id);
    const next = enabled
      ? nextRunAt(
          { schedule_type: schedule.schedule_type, schedule_config: schedule.schedule_config, timezone: schedule.timezone },
          new Date(),
        )
      : null;
    return this.store.updateSchedule(id, { enabled, next_run_at: next ? next.toISOString() : null });
  }

  deleteSchedule(id: string): void {
    this.store.deleteSchedule(id);
  }

  deleteJob(id: string): void {
    this.store.deleteJob(id);
  }

  // ------------------------------------------------------------------ worker
  workerStatus(): WorkerStatus {
    const instance = this.store.latestWorkerInstance();
    if (!instance) return { running: false, stale: false, instance: null, heartbeat_age_seconds: null };
    const ageMs = Date.now() - new Date(instance.heartbeat_at).getTime();
    const stale = ageMs > 45_000;
    return {
      running: !stale && instance.status !== 'stopped',
      stale,
      instance,
      heartbeat_age_seconds: Math.round(ageMs / 1000),
    };
  }

  markWorkerStopped(): void {
    const latest = this.store.latestWorkerInstance();
    if (latest) {
      this.store.upsertWorkerInstance({ ...latest, status: 'stopped', heartbeat_at: nowIso(), tasks_running: 0 });
    }
  }

  // ------------------------------------------------------------------ diagnostics
  doctor(): DoctorReport {
    const integrity = this.db.integrityCheck();
    const worker = this.workerStatus();
    return {
      app_version: APP_VERSION,
      data_dir: this.paths.dataDir,
      db_path: this.paths.dbPath,
      artifacts_dir: this.paths.artifactsDir,
      node_version: process.version,
      platform: `${process.platform}-${process.arch}`,
      secret_backend: this.secrets.backendName,
      secret_warning: this.secrets.warning,
      db_integrity: integrity === 'ok' ? 'ok' : 'failed',
      providers: this.registry.list(),
      worker: { running: worker.running, instance: worker.instance },
      counts: this.store.counts(),
    };
  }

  /** A context with no durable run: used for connection tests and discovery. */
  private operationContextForTest() {
    return {
      runId: 'interactive',
      signal: new AbortController().signal,
      throwIfCancelled: () => undefined,
      progress: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    };
  }
}

function isTerminal(status: OperationRun['status']): boolean {
  return ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(status);
}

/**
 * Accepts full connection URLs (including a password) for convenience and moves
 * the credential into the secret vault so it never lands in SQLite.
 */
export function normalizeInlineSecret(
  providerId: string,
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
): { config: Record<string, unknown>; secret: Record<string, unknown> } {
  const nextConfig = { ...config };
  const nextSecret = { ...secret };
  try {
    if (providerId === 'mongodb' && typeof nextConfig.uri === 'string') {
      const match = /^(mongodb(?:\+srv)?:\/\/)([^:@/]+):([^@/]+)@(.*)$/.exec(nextConfig.uri);
      if (match) {
        const [, scheme, user, password, rest] = match;
        nextConfig.uri = `${scheme}${encodeURIComponent(decodeURIComponent(user!))}@${rest}`;
        if (!nextSecret.password) nextSecret.password = decodeURIComponent(password!);
      }
    }
    if ((providerId === 'postgresql' || providerId === 'mysql') && typeof nextConfig.url === 'string') {
      const url = new URL(nextConfig.url);
      nextConfig.host = url.hostname;
      nextConfig.port = url.port ? Number(url.port) : providerId === 'mysql' ? 3306 : 5432;
      nextConfig.database = url.pathname.replace(/^\//, '') || nextConfig.database;
      nextConfig.user = decodeURIComponent(url.username);
      if (url.password && !nextSecret.password) nextSecret.password = decodeURIComponent(url.password);
      if (url.searchParams.get('sslmode') === 'disable') nextConfig.ssl = 'disable';
      delete nextConfig.url;
    }
    if (providerId === 'postgresql' && typeof nextConfig.connection_string === 'string') {
      return normalizeInlineSecret(providerId, { ...nextConfig, url: nextConfig.connection_string }, nextSecret);
    }
  } catch (error) {
    throw new UdmtError('INVALID_CONFIG', `Could not parse the connection URL: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return { config: nextConfig, secret: nextSecret };
}

export async function startupDiagnostics(app: UdmtApp): Promise<string[]> {
  const report = app.doctor();
  const lines: string[] = [];
  lines.push(`udmt ${report.app_version} · node ${report.node_version} · ${report.platform}`);
  lines.push(`data: ${report.data_dir}`);
  lines.push(`db: ${report.db_path} (${report.db_integrity})`);
  lines.push(`secrets: ${report.secret_backend}`);
  if (report.secret_warning) lines.push(`warning: ${report.secret_warning}`);
  return lines;
}

export function newWorkerInstance(tasksRunning = 0): WorkerInstance {
  return {
    id: newId(),
    pid: process.pid,
    hostname: hostname(),
    version: APP_VERSION,
    status: 'starting',
    started_at: nowIso(),
    heartbeat_at: nowIso(),
    last_error: null,
    tasks_running: tasksRunning,
  };
}

export function assertArtifactFile(artifact: ArtifactRecord): void {
  if (!existsSync(artifact.absolute_path)) {
    throw new UdmtError('NOT_FOUND', `Artifact file is missing: ${artifact.absolute_path}`);
  }
}

export function redactRun(run: OperationRun): OperationRun {
  return {
    ...run,
    error_message_safe: run.error_message_safe ? truncate(run.error_message_safe, 1000) : null,
    config: sanitizeRunConfig(run.config),
  };
}

function sanitizeRunConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (/password|secret|token|uri|url/i.test(key)) {
      out[key] = '***';
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function checksumOf(path: string): Promise<string> {
  return sha256File(join(path));
}

export type { CapabilityId };
export { toUdmtError };

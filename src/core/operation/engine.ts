import { existsSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { UdmtError, isUdmtError, toUdmtError, sanitizeErrorMessage } from '../errors.js';
import type { AppPaths } from '../paths.js';
import type { Store } from '../db/store.js';
import type { SecretStore } from '../secrets.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { OperationContext, DataProvider } from '../providers/contract.js';
import { hasCapability, inferType } from '../providers/contract.js';
import type { LocalStorageBackend } from '../storage/local.js';
import type { StorageBackend } from '../storage/contract.js';
import { createFormatWriter, defaultExtension, detectFormat, readRowsFromFile, type FormatWriter } from '../formats/index.js';
import {
  SyncRowError,
  compileSyncMapping,
  evaluateSyncFilter,
  syncTargetColumns,
  transformSyncRow,
  type CompiledSyncField,
} from '../sync/pipeline.js';
import { assertSafePath, assertSafeSegment } from '../paths.js';
import { APP_VERSION, fileSize, newId, nowIso, sanitizeName, sha256File, timestampForFilename, truncate } from '../utils.js';
import type {
  ArtifactManifest,
  ArtifactRecord,
  ColumnSchema,
  Compression,
  ExportFormat,
  ExportRequest,
  ImportRequest,
  OperationRun,
  OperationStatus,
  RunProgress,
  RowBatch,
  SyncPipelineRecord,
  SyncRequest,
} from '../types.js';
import { EXPORT_FORMATS } from '../types.js';

const ExportSchema = z.object({
  connection_id: z.string().min(1),
  resource: z.string().min(1),
  format: z.enum(['jsonl', 'csv', 'json']),
  compression: z.enum(['none', 'gzip']),
  output_dir: z.string().optional(),
  limit: z.number().int().positive().optional(),
  batch_size: z.number().int().min(1).max(5000).optional(),
  columns: z.array(z.string().min(1)).optional(),
  storage_backend_id: z.string().optional(),
  label: z.string().optional(),
});

const ImportSchema = z.object({
  connection_id: z.string().min(1),
  resource: z.string().min(1),
  source: z.object({ artifact_id: z.string().optional(), path: z.string().optional() }),
  format: z.enum(['jsonl', 'csv', 'json']).optional(),
  mode: z.enum(['append', 'upsert', 'truncate_and_load']),
  key_columns: z.array(z.string().min(1)).optional(),
  batch_size: z.number().int().min(1).max(5000).optional(),
  dry_run: z.boolean().optional(),
  confirm: z.string().optional(),
  create_resource: z.boolean().optional(),
});

const SyncSchema = z.object({
  pipeline_id: z.string().min(1),
  dry_run: z.boolean().optional(),
  confirm: z.string().optional(),
  limit: z.number().int().positive().optional(),
  batch_size: z.number().int().min(1).max(5000).optional(),
  on_error: z.enum(['fail', 'skip']).optional(),
});

export interface EngineDeps {
  store: Store;
  registry: ProviderRegistry;
  secrets: SecretStore;
  paths: AppPaths;
  managedStorage: LocalStorageBackend;
  resolveStorage: (idOrName?: string | null) => StorageBackend;
}

export interface StartedOperation {
  run: OperationRun;
  done: Promise<OperationRun>;
}

export interface ExportOutcome {
  run: OperationRun;
  artifact: ArtifactRecord;
}

export interface ImportOutcome {
  run: OperationRun;
}

export class OperationEngine {
  private readonly controllers = new Map<string, AbortController>();
  private readonly lastProgressWrite = new Map<string, number>();

  constructor(private readonly deps: EngineDeps) {}

  // ------------------------------------------------------------------ context
  private makeContext(run: OperationRun, controller: AbortController): OperationContext {
    const { store } = this.deps;
    let cancelled = false;
    const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
      const safe = sanitizeErrorMessage(truncate(message, 2000));
      try {
        store.appendLog(run.id, level, safe, run.stage);
      } catch {
        /* logging must never break the operation */
      }
    };
    const progress = (update: { percent?: number; stage?: string; message?: string; metrics?: Record<string, unknown> }): void => {
      const now = Date.now();
      const last = this.lastProgressWrite.get(run.id) ?? 0;
      if (now - last < 250 && (update.percent ?? 0) < 100) return;
      this.lastProgressWrite.set(run.id, now);
      const current = store.getRun(run.id);
      const previous = current?.progress;
      const next: RunProgress = {
        percent: Math.max(0, Math.min(100, update.percent ?? previous?.percent ?? 0)),
        stage: update.stage ?? previous?.stage ?? run.status,
        ...(update.message ? { message: update.message } : {}),
        ...(update.metrics?.rows_read !== undefined ? { rows_read: Number(update.metrics.rows_read) } : {}),
        ...(update.metrics?.rows_written !== undefined ? { rows_written: Number(update.metrics.rows_written) } : {}),
        ...(update.metrics?.bytes_written !== undefined ? { bytes_written: Number(update.metrics.bytes_written) } : {}),
      };
      try {
        store.updateRunProgress(run.id, next);
      } catch {
        /* progress is best effort */
      }
    };
    return {
      runId: run.id,
      signal: controller.signal,
      throwIfCancelled: () => {
        if (controller.signal.aborted || cancelled) {
          throw new UdmtError('OPERATION_CANCELLED', 'Operation was cancelled.');
        }
        const fresh = store.getRun(run.id);
        if (fresh?.status === 'cancel_requested') {
          cancelled = true;
          throw new UdmtError('OPERATION_CANCELLED', 'Operation was cancelled.');
        }
      },
      progress,
      log,
      warn: (message: string) => log('warn', message),
    };
  }

  cancel(runId: string): OperationRun {
    const run = this.deps.store.requireRun(runId);
    if (['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      return run;
    }
    const controller = this.controllers.get(run.id);
    if (run.status !== 'cancel_requested') {
      this.deps.store.updateRunStatus(run.id, 'cancel_requested', { stage: 'cancel_requested' });
    }
    controller?.abort();
    return this.deps.store.requireRun(run.id);
  }

  isRunningLocally(runId: string): boolean {
    return this.controllers.has(runId);
  }

  // ------------------------------------------------------------------ export
  startExport(request: ExportRequest, options: { jobId?: string | null; workerId?: string | null } = {}): StartedOperation {
    const parsed = ExportSchema.safeParse(request);
    if (!parsed.success) {
      throw new UdmtError('INVALID_INPUT', `Export request is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const req = parsed.data;
    const connection = this.deps.store.requireConnection(req.connection_id);
    if (!connection.is_active) {
      throw new UdmtError('PRECONDITION_FAILED', `Connection "${connection.name}" is disabled.`);
    }
    const run = this.deps.store.createRun({
      operation_type: 'export',
      status: 'queued',
      source_connection_id: connection.id,
      target_connection_id: null,
      source_label: connection.name,
      target_label: null,
      resource: req.resource,
      config: { ...req, provider_id: connection.provider_id },
      job_id: options.jobId ?? null,
      worker_instance_id: options.workerId ?? null,
    });
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const done = this.executeExport(run, req, controller).finally(() => this.controllers.delete(run.id));
    return { run, done };
  }

  async export(request: ExportRequest): Promise<ExportOutcome> {
    const started = this.startExport(request);
    const run = await started.done;
    if (run.status !== 'completed' && run.status !== 'completed_with_warnings') {
      throw new UdmtError(
        (run.error_code as never) ?? 'OPERATION_FAILED',
        run.error_message_safe ?? `Export finished with status ${run.status}`,
        { details: { run_id: run.id } },
      );
    }
    const artifactId = String(run.result?.artifact_id ?? '');
    const artifact = this.deps.store.getArtifact(artifactId);
    if (!artifact) throw new UdmtError('NOT_FOUND', `Export artifact missing for run ${run.id}`);
    return { run, artifact };
  }

  private async executeExport(run: OperationRun, req: z.infer<typeof ExportSchema>, controller: AbortController): Promise<OperationRun> {
    const { store, registry, secrets, resolveStorage, managedStorage } = this.deps;
    const ctx = this.makeContext(run, controller);
    let writer: FormatWriter | undefined;
    let dataPath: string | undefined;
    let sidecarPath: string | undefined;
    let uploadedObject: { backend: StorageBackend; key: string } | undefined;
    const warnings: string[] = [];

    try {
      store.updateRunStatus(run.id, 'preparing', { stage: 'preparing', started_at: nowIso() });
      const connection = store.requireConnection(req.connection_id);
      const provider = registry.get(connection.provider_id);
      const secret = secrets.load(connection.credential_ref);
      const descriptor = provider.descriptor();

      if (!hasCapability(descriptor, 'read_data')) {
        throw new UdmtError('CAPABILITY_UNSUPPORTED', `Provider "${connection.provider_id}" cannot read data.`);
      }
      if (!hasCapability(descriptor, 'schema_read')) {
        throw new UdmtError('CAPABILITY_UNSUPPORTED', `Provider "${connection.provider_id}" cannot describe the resource schema.`);
      }

      store.updateRunStatus(run.id, 'preflight', { stage: 'preflight' });
      const validated = provider.validateConfig(connection.config, secret);
      ctx.log('info', `Preflight: ${connection.provider_id} ${validated.endpoint_hint} -> ${req.resource}`);

      const schema = await provider.readSchema!(validated.config, secret, req.resource, ctx);
      if (schema.columns.length === 0) {
        throw new UdmtError('PRECONDITION_FAILED', `Resource ${req.resource} has no columns to export.`);
      }
      const selected = req.columns?.length
        ? schema.columns.filter((column) => req.columns!.includes(column.name))
        : schema.columns;
      const missingColumns = req.columns?.filter((name) => !schema.columns.some((column) => column.name === name)) ?? [];
      if (missingColumns.length > 0) {
        throw new UdmtError('INVALID_INPUT', `Unknown columns requested: ${missingColumns.join(', ')}`);
      }
      const columns: ColumnSchema[] = selected.length > 0 ? selected : schema.columns;

      const backendRecord = req.storage_backend_id
        ? store.requireStorageBackend(req.storage_backend_id)
        : store.requireStorageBackend(connection.default_storage_id ?? undefined);
      const backend = resolveStorage(backendRecord.id);
      const externalDir = req.output_dir ? resolve(req.output_dir) : undefined;
      if (externalDir) {
        if (backend.isRemote) {
          throw new UdmtError(
            'INVALID_INPUT',
            'output_dir cannot be combined with a remote storage backend. Export to the backend and fetch the artifact instead.',
          );
        }
        if (!(/^[A-Za-z]:[\\/]|^\//.test(req.output_dir!) || req.output_dir!.startsWith('~') || externalDir.startsWith(managedStorage.root))) {
          throw new UdmtError('PATH_UNSAFE', 'Relative output directories must resolve inside the managed artifacts root.');
        }
        if (!externalDir.startsWith(managedStorage.root)) {
          ctx.warn('Writing to an explicit external directory outside the managed artifacts root.');
        }
      }

      const targetDir = externalDir ?? (await backend.prepareStagingDir(run.id));
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      const safeResource = sanitizeName(req.resource.replace(/[./\\]/g, '_'));
      const fileName = `${sanitizeName(connection.name)}-${safeResource}-${timestampForFilename()}.${requestExtension(req.format, req.compression)}`;
      dataPath = join(targetDir, assertSafeSegment(fileName.replace(/:/g, '-'), 'file name'));

      const batchSize = req.batch_size ?? 1000;
      writer = createFormatWriter(req.format, req.compression, dataPath, columns);

      store.updateRunStatus(run.id, 'running', { stage: 'running' });
      ctx.log('info', `Export started: ${req.format}${req.compression === 'gzip' ? ' + gzip' : ''}, batch ${batchSize}`);

      const estimate = req.limit ?? schema.rowCountEstimate ?? null;
      let rows = 0;
      let lastLoggedRows = 0;
      const batches = provider.readRows!(
        validated.config,
        secret,
        { resource: req.resource, columns: columns.map((column) => column.name), limit: req.limit, batchSize },
        ctx,
      );

      for await (const batch of batches) {
        ctx.throwIfCancelled();
        for (const row of batch) {
          await writer.write(projectRow(row, columns));
          rows += 1;
        }
        const percent = estimate && estimate > 0 ? Math.min(95, Math.round((rows / estimate) * 95)) : Math.min(90, 10 + Math.log10(Math.max(rows, 1)) * 15);
        ctx.progress({ percent, metrics: { rows_read: rows } });
        if (rows - lastLoggedRows >= 50_000) {
          lastLoggedRows = rows;
          ctx.log('info', `Exported ${rows} rows…`);
        }
      }

      ctx.throwIfCancelled();
      store.updateRunStatus(run.id, 'finalizing', { stage: 'finalizing' });
      const written = await writer.finish();
      writer = undefined;
      const size = await fileSize(dataPath);
      const checksum = await sha256File(dataPath);
      const artifactId = newId();
      const createdAt = nowIso();

      const manifest: ArtifactManifest = {
        manifest_version: '1',
        artifact_id: artifactId,
        operation_type: 'export',
        provider_id: connection.provider_id,
        service_profile: connection.service_profile,
        source_connection_id: connection.id,
        source_label: connection.name,
        resource: req.resource,
        created_at: createdAt,
        tool_name: 'udmt',
        tool_version: APP_VERSION,
        format: req.format,
        compression: req.compression,
        columns,
        row_count: written.row_count,
        batch_size: batchSize,
        files: [{ name: basename(dataPath), size_bytes: size, checksum_sha256: checksum }],
        resource_count: 1,
        status: warnings.length > 0 ? 'completed_with_warnings' : 'completed',
        warnings: [...warnings, ...(missingColumns.length ? [`Missing columns: ${missingColumns.join(', ')}`] : [])],
        output_mode: externalDir ? 'external' : 'managed',
      };

      sidecarPath = `${dataPath}.manifest.json`;
      await writeFile(`${sidecarPath}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await rename(`${sidecarPath}.tmp`, sidecarPath);

      const objectKey = externalDir ? dataPath : backend.objectKeyFor(dataPath, run.id);
      let absolutePath = externalDir ? dataPath : backend.describeObject(objectKey);
      let manifestPath = sidecarPath;
      if (!externalDir && backend.isRemote) {
        await backend.putObject(dataPath, objectKey, { sha256: checksum });
        uploadedObject = { backend, key: objectKey };
        const sidecarKey = `${objectKey}.manifest.json`;
        await backend.putObject(sidecarPath, sidecarKey, { sha256: await sha256File(sidecarPath) });
        // The remote object is now the durable copy; keep local staging lean.
        await rm(dataPath, { force: true }).catch(() => undefined);
        await rm(sidecarPath, { force: true }).catch(() => undefined);
        dataPath = undefined;
        sidecarPath = undefined;
        absolutePath = backend.describeObject(objectKey);
        manifestPath = backend.describeObject(sidecarKey);
      }
      store.createArtifact({
        run_id: run.id,
        artifact_type: 'export',
        provider_id: connection.provider_id,
        storage_backend_id: backend.id,
        object_key: objectKey,
        absolute_path: absolutePath,
        manifest,
        size_bytes: size,
        checksum_value: checksum,
      });

      store.updateRunStatus(run.id, 'verifying', { stage: 'verifying' });
      const recheck = backend.isRemote && !externalDir ? await backend.checksum(objectKey) : await sha256File(absolutePath);
      if (recheck !== checksum) {
        store.updateArtifactVerification(artifactId, 'failed');
        throw new UdmtError('OPERATION_FAILED', 'Checksum mismatch right after writing the artifact.');
      }
      store.updateArtifactVerification(artifactId, 'verified', checksum);

      const finalStatus: OperationStatus = manifest.status === 'completed_with_warnings' ? 'completed_with_warnings' : 'completed';
      store.updateRunStatus(run.id, finalStatus, {
        stage: 'completed',
        finished_at: nowIso(),
        progress: { percent: 100, stage: 'completed', rows_read: written.row_count, bytes_written: size },
        result: {
          artifact_id: artifactId,
          path: absolutePath,
          manifest_path: manifestPath,
          storage_backend_id: backend.id,
          rows: written.row_count,
          bytes: size,
          checksum_sha256: checksum,
          format: req.format,
          compression: req.compression,
          warnings: manifest.warnings,
        },
      });
      store.audit('export.completed', { artifact_id: artifactId, resource: req.resource, rows: written.row_count }, run.id);
      ctx.log('info', `Export completed: ${written.row_count} rows, ${size} bytes, sha256=${checksum.slice(0, 12)}…`);
      return store.requireRun(run.id);
    } catch (error) {
      return this.failRun(run, error, {
        writer,
        cleanupPaths: [dataPath, sidecarPath],
        cleanupObjects: uploadedObject ? [uploadedObject] : [],
      });
    }
  }

  // ------------------------------------------------------------------ import
  startImport(request: ImportRequest, options: { jobId?: string | null; workerId?: string | null } = {}): StartedOperation {
    const parsed = ImportSchema.safeParse(request);
    if (!parsed.success) {
      throw new UdmtError('INVALID_INPUT', `Import request is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const req = parsed.data;
    const connection = this.deps.store.requireConnection(req.connection_id);
    if (!connection.is_active) {
      throw new UdmtError('PRECONDITION_FAILED', `Connection "${connection.name}" is disabled.`);
    }
    const run = this.deps.store.createRun({
      operation_type: 'import',
      status: 'queued',
      source_connection_id: null,
      target_connection_id: connection.id,
      source_label: req.source.artifact_id ?? req.source.path ?? null,
      target_label: connection.name,
      resource: req.resource,
      config: { ...req, provider_id: connection.provider_id },
      job_id: options.jobId ?? null,
      worker_instance_id: options.workerId ?? null,
    });
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const done = this.executeImport(run, req, controller).finally(() => this.controllers.delete(run.id));
    return { run, done };
  }

  async import(request: ImportRequest): Promise<ImportOutcome> {
    const started = this.startImport(request);
    const run = await started.done;
    if (run.status !== 'completed' && run.status !== 'completed_with_warnings') {
      throw new UdmtError(
        (run.error_code as never) ?? 'OPERATION_FAILED',
        run.error_message_safe ?? `Import finished with status ${run.status}`,
        { details: { run_id: run.id } },
      );
    }
    return { run };
  }

  private async executeImport(run: OperationRun, req: z.infer<typeof ImportSchema>, controller: AbortController): Promise<OperationRun> {
    const { store, registry, secrets } = this.deps;
    const ctx = this.makeContext(run, controller);
    const warnings: string[] = [];
    const cleanupPaths: string[] = [];

    try {
      store.updateRunStatus(run.id, 'preparing', { stage: 'preparing', started_at: nowIso() });
      const connection = store.requireConnection(req.connection_id);
      const provider = registry.get(connection.provider_id);
      const secret = secrets.load(connection.credential_ref);
      const descriptor = provider.descriptor();

      if (!hasCapability(descriptor, 'write_data')) {
        throw new UdmtError('CAPABILITY_UNSUPPORTED', `Provider "${connection.provider_id}" cannot write data.`);
      }

      const source = await this.resolveImportSource(req, provider, connection.provider_id);
      if (source.materialized) cleanupPaths.push(source.materialized);
      store.updateRunStatus(run.id, 'preflight', { stage: 'preflight' });
      ctx.log('info', `Preflight: ${source.path} (${source.format}) -> ${connection.name} ${req.resource} [${req.mode}]`);

      const validated = provider.validateConfig(connection.config, secret);

      // Destructive safety policy (roadmap 7.3).
      const destructive = req.mode === 'truncate_and_load';
      if (destructive && req.confirm !== connection.name) {
        throw new UdmtError(
          'CONFIRMATION_REQUIRED',
          `Target ${connection.name} will have its data replaced. Re-run with --confirm "${connection.name}" to authorize this.`,
        );
      }
      if (connection.environment === 'production' && req.mode !== 'append' && req.confirm !== connection.name) {
        throw new UdmtError(
          'CONFIRMATION_REQUIRED',
          `Connection "${connection.name}" is marked production. Re-run with --confirm "${connection.name}".`,
        );
      }
      if (req.mode === 'upsert' && (!req.key_columns || req.key_columns.length === 0) && provider.providerId !== 'mongodb') {
        throw new UdmtError('INVALID_INPUT', 'Import mode upsert requires --key-columns.');
      }

      const existingSchema = hasCapability(descriptor, 'schema_read')
        ? await provider.readSchema!(validated.config, secret, req.resource, ctx).catch((error) => {
            // A missing target resource/database file is expected when the import
            // is allowed to create it (the default, unless --no-create is used).
            if (req.create_resource !== false) return undefined;
            throw error;
          })
        : undefined;

      if (existingSchema) {
        const targetCols = new Set(existingSchema.columns.map((column) => column.name));
        const missing = source.columns.filter((column) => !targetCols.has(column.name)).map((column) => column.name);
        if (missing.length > 0) {
          warnings.push(`Columns missing in target were ignored: ${missing.join(', ')}`);
        }
        const unknownTypes = source.columns.filter((column) => column.type === 'unknown');
        if (unknownTypes.length > 0) warnings.push(`Unresolved column types: ${unknownTypes.map((c) => c.name).join(', ')}`);
      }

      const batchSize = req.batch_size ?? 1000;

      if (req.dry_run) {
        let sampled = 0;
        const sampleErrors: string[] = [];
        for await (const row of this.iterateSource(source, req, ctx)) {
          sampled += 1;
          for (const column of source.columns) {
            const value = row[column.name];
            if (value !== undefined && value !== null && column.type !== 'unknown' && !matchesType(value, column.type)) {
              sampleErrors.push(`row ${sampled}: column ${column.name} does not match ${column.type}`);
            }
          }
          if (sampled >= 1000) break;
        }
        store.updateRunStatus(run.id, 'finalizing', { stage: 'dry_run' });
        store.updateRunStatus(run.id, 'completed', {
          stage: 'completed',
          finished_at: nowIso(),
          progress: { percent: 100, stage: 'completed', rows_read: sampled },
          result: {
            dry_run: true,
            rows_sampled: sampled,
            target_exists: Boolean(existingSchema),
            columns_mapped: source.columns.length,
            warnings: [...warnings, ...sampleErrors.slice(0, 20)],
            sample_errors: sampleErrors.length,
          },
        });
        ctx.log('info', `Dry run finished: ${sampled} rows sampled, ${sampleErrors.length} type conflicts, no data written.`);
        return store.requireRun(run.id);
      }

      store.updateRunStatus(run.id, 'running', { stage: 'running' });

      let rowsRead = 0;
      const totalHint = source.manifest?.row_count ?? null;
      const batchIterable = async function* (this: OperationEngine): AsyncGenerator<RowBatch> {
        let batch: RowBatch = [];
        for await (const row of this.iterateSource(source, req, ctx)) {
          ctx.throwIfCancelled();
          batch.push(row);
          rowsRead += 1;
          if (batch.length >= batchSize) {
            yield batch;
            batch = [];
            ctx.progress({
              percent: totalHint ? Math.min(96, Math.round((rowsRead / totalHint) * 96)) : Math.min(90, 15 + Math.log10(Math.max(rowsRead, 1)) * 15),
              metrics: { rows_read: rowsRead },
            });
          }
        }
        if (batch.length > 0) yield batch;
      }.call(this);

      const writeResult = await provider.writeRows!(
        validated.config,
        secret,
        {
          resource: req.resource,
          columns: source.columns,
          mode: req.mode,
          keyColumns: req.key_columns,
          createResource: req.create_resource ?? true,
        },
        batchIterable,
        ctx,
      );

      store.updateRunStatus(run.id, 'finalizing', { stage: 'finalizing' });
      const allWarnings = [...warnings, ...writeResult.warnings];
      const finalStatus: OperationStatus = allWarnings.length > 0 ? 'completed_with_warnings' : 'completed';
      store.updateRunStatus(run.id, finalStatus, {
        stage: 'completed',
        finished_at: nowIso(),
        progress: {
          percent: 100,
          stage: 'completed',
          rows_read: rowsRead,
          rows_written: writeResult.rows_written,
        },
        result: {
          rows_read: rowsRead,
          rows_written: writeResult.rows_written,
          mode: req.mode,
          source: source.path,
          format: source.format,
          warnings: allWarnings,
        },
      });
      store.audit('import.completed', {
        target: connection.name,
        resource: req.resource,
        rows: writeResult.rows_written,
        mode: req.mode,
      }, run.id);
      ctx.log('info', `Import completed: ${writeResult.rows_written} rows into ${req.resource}.`);
      return store.requireRun(run.id);
    } catch (error) {
      return this.failRun(run, error);
    } finally {
      for (const path of cleanupPaths) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  }

  // ------------------------------------------------------------------ sync
  startSync(request: SyncRequest, options: { jobId?: string | null; workerId?: string | null } = {}): StartedOperation {
    const parsed = SyncSchema.safeParse(request);
    if (!parsed.success) {
      throw new UdmtError('INVALID_INPUT', `Sync request is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const req = parsed.data;
    const { store } = this.deps;
    const pipeline = store.requireSyncPipeline(req.pipeline_id);
    if (!pipeline.enabled) {
      throw new UdmtError('PRECONDITION_FAILED', `Sync pipeline "${pipeline.name}" is disabled.`);
    }
    const source = store.requireConnection(pipeline.source_connection_id);
    const target = store.requireConnection(pipeline.target_connection_id);
    if (!source.is_active) throw new UdmtError('PRECONDITION_FAILED', `Source connection "${source.name}" is disabled.`);
    if (!target.is_active) throw new UdmtError('PRECONDITION_FAILED', `Target connection "${target.name}" is disabled.`);
    const run = store.createRun({
      operation_type: 'sync',
      status: 'queued',
      source_connection_id: source.id,
      target_connection_id: target.id,
      source_label: source.name,
      target_label: target.name,
      resource: `${pipeline.source_resource} → ${pipeline.target_resource}`,
      config: { ...req, pipeline_id: pipeline.id, pipeline_name: pipeline.name },
      job_id: options.jobId ?? null,
      worker_instance_id: options.workerId ?? null,
    });
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const done = this.executeSync(run, req, pipeline, controller).finally(() => this.controllers.delete(run.id));
    return { run, done };
  }

  async sync(request: SyncRequest): Promise<{ run: OperationRun }> {
    const started = this.startSync(request);
    const run = await started.done;
    if (run.status !== 'completed' && run.status !== 'completed_with_warnings') {
      throw new UdmtError(
        (run.error_code as never) ?? 'OPERATION_FAILED',
        run.error_message_safe ?? `Sync finished with status ${run.status}`,
        { details: { run_id: run.id } },
      );
    }
    return { run };
  }

  private async executeSync(
    run: OperationRun,
    req: z.infer<typeof SyncSchema>,
    pipeline: SyncPipelineRecord,
    controller: AbortController,
  ): Promise<OperationRun> {
    const { store, registry, secrets } = this.deps;
    const ctx = this.makeContext(run, controller);
    const stats = {
      rows_read: 0,
      rows_filtered: 0,
      rows_written: 0,
      rows_skipped: 0,
      transformed: 0,
      errors: 0,
      errors_persisted: 0,
      attempts: 0,
    };
    const MAX_PERSISTED_ERRORS = 500;

    const recordRowError = (rowIndex: number, error: unknown): void => {
      const code = error instanceof SyncRowError ? error.code : 'TRANSFORM_FAILED';
      const message = truncate(sanitizeErrorMessage((error as Error).message ?? String(error)), 500);
      stats.errors += 1;
      if (stats.errors_persisted < MAX_PERSISTED_ERRORS) {
        store.recordSyncError({
          run_id: run.id,
          pipeline_id: pipeline.id,
          batch_index: null,
          row_index: rowIndex,
          code,
          message,
        });
        stats.errors_persisted += 1;
      }
      ctx.log('warn', `Row ${rowIndex} skipped (${code}): ${message}`);
    };

    try {
      store.updateRunStatus(run.id, 'preparing', { stage: 'preparing', started_at: nowIso() });
      const source = store.requireConnection(pipeline.source_connection_id);
      const target = store.requireConnection(pipeline.target_connection_id);
      const sourceProvider = registry.get(source.provider_id);
      const targetProvider = registry.get(target.provider_id);
      const sourceSecret = secrets.load(source.credential_ref);
      const targetSecret = secrets.load(target.credential_ref);
      const sourceDescriptor = sourceProvider.descriptor();
      const targetDescriptor = targetProvider.descriptor();

      if (!hasCapability(sourceDescriptor, 'read_data')) {
        throw new UdmtError('CAPABILITY_UNSUPPORTED', `Source provider "${source.provider_id}" cannot read data.`);
      }
      if (!hasCapability(targetDescriptor, 'write_data')) {
        throw new UdmtError('CAPABILITY_UNSUPPORTED', `Target provider "${target.provider_id}" cannot write data.`);
      }
      if (!hasCapability(sourceDescriptor, 'schema_read')) {
        throw new UdmtError('CAPABILITY_UNSUPPORTED', `Source provider "${source.provider_id}" cannot read schema.`);
      }

      const sourceValidated = sourceProvider.validateConfig(source.config, sourceSecret);
      const targetValidated = targetProvider.validateConfig(target.config, targetSecret);
      const sourceSchema = await sourceProvider.readSchema!(sourceValidated.config, sourceSecret, pipeline.source_resource, ctx);
      const targetSchema = hasCapability(targetDescriptor, 'schema_read')
        ? await targetProvider
            .readSchema!(targetValidated.config, targetSecret, pipeline.target_resource, ctx)
            .catch(() => undefined)
        : undefined;

      const fields = compileSyncMapping(pipeline.mapping, sourceSchema.columns);
      const targetColumns = syncTargetColumns(fields, pipeline.key_columns);
      const normalizedMode = pipeline.load_mode === 'replace_resource' ? 'truncate_and_load' : pipeline.load_mode;
      const destructive = normalizedMode === 'truncate_and_load';

      if (normalizedMode === 'upsert' && pipeline.key_columns.length === 0) {
        throw new UdmtError('INVALID_INPUT', 'Sync mode upsert requires at least one key column.');
      }
      const targetNames = new Set(fields.map((field) => field.target));
      const invalidKeys = pipeline.key_columns.filter((key) => !targetNames.has(key));
      if (invalidKeys.length > 0) {
        throw new UdmtError('INVALID_INPUT', `Key columns are not mapped to the target: ${invalidKeys.join(', ')}`);
      }
      const filter = pipeline.options.filter ?? null;
      if (filter) {
        const sourceNames = new Set(sourceSchema.columns.map((column) => column.name));
        if (!sourceNames.has(filter.column)) {
          throw new UdmtError('INVALID_INPUT', `Filter column "${filter.column}" is not in the source schema.`);
        }
        if (filter.operator === 'in' && !Array.isArray(filter.value)) {
          throw new UdmtError('INVALID_INPUT', 'Filter operator "in" needs an array value.');
        }
      }

      const dryRun = req.dry_run ?? pipeline.options.dry_run ?? false;
      if (!dryRun) {
        if (destructive && req.confirm !== target.name) {
          throw new UdmtError(
            'CONFIRMATION_REQUIRED',
            `Sync will replace data in ${target.name}. Re-run with --confirm "${target.name}" to authorize this.`,
          );
        }
        if (target.environment === 'production' && normalizedMode !== 'append' && req.confirm !== target.name) {
          throw new UdmtError(
            'CONFIRMATION_REQUIRED',
            `Connection "${target.name}" is marked production. Re-run with --confirm "${target.name}".`,
          );
        }
      }

      const warnings: string[] = [];
      if (targetSchema) {
        const existing = new Set(targetSchema.columns.map((column) => column.name));
        const missing = fields.map((field) => field.target).filter((name) => !existing.has(name));
        if (missing.length > 0) {
          warnings.push(`Target columns missing (will be created by the provider if allowed): ${missing.join(', ')}`);
        }
      }
      const unknown = fields.filter((field) => field.cast === 'unknown');
      if (unknown.length > 0) {
        warnings.push(`Fields without a type mapping are written as-is: ${unknown.map((field) => field.target).join(', ')}`);
      }

      const batchSize = req.batch_size ?? pipeline.options.batch_size ?? 1000;
      const onError = req.on_error ?? pipeline.options.on_error ?? 'fail';
      const limit = req.limit ?? pipeline.options.limit;
      const readColumns = [...new Set([...fields.map((field) => field.source), ...(filter ? [filter.column] : [])])];
      let retries = Math.min(Math.max(pipeline.options.retry?.max_attempts ?? 1, 1), 3);
      if (normalizedMode === 'append') retries = 1; // appending twice is not idempotent
      const backoffMs = Math.min(Math.max(pipeline.options.retry?.backoff_ms ?? 1000, 0), 30_000);

      store.updateRunStatus(run.id, 'preflight', { stage: 'preflight' });
      ctx.log(
        'info',
        `Preflight: ${source.name}.${pipeline.source_resource} -> ${target.name}.${pipeline.target_resource} ` +
          `[${pipeline.load_mode}] ${fields.length} mapped field(s), filter=${filter ? `${filter.column} ${filter.operator}` : 'none'}`,
      );

      if (dryRun) {
        const sampleLimit = Math.min(limit ?? 1000, 1000);
        let sampled = 0;
        let matched = 0;
        let firstError: string | null = null;
        const sampleErrors: string[] = [];
        for await (const rows of sourceProvider.readRows!(
          sourceValidated.config,
          sourceSecret,
          { resource: pipeline.source_resource, batchSize, columns: readColumns, limit: sampleLimit },
          ctx,
        )) {
          for (const row of rows) {
            ctx.throwIfCancelled();
            if (sampled >= sampleLimit) break;
            sampled += 1;
            try {
              if (!evaluateSyncFilter(row, filter)) continue;
              matched += 1;
              transformSyncRow(row, fields);
            } catch (error) {
              const code = error instanceof SyncRowError ? error.code : 'TRANSFORM_FAILED';
              const message = sanitizeErrorMessage((error as Error).message ?? String(error));
              if (!firstError) firstError = `${code}: ${message}`;
              sampleErrors.push(message);
              recordRowError(sampled, error);
            }
          }
          if (sampled >= sampleLimit) break;
        }
        const status: OperationStatus = sampleErrors.length > 0 ? 'completed_with_warnings' : 'completed';
        store.updateRunStatus(run.id, 'finalizing', { stage: 'dry_run' });
        store.updateRunStatus(run.id, status, {
          stage: 'completed',
          finished_at: nowIso(),
          progress: { percent: 100, stage: 'completed', rows_read: sampled },
          result: {
            dry_run: true,
            pipeline_id: pipeline.id,
            rows_sampled: sampled,
            rows_matched: matched,
            mapping: fields.map((field) => ({ source: field.source, target: field.target, type: field.cast })),
            target_columns: targetSchema?.columns.map((column) => column.name) ?? null,
            warnings: [...warnings, ...(firstError ? [`First row error: ${firstError}`] : [])],
            errors: sampleErrors.length,
            error_samples: sampleErrors.slice(0, 20),
          },
        });
        ctx.log('info', `Dry run finished: ${sampled} rows sampled, ${matched} matched, ${sampleErrors.length} row errors.`);
        return store.requireRun(run.id);
      }

      store.updateRunStatus(run.id, 'running', { stage: 'running' });

      let succeeded = false;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        stats.attempts = attempt;
        if (attempt > 1) {
          store.clearSyncErrors(run.id);
          stats.errors = 0;
          stats.errors_persisted = 0;
          stats.rows_read = 0;
          stats.rows_filtered = 0;
          stats.rows_written = 0;
          stats.rows_skipped = 0;
          stats.transformed = 0;
          ctx.log('warn', `Retrying sync (attempt ${attempt}/${retries}) after a transient failure.`);
        }
        try {
          let batchIndex = 0;
          let rowIndex = 0;
          const writeResult = await targetProvider.writeRows!(
            targetValidated.config,
            targetSecret,
            {
              resource: pipeline.target_resource,
              columns: targetColumns,
              mode: normalizedMode as 'append' | 'upsert' | 'truncate_and_load',
              keyColumns: pipeline.key_columns,
              createResource: pipeline.options.create_resource ?? true,
            },
            async function* (this: OperationEngine): AsyncGenerator<RowBatch> {
              let out: RowBatch = [];
              outer: for await (const rows of sourceProvider.readRows!(
                sourceValidated.config,
                sourceSecret,
                { resource: pipeline.source_resource, batchSize, columns: readColumns, ...(limit ? { limit } : {}) },
                ctx,
              )) {
                for (const sourceRow of rows) {
                  ctx.throwIfCancelled();
                  if (limit && rowIndex >= limit) break outer;
                  rowIndex += 1;
                  stats.rows_read += 1;
                  try {
                    if (!evaluateSyncFilter(sourceRow, filter)) {
                      stats.rows_filtered += 1;
                      continue;
                    }
                    const transformed = transformSyncRow(sourceRow, fields);
                    stats.transformed += transformed.transformed;
                    out.push(transformed.row);
                  } catch (error) {
                    if (onError === 'fail') {
                      const code = error instanceof SyncRowError ? error.code : 'TRANSFORM_FAILED';
                      throw new UdmtError(
                        'SYNC_ROW_ERROR',
                        `Sync stopped at source row ${rowIndex} (${code}): ${sanitizeErrorMessage((error as Error).message)}`,
                        { details: { code, row_index: rowIndex, pipeline_id: pipeline.id } },
                      );
                    }
                    stats.rows_skipped += 1;
                    recordRowError(rowIndex, error);
                    continue;
                  }
                  if (out.length >= batchSize) {
                    batchIndex += 1;
                    ctx.progress({
                      percent: limit
                        ? Math.min(96, Math.round((rowIndex / limit) * 96))
                        : Math.min(90, 20 + Math.log10(Math.max(rowIndex, 1)) * 15),
                      metrics: { rows_read: stats.rows_read, rows_written: stats.rows_written },
                    });
                    yield out;
                    out = [];
                  }
                }
              }
              if (out.length > 0) {
                batchIndex += 1;
                yield out;
              }
              ctx.log('info', `Source stream finished after ${stats.rows_read} row(s), ${batchIndex} batch(es).`);
            }.call(this),
            ctx,
          );
          stats.rows_written = writeResult.rows_written;
          warnings.push(...writeResult.warnings);
          succeeded = true;
          break;
        } catch (error) {
          const retryable =
            attempt < retries &&
            !controller.signal.aborted &&
            isTransientSyncError(error) &&
            normalizedMode !== 'append';
          if (!retryable) throw error;
          ctx.progress({ stage: 'retry_waiting', message: `Transient failure; retrying in ${backoffMs}ms` });
          await sleep(backoffMs);
        }
      }
      if (!succeeded) {
        throw new UdmtError('OPERATION_FAILED', 'Sync did not complete after retries.');
      }

      store.updateRunStatus(run.id, 'finalizing', { stage: 'finalizing' });
      const finalWarnings = [...warnings];
      if (stats.errors > stats.errors_persisted) {
        finalWarnings.push(`${stats.errors - stats.errors_persisted} additional row errors were not persisted (cap ${MAX_PERSISTED_ERRORS}).`);
      }
      if (stats.rows_skipped > 0) {
        finalWarnings.push(`${stats.rows_skipped} row(s) were skipped and reported in the sync error list.`);
      }
      const finalStatus: OperationStatus = finalWarnings.length > 0 || stats.errors > 0 ? 'completed_with_warnings' : 'completed';
      const finishedAt = nowIso();
      store.updateRunStatus(run.id, finalStatus, {
        stage: 'completed',
        finished_at: finishedAt,
        progress: {
          percent: 100,
          stage: 'completed',
          rows_read: stats.rows_read,
          rows_written: stats.rows_written,
        },
        result: {
          pipeline_id: pipeline.id,
          pipeline_name: pipeline.name,
          rows_read: stats.rows_read,
          rows_filtered: stats.rows_filtered,
          rows_written: stats.rows_written,
          rows_skipped: stats.rows_skipped,
          values_transformed: stats.transformed,
          errors: stats.errors,
          errors_persisted: stats.errors_persisted,
          mode: pipeline.load_mode,
          attempts: stats.attempts,
          source: `${source.name}.${pipeline.source_resource}`,
          target: `${target.name}.${pipeline.target_resource}`,
          warnings: finalWarnings,
        },
      });
      const previous = store.getSyncState(pipeline.id);
      store.upsertSyncState({
        pipeline_id: pipeline.id,
        checkpoint: {
          checkpoint_version: 1,
          kind: 'full',
          completed_at: finishedAt,
          rows_read: stats.rows_read,
          rows_written: stats.rows_written,
          rows_filtered: stats.rows_filtered,
        },
        last_run_id: run.id,
        last_run_at: finishedAt,
        last_status: finalStatus,
        rows_synced: Number(previous?.rows_synced ?? 0) + stats.rows_written,
      });
      store.audit('sync.completed', {
        pipeline_id: pipeline.id,
        rows: stats.rows_written,
        errors: stats.errors,
        mode: pipeline.load_mode,
      }, run.id);
      ctx.log('info', `Sync completed: ${stats.rows_written} rows written, ${stats.rows_skipped} skipped.`);
      return store.requireRun(run.id);
    } catch (error) {
      try {
        const previous = store.getSyncState(pipeline.id);
        store.upsertSyncState({
          pipeline_id: pipeline.id,
          checkpoint: {
            ...(previous?.checkpoint ?? {}),
            partial: true,
            failed_at: nowIso(),
            rows_read: stats.rows_read,
            rows_written: stats.rows_written,
          },
          last_run_id: run.id,
          last_run_at: nowIso(),
          last_status: 'failed',
          rows_synced: Number(previous?.rows_synced ?? 0),
        });
      } catch {
        /* state persistence must not mask the original failure */
      }
      return this.failRun(run, error);
    }
  }

  // ------------------------------------------------------------------ verify
  async verifyArtifact(artifactId: string): Promise<{ run: OperationRun; artifact: ArtifactRecord; valid: boolean }> {
    const { store } = this.deps;
    const artifact = store.requireArtifact(artifactId);
    const run = store.createRun({
      operation_type: 'verify',
      status: 'queued',
      source_connection_id: null,
      target_connection_id: null,
      source_label: artifact.id,
      target_label: null,
      resource: artifact.manifest.resource ?? null,
      config: { artifact_id: artifact.id },
    });
    const controller = new AbortController();
    const ctx = this.makeContext(run, controller);
    try {
      store.updateRunStatus(run.id, 'preparing', { stage: 'preparing', started_at: nowIso() });
      const remote = /^s3:\/\//.test(artifact.absolute_path);
      if (!remote && !existsSync(artifact.absolute_path)) {
        throw new UdmtError('NOT_FOUND', `Artifact file is missing: ${artifact.absolute_path}`);
      }
      store.updateRunStatus(run.id, 'preflight', { stage: 'preflight' });
      store.updateRunStatus(run.id, 'running', { stage: 'hashing' });
      const backend = remote ? this.deps.resolveStorage(artifact.storage_backend_id) : null;
      const actual = backend ? await backend.checksum(artifact.object_key) : await sha256File(artifact.absolute_path);
      const valid = actual === artifact.checksum_value;
      store.updateArtifactVerification(artifact.id, valid ? 'verified' : 'failed', valid ? actual : undefined);
      if (!valid) {
        throw new UdmtError('VALIDATION_FAILED', 'Checksum mismatch: artifact is corrupt.');
      }
      store.updateRunStatus(run.id, 'finalizing', { stage: 'finalizing' });
      store.updateRunStatus(run.id, valid ? 'completed' : 'failed', {
        stage: valid ? 'completed' : 'checksum_mismatch',
        finished_at: nowIso(),
        progress: { percent: 100, stage: 'completed' },
        result: { valid, expected: artifact.checksum_value, actual },
        ...(valid ? {} : { error_code: 'VALIDATION_FAILED', error_message_safe: 'Checksum mismatch: artifact is corrupt.' }),
      });
      ctx.log(valid ? 'info' : 'error', `Verify ${artifact.id}: ${valid ? 'checksum matches' : 'CHECKSUM MISMATCH'}`);
      return { run: store.requireRun(run.id), artifact: store.requireArtifact(artifact.id), valid };
    } catch (error) {
      const failed = await this.failRun(run, error);
      return { run: failed, artifact: store.requireArtifact(artifact.id), valid: false };
    }
  }

  // ------------------------------------------------------------------ helpers
  private async resolveImportSource(
    req: z.infer<typeof ImportSchema>,
    provider: DataProvider,
    providerId: string,
  ): Promise<{
    path: string;
    format: ExportFormat;
    columns: ColumnSchema[];
    manifest: ArtifactManifest | null;
    /** Local temp file created for a remote artifact, removed after the run. */
    materialized?: string | null;
  }> {
    const { store } = this.deps;
    if (req.source.artifact_id) {
      const artifact = store.requireArtifact(req.source.artifact_id);
      if (artifact.manifest.provider_id !== providerId) {
        throw new UdmtError(
          'PRECONDITION_FAILED',
          `Artifact was produced by ${artifact.manifest.provider_id} but the target is ${providerId}. Use a file path to force a cross-provider import.`,
        );
      }
      let path = artifact.absolute_path;
      let materialized: string | null = null;
      if (/^s3:\/\//.test(path)) {
        const backend = this.deps.resolveStorage(artifact.storage_backend_id);
        const dir = join(this.deps.paths.tempDir, 'staging', `artifact-${artifact.id}`);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        path = join(dir, basename(artifact.object_key));
        await backend.getObject(artifact.object_key, path);
        materialized = path;
      } else if (!existsSync(path)) {
        throw new UdmtError('NOT_FOUND', `Artifact file is missing: ${path}`);
      }
      return {
        path,
        format: req.format ?? artifact.manifest.format,
        columns: artifact.manifest.columns,
        manifest: artifact.manifest,
        materialized,
      };
    }

    if (!req.source.path) {
      throw new UdmtError('INVALID_INPUT', 'Import requires source.artifact_id or source.path.');
    }
    const absolute = resolve(req.source.path);
    if (!existsSync(absolute)) {
      throw new UdmtError('NOT_FOUND', `Import file not found: ${absolute}`);
    }
    const format = req.format ?? detectFormat(absolute);
    const manifest = await this.readSidecarManifest(absolute);
    let columns = manifest?.columns ?? [];
    if (columns.length === 0) {
      columns = await this.inferColumnsFromFile(absolute, format);
    }
    if (columns.length === 0) {
      throw new UdmtError('VALIDATION_FAILED', `Could not infer a column schema from ${basename(absolute)}.`);
    }
    void provider;
    return { path: absolute, format, columns, manifest };
  }

  private async readSidecarManifest(path: string): Promise<ArtifactManifest | null> {
    const sidecar = `${path}.manifest.json`;
    if (!existsSync(sidecar)) return null;
    try {
      return JSON.parse(await readFile(sidecar, 'utf8')) as ArtifactManifest;
    } catch {
      return null;
    }
  }

  private async inferColumnsFromFile(path: string, format: ExportFormat): Promise<ColumnSchema[]> {
    const seen = new Map<string, string>();
    let sampled = 0;
    for await (const row of readRowsFromFile(path, { format, columns: [], coerce: false })) {
      for (const [key, value] of Object.entries(row)) {
        const type = inferType(value);
        const previous = seen.get(key);
        seen.set(key, previous && previous !== type ? 'string' : type);
      }
      sampled += 1;
      if (sampled >= 200) break;
    }
    return [...seen.entries()].map(([name, type]) => ({ name, type: type as ColumnSchema['type'] }));
  }

  private async *iterateSource(
    source: { path: string; format: ExportFormat; columns: ColumnSchema[] },
    req: z.infer<typeof ImportSchema>,
    ctx: OperationContext,
  ): AsyncGenerator<Record<string, unknown>> {
    void req;
    for await (const row of readRowsFromFile(source.path, { format: source.format, columns: source.columns, coerce: true })) {
      ctx.throwIfCancelled();
      yield row;
    }
  }

  private async failRun(
    run: OperationRun,
    error: unknown,
    options: {
      writer?: FormatWriter;
      cleanupPaths?: Array<string | undefined>;
      cleanupObjects?: Array<{ backend: StorageBackend; key: string }>;
    } = {},
  ): Promise<OperationRun> {
    const { store } = this.deps;
    const udmt = toUdmtError(error, 'OPERATION_FAILED');
    const cancelled = udmt.code === 'OPERATION_CANCELLED' || udmt.code === 'INTERRUPTED';
    const current = store.getRun(run.id);
    const status: OperationStatus = cancelled
      ? 'cancelled'
      : current && ['queued', 'preparing', 'preflight', 'running', 'finalizing', 'verifying'].includes(current.status)
        ? 'failed'
        : (current?.status ?? 'failed');

    if (options.writer) await options.writer.abort().catch(() => undefined);
    for (const path of options.cleanupPaths ?? []) {
      if (!path) continue;
      await rm(path, { force: true }).catch(() => undefined);
      await rm(`${path}.manifest.json`, { force: true }).catch(() => undefined);
      await rm(`${path}.manifest.json.tmp`, { force: true }).catch(() => undefined);
    }
    for (const object of options.cleanupObjects ?? []) {
      await object.backend.deleteObject(object.key).catch(() => undefined);
      await object.backend.deleteObject(`${object.key}.manifest.json`).catch(() => undefined);
    }

    try {
      store.appendLog(run.id, cancelled ? 'warn' : 'error', sanitizeErrorMessage(udmt.message), status);
      if (cancelled && current && !['queued', 'cancel_requested', 'cancelled'].includes(current.status)) {
        store.updateRunStatus(run.id, 'cancel_requested', { stage: 'cancel_requested' });
      }
      store.updateRunStatus(run.id, status, {
        stage: status,
        finished_at: nowIso(),
        error_code: udmt.code,
        error_message_safe: truncate(sanitizeErrorMessage(udmt.message), 1000),
      });
      store.audit(`operation.${status}`, { code: udmt.code, operation: run.operation_type }, run.id);
    } catch (stateError) {
      // Persisting the failure must not mask the original error.
      try {
        store.appendLog(run.id, 'error', `Failed to persist terminal state: ${String(stateError)}`, status);
      } catch {
        /* ignore */
      }
    }
    return store.requireRun(run.id);
  }
}

function projectRow(row: Record<string, unknown>, columns: ColumnSchema[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column.name];
    if (value === undefined) {
      out[column.name] = null;
      continue;
    }
    out[column.name] = value;
  }
  return out;
}

function requestExtension(format: ExportFormat, compression: Compression): string {
  return defaultExtension(format, compression).replace(/^\./, '');
}

function matchesType(value: unknown, type: ColumnSchema['type']): boolean {
  switch (type) {
    case 'integer':
      return Number.isInteger(value) || /^-?\d+$/.test(String(value));
    case 'number':
      return typeof value === 'number' || /^-?\d*\.?\d+$/.test(String(value));
    case 'boolean':
      return typeof value === 'boolean' || /^(true|false|0|1)$/i.test(String(value));
    case 'json':
      return typeof value === 'object' || /^[[{]/.test(String(value));
    case 'timestamp':
    case 'date':
      return !Number.isNaN(new Date(String(value)).getTime());
    default:
      return true;
  }
}

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ENOTFOUND',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'EBUSY',
]);

/**
 * Retry eligibility for sync runs. Row-level transform errors are never
 * transient; network and lock contention usually are.
 */
function isTransientSyncError(error: unknown): boolean {
  if (isUdmtError(error)) return error.retryable;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|temporary|transient|connection reset|socket hang up|database is locked|rate limit|too many requests|\b(429|502|503|504)\b/i.test(
    message,
  );
}

export function formatFormats(): ExportFormat[] {
  return EXPORT_FORMATS;
}

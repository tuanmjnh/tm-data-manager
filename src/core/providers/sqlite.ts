import { DatabaseSync, type DatabaseSyncInstance } from '../db/sqlite-driver.js';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { UdmtError, mapDriverError } from '../errors.js';
import type {
  CanonicalType,
  CapabilityId,
  ProviderDescriptor,
  ResourceDescriptor,
  RowBatch,
} from '../types.js';
import type {
  ConnectionTestResult,
  DataProvider,
  OperationContext,
  ReadRequest,
  ValidatedConnectionConfig,
  WriteRequest,
  WriteResult,
} from './contract.js';
import { caps } from './contract.js';

const ConfigSchema = z.object({
  path: z.string().min(1),
  read_only: z.boolean().optional(),
});

const CAPS: CapabilityId[] = [
  'test_connection',
  'discover_resources',
  'read_data',
  'write_data',
  'schema_read',
  'schema_write',
  'bulk_write',
  'transactions',
  'incremental_read',
];

const TYPE_MAP: Record<CanonicalType, string> = {
  string: 'TEXT',
  integer: 'INTEGER',
  number: 'REAL',
  boolean: 'INTEGER',
  timestamp: 'TEXT',
  date: 'TEXT',
  json: 'TEXT',
  binary: 'BLOB',
  unknown: 'TEXT',
};

export class SqliteProvider implements DataProvider {
  readonly providerId = 'sqlite';

  descriptor(): ProviderDescriptor {
    return {
      provider_id: 'sqlite',
      display_name: 'SQLite',
      version: '1.0.0',
      built_in: true,
      capabilities: caps(...CAPS),
      service_profiles: [],
      secret_fields: [],
      config_fields: [
        {
          name: 'path',
          label: 'Database file',
          type: 'path',
          required: true,
          placeholder: 'D:\\data\\app.db',
          help: 'An existing file for reading. Imports can create a new file.',
        },
        { name: 'read_only', label: 'Open read-only', type: 'boolean', required: false, default: true },
      ],
    };
  }

  validateConfig(config: Record<string, unknown>): ValidatedConnectionConfig {
    const parsed = ConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new UdmtError('INVALID_CONFIG', `SQLite config is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const path = isAbsolute(parsed.data.path) ? parsed.data.path : resolve(parsed.data.path);
    return { config: { ...parsed.data, path }, endpoint_hint: path };
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const { path, read_only } = ConfigSchema.parse(config);
    const started = Date.now();
    if (!existsSync(path)) {
      return {
        success: false,
        server_version: null,
        database: path,
        diagnostics: [`Database file does not exist: ${path}`],
        detected_capabilities: [],
      };
    }
    let db: DatabaseSyncInstance | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: read_only ?? true });
      const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
      const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
      const diagnostics = [`quick_check: ${check?.quick_check ?? 'unknown'}`];
      if (check && check.quick_check !== 'ok') {
        return {
          success: false,
          server_version: version.version,
          database: path,
          diagnostics,
          detected_capabilities: [],
        };
      }
      return {
        success: true,
        server_version: version.version,
        database: path,
        diagnostics: [...diagnostics, `latency: ${Date.now() - started}ms`],
        detected_capabilities: read_only ?? true ? CAPS.filter((c) => c !== 'write_data' && c !== 'schema_write') : CAPS,
      };
    } catch (error) {
      const mapped = mapDriverError(error, 'SQLite connection test');
      return {
        success: false,
        server_version: null,
        database: path,
        diagnostics: [mapped.message],
        detected_capabilities: [],
      };
    } finally {
      db?.close();
    }
  }

  async discoverResources(config: Record<string, unknown>): Promise<ResourceDescriptor[]> {
    const { path } = ConfigSchema.parse(config);
    requireExistingFile(path);
    const db = openDb(path, true);
    try {
      const rows = db
        .prepare(
          `SELECT name, type FROM sqlite_master
           WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as Array<{ name: string; type: string }>;
      return rows.map((row) => ({
        id: row.name,
        namespace: row.name,
        name: row.name,
        type: row.type === 'view' ? 'view' : 'table',
      }));
    } catch (error) {
      throw mapDriverError(error, 'SQLite resource discovery');
    } finally {
      db.close();
    }
  }

  async readSchema(config: Record<string, unknown>, _secret: Record<string, unknown>, resource: string) {
    const { path } = ConfigSchema.parse(config);
    requireExistingFile(path);
    const db = openDb(path, true);
    try {
      if (!tableExists(db, resource)) {
        throw new UdmtError('NOT_FOUND', `SQLite table/view not found: ${resource}`);
      }
      const rows = db.prepare(`PRAGMA table_info(${quoteIdent(resource)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(resource)}`).get() as { n: number };
      return {
        resource,
        source: 'declared' as const,
        rowCountEstimate: Number(count.n),
        columns: rows.map((row) => ({
          name: row.name,
          type: sqliteTypeToCanonical(row.type),
          nativeType: row.type,
          nullable: !row.notnull,
          primaryKey: row.pk > 0,
        })),
      };
    } finally {
      db.close();
    }
  }

  async *readRows(
    config: Record<string, unknown>,
    _secret: Record<string, unknown>,
    request: ReadRequest,
    ctx: OperationContext,
  ): AsyncGenerator<RowBatch> {
    const { path } = ConfigSchema.parse(config);
    requireExistingFile(path);
    const db = openDb(path, true);
    try {
      if (!tableExists(db, request.resource)) {
        throw new UdmtError('NOT_FOUND', `SQLite table/view not found: ${request.resource}`);
      }
      const columns = request.columns?.length
        ? request.columns.map((col) => quoteIdent(col)).join(', ')
        : '*';
      const limitClause = request.limit ? ` LIMIT ${Math.max(0, Math.trunc(request.limit))}` : '';
      const params: Array<unknown> = [];
      let whereClause = '';
      let orderClause = '';
      if (request.incremental) {
        const column = request.incremental.column;
        const known = new Set(
          (db.prepare(`PRAGMA table_info(${quoteIdent(request.resource)})`).all() as Array<{ name: string }>).map((col) => col.name),
        );
        if (!known.has(column)) {
          throw new UdmtError('INVALID_INPUT', `Incremental watermark column "${column}" does not exist in ${request.resource}.`);
        }
        if (request.incremental.after !== null && request.incremental.after !== undefined) {
          whereClause = ` WHERE ${quoteIdent(column)} > ?`;
          params.push(request.incremental.after);
        }
        orderClause = ` ORDER BY ${quoteIdent(column)} ASC`;
      }
      const stmt = db.prepare(`SELECT ${columns} FROM ${quoteIdent(request.resource)}${whereClause}${orderClause}${limitClause}`);

      let batch: RowBatch = [];
      let emitted = 0;
      for (const row of stmt.iterate(...(params as never[])) as Iterable<Record<string, unknown>>) {
        ctx.throwIfCancelled();
        batch.push(normalizeRow(row));
        emitted += 1;
        if (batch.length >= request.batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
      ctx.log('info', `SQLite read ${emitted} rows from ${request.resource}`);
    } catch (error) {
      if (error instanceof UdmtError) throw error;
      throw mapDriverError(error, 'SQLite read');
    } finally {
      db.close();
    }
  }

  async writeRows(
    config: Record<string, unknown>,
    _secret: Record<string, unknown>,
    request: WriteRequest,
    rows: AsyncIterable<RowBatch>,
    ctx: OperationContext,
  ): Promise<WriteResult> {
    const { path } = ConfigSchema.parse(config);
    const db = openDb(path, false);
    const warnings: string[] = [];
    let written = 0;
    let skipped = 0;
    try {
      db.exec('PRAGMA foreign_keys = ON');
      const exists = tableExists(db, request.resource);

      if (!exists) {
        if (!request.createResource) {
          throw new UdmtError('NOT_FOUND', `Target table does not exist: ${request.resource}`);
        }
        if (request.columns.length === 0) {
          throw new UdmtError('INVALID_INPUT', 'Cannot create a table without a column schema.');
        }
        const pk = request.columns.filter((col) => col.primaryKey).map((col) => col.name);
        const cols = request.columns
          .map(
            (col) =>
              `${quoteIdent(col.name)} ${TYPE_MAP[col.type] ?? 'TEXT'}${pk.length === 1 && col.primaryKey ? ' PRIMARY KEY' : ''}`,
          )
          .join(', ');
        const tablePk = pk.length > 1 ? `, PRIMARY KEY (${pk.map(quoteIdent).join(', ')})` : '';
        db.exec(`CREATE TABLE ${quoteIdent(request.resource)} (${cols}${tablePk})`);
        ctx.log('info', `Created table ${request.resource}`);
      }

      const existingCols = new Set(
        (db.prepare(`PRAGMA table_info(${quoteIdent(request.resource)})`).all() as Array<{ name: string }>).map(
          (col) => col.name,
        ),
      );

      if (request.mode === 'truncate_and_load') {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(`DELETE FROM ${quoteIdent(request.resource)}`);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        ctx.log('warn', `Truncated ${request.resource} before loading (explicitly confirmed).`);
      }

      // Schema evolution: opt-in, explicit, and only for a target that already exists.
      if (exists && request.schemaEvolution === 'add_columns') {
        for (const col of request.columns) {
          if (existingCols.has(col.name)) continue;
          db.exec(`ALTER TABLE ${quoteIdent(request.resource)} ADD COLUMN ${quoteIdent(col.name)} ${TYPE_MAP[col.type] ?? 'TEXT'}`);
          existingCols.add(col.name);
          ctx.log('warn', `Added missing column ${col.name} to ${request.resource} (schema evolution).`);
        }
      }

      const insertColumns = request.columns.map((col) => col.name).filter((name) => existingCols.has(name));
      const missing = request.columns.filter((col) => !existingCols.has(col.name)).map((col) => col.name);
      if (missing.length > 0) warnings.push(`Columns not present in target ignored: ${missing.join(', ')}`);
      if (insertColumns.length === 0) {
        throw new UdmtError('INVALID_INPUT', 'No importable columns matched the target table.');
      }

      const onConflict = request.onConflict ?? 'overwrite';
      const conflictClause = buildConflictClause(request, existingCols, onConflict);
      // When an explicit conflict target is used, plain INSERT + the ON CONFLICT clause is correct;
      // OR REPLACE would bypass `DO NOTHING` and always overwrite.
      const replacePrefix = request.mode === 'upsert' && !conflictClause ? 'OR REPLACE ' : '';
      const insertSqlBase = `INSERT ${replacePrefix}INTO ${quoteIdent(request.resource)} (${insertColumns
        .map(quoteIdent)
        .join(', ')})`;

      for await (const batch of rows) {
        ctx.throwIfCancelled();
        if (batch.length === 0) continue;
        const values: unknown[][] = [];
        for (const row of batch) {
          const valuesRow = insertColumns.map((name) => {
            const col = request.columns.find((c) => c.name === name);
            return toSqliteValue(row[name], col?.type ?? 'unknown');
          });
          values.push(valuesRow);
        }

        if (conflictClause) {
          const statement = db.prepare(`${insertSqlBase} VALUES (${insertColumns.map(() => '?').join(', ')}) ${conflictClause}`);
          for (const row of values) {
            const result = statement.run(...(row as never[]));
            // `DO NOTHING` reports zero changed rows; count those as skipped, not written.
            if (Number(result.changes) > 0) written += 1;
            else skipped += 1;
          }
        } else {
          const placeholders = `(${insertColumns.map(() => '?').join(', ')})`;
          const chunkSize = Math.max(1, Math.floor(900 / insertColumns.length));
          for (let i = 0; i < values.length; i += chunkSize) {
            const chunk = values.slice(i, i + chunkSize);
            const sql = `${insertSqlBase} VALUES ${chunk.map(() => placeholders).join(', ')}`;
            db.prepare(sql).run(...(chunk.flat() as never[]));
            written += chunk.length;
          }
        }
      }

      ctx.log('info', `SQLite wrote ${written} rows into ${request.resource}`);
      return { rows_written: written, rows_skipped: skipped, warnings };
    } catch (error) {
      if (error instanceof UdmtError) throw error;
      throw mapDriverError(error, 'SQLite write');
    } finally {
      db.close();
    }
  }
}

function buildConflictClause(request: WriteRequest, existingCols: Set<string>, onConflict: 'overwrite' | 'ignore'): string {
  if (request.mode !== 'upsert') return '';
  const keys = (request.keyColumns ?? []).filter((key) => existingCols.has(key));
  if (keys.length === 0) return '';
  if (onConflict === 'ignore') return `ON CONFLICT (${keys.map(quoteIdent).join(', ')}) DO NOTHING`;
  const updates = request.columns
    .map((col) => col.name)
    .filter((name) => existingCols.has(name) && !keys.includes(name));
  if (updates.length === 0) return `ON CONFLICT (${keys.map(quoteIdent).join(', ')}) DO NOTHING`;
  return `ON CONFLICT (${keys.map(quoteIdent).join(', ')}) DO UPDATE SET ${updates
    .map((name) => `${quoteIdent(name)} = excluded.${quoteIdent(name)}`)
    .join(', ')}`;
}

function openDb(path: string, readOnly: boolean): DatabaseSyncInstance {
  try {
    return new DatabaseSync(path, { readOnly });
  } catch (error) {
    const mapped = mapDriverError(error, `Opening SQLite file ${path}`);
    throw new UdmtError('OPERATION_FAILED', describeOpenFailure(path, mapped.message), {
      details: { path },
    });
  }
}

/**
 * Turns Node's opaque "unable to open database file" into something actionable:
 * the resolved path plus the most common cause for that specific path.
 */
function describeOpenFailure(path: string, driverMessage: string): string {
  if (!existsSync(path)) {
    return `SQLite database file not found: ${path}. Fix the connection path (or create the file), then retry.`;
  }
  if (!existsSync(dirname(path))) {
    return `SQLite directory does not exist: ${dirname(path)}.`;
  }
  return `Cannot open SQLite file ${path}: ${driverMessage}`;
}

function requireExistingFile(path: string): void {
  if (!existsSync(path)) {
    throw new UdmtError(
      'NOT_FOUND',
      `SQLite database file not found: ${path}. Check the connection config path; relative paths are resolved once when the connection is saved.`,
      { details: { path } },
    );
  }
}

function tableExists(db: DatabaseSyncInstance, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
  return Boolean(row);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value;
  }
  return out;
}

function toSqliteValue(value: unknown, type: CanonicalType): string | number | bigint | null | Uint8Array {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'boolean':
      return value ? 1 : 0;
    case 'integer': {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'binary':
      return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(String(value));
    default:
      if (typeof value === 'object') return JSON.stringify(value);
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value as string | number;
  }
}

export function sqliteTypeToCanonical(declared: string): CanonicalType {
  const t = declared.toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT') || t === '') return 'string';
  if (t.includes('BLOB')) return 'binary';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM') || t.includes('DEC')) return 'number';
  if (t.includes('DATE') || t.includes('TIME')) return 'timestamp';
  if (t.includes('BOOL')) return 'boolean';
  if (t.includes('JSON')) return 'json';
  return 'unknown';
}


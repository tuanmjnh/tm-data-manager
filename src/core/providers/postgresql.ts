import { Client } from 'pg';
import Cursor from 'pg-cursor';
import { z } from 'zod';
import { UdmtError, mapDriverError } from '../errors.js';
import type { CanonicalType, CapabilityId, ProviderDescriptor, ResourceDescriptor, RowBatch } from '../types.js';
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
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  ssl: z.enum(['require', 'verify-full', 'disable']).default('require'),
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
];

const PG_TYPE_MAP: Record<CanonicalType, string> = {
  string: 'text',
  integer: 'bigint',
  number: 'double precision',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  date: 'date',
  json: 'jsonb',
  binary: 'bytea',
  unknown: 'text',
};

export class PostgresProvider implements DataProvider {
  readonly providerId = 'postgresql';

  descriptor(): ProviderDescriptor {
    return {
      provider_id: 'postgresql',
      display_name: 'PostgreSQL',
      version: '1.0.0',
      built_in: true,
      capabilities: caps(...CAPS),
      service_profiles: [
        {
          id: 'supabase',
          display_name: 'Supabase',
          notes: [
            'Use the direct database host for imports/exports; the pooler can break long sessions.',
            'Set ssl to require or verify-full.',
          ],
        },
        { id: 'neon', display_name: 'Neon', notes: ['Neon suspends idle branches; warm the branch before a large run.'] },
        { id: 'self_hosted', display_name: 'Self-hosted PostgreSQL' },
      ],
      secret_fields: ['password'],
      config_fields: [
        { name: 'host', label: 'Host', type: 'text', required: true, default: 'localhost', placeholder: 'localhost' },
        { name: 'port', label: 'Port', type: 'number', required: true, default: 5432 },
        { name: 'database', label: 'Database', type: 'text', required: true, default: 'postgres', placeholder: 'postgres' },
        { name: 'user', label: 'User', type: 'text', required: true, default: 'postgres', placeholder: 'postgres' },
        { name: 'password', label: 'Password', type: 'password', required: false },
        {
          name: 'ssl',
          label: 'TLS mode',
          type: 'select',
          required: true,
          default: 'require',
          options: [
            { value: 'require', label: 'Require TLS (encrypted, no CA check)' },
            { value: 'verify-full', label: 'Verify full (CA + hostname)' },
            { value: 'disable', label: 'Disable TLS (local/trusted network only)' },
          ],
        },
      ],
    };
  }

  validateConfig(config: Record<string, unknown>): ValidatedConnectionConfig {
    const parsed = ConfigSchema.safeParse(coerce(config));
    if (!parsed.success) {
      throw new UdmtError(
        'INVALID_CONFIG',
        `PostgreSQL config is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    return {
      config: parsed.data,
      endpoint_hint: `${parsed.data.host}:${parsed.data.port}/${parsed.data.database}`,
    };
  }

  async testConnection(config: Record<string, unknown>, secret: Record<string, unknown>): Promise<ConnectionTestResult> {
    const parsed = ConfigSchema.parse(config);
    const started = Date.now();
    const client = makeClient(parsed, secret);
    try {
      await client.connect();
      const version = await client.query<{ version: string }>('SELECT version() AS version');
      const current = await client.query<{ current_database: string; current_user: string }>(
        'SELECT current_database(), current_user',
      );
      const privileges = await client.query<{ can_write: boolean }>(
        `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_write`,
      );
      const canWrite = Boolean(privileges.rows[0]?.can_write);
      return {
        success: true,
        server_version: version.rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? 'unknown',
        database: current.rows[0]?.current_database ?? parsed.database,
        diagnostics: [
          `user: ${current.rows[0]?.current_user ?? parsed.user}`,
          `create privilege on public: ${canWrite}`,
          `latency: ${Date.now() - started}ms`,
        ],
        detected_capabilities: canWrite ? CAPS : CAPS.filter((c) => c !== 'write_data' && c !== 'schema_write'),
      };
    } catch (error) {
      const mapped = mapDriverError(error, 'PostgreSQL connection test');
      return {
        success: false,
        server_version: null,
        database: parsed.database,
        diagnostics: [mapped.message],
        detected_capabilities: [],
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async discoverResources(config: Record<string, unknown>, secret: Record<string, unknown>): Promise<ResourceDescriptor[]> {
    const parsed = ConfigSchema.parse(config);
    const client = makeClient(parsed, secret);
    try {
      await client.connect();
      const { rows } = await client.query<{
        table_schema: string;
        table_name: string;
        table_type: string;
      }>(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name`,
      );
      const schemas = [...new Set(rows.map((row) => row.table_schema))];
      return [
        ...schemas.map((schema) => ({
          id: schema,
          namespace: schema,
          name: schema,
          type: 'schema' as const,
        })),
        ...rows.map((row) => ({
          id: `${row.table_schema}.${row.table_name}`,
          namespace: row.table_schema,
          name: row.table_name,
          type: row.table_type === 'VIEW' ? ('view' as const) : ('table' as const),
        })),
      ];
    } catch (error) {
      throw mapDriverError(error, 'PostgreSQL resource discovery');
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async readSchema(config: Record<string, unknown>, secret: Record<string, unknown>, resource: string) {
    const parsed = ConfigSchema.parse(config);
    const [schema, table] = splitResource(resource);
    const client = makeClient(parsed, secret);
    try {
      await client.connect();
      const { rows } = await client.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table],
      );
      const estimate = await client.query<{ reltuples: number }>(
        `SELECT c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      );
      const keys = await client.query<{ column_name: string }>(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
        [schema, table],
      );
      const pk = new Set(keys.rows.map((row) => row.column_name));
      return {
        resource,
        source: 'declared' as const,
        rowCountEstimate: Math.max(0, Number(estimate.rows[0]?.reltuples ?? 0)),
        columns: rows.map((row) => ({
          name: row.column_name,
          type: pgTypeToCanonical(row.data_type, row.udt_name),
          nativeType: row.data_type === 'USER-DEFINED' ? row.udt_name : row.data_type,
          nullable: row.is_nullable === 'YES',
          primaryKey: pk.has(row.column_name),
        })),
      };
    } catch (error) {
      throw mapDriverError(error, 'PostgreSQL schema read');
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async *readRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: ReadRequest,
    ctx: OperationContext,
  ): AsyncGenerator<RowBatch> {
    const parsed = ConfigSchema.parse(config);
    const [schema, table] = splitResource(request.resource);
    const client = makeClient(parsed, secret);
    try {
      await client.connect();
      const columns = request.columns?.length
        ? request.columns.map(quoteIdent).join(', ')
        : '*';
      const limitClause = request.limit ? ` LIMIT ${Math.max(0, Math.trunc(request.limit))}` : '';
      const sql = `SELECT ${columns} FROM ${quoteIdent(schema)}.${quoteIdent(table)}${limitClause}`;
      const cursor = new Cursor<Record<string, unknown>>(sql, [], { rowMode: 'object' });
      (client as unknown as { query(query: unknown): unknown }).query(cursor);

      let emitted = 0;
      for (;;) {
        ctx.throwIfCancelled();
        const rows = (await cursor.read(request.batchSize)) as Record<string, unknown>[];
        if (rows.length === 0) break;
        emitted += rows.length;
        yield rows.map(normalizeRow);
        if (rows.length < request.batchSize) break;
      }
      ctx.log('info', `PostgreSQL read ${emitted} rows from ${request.resource}`);
    } catch (error) {
      throw mapDriverError(error, 'PostgreSQL read');
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async writeRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: WriteRequest,
    rows: AsyncIterable<RowBatch>,
    ctx: OperationContext,
  ): Promise<WriteResult> {
    const parsed = ConfigSchema.parse(config);
    const [schema, table] = splitResource(request.resource);
    const client = makeClient(parsed, secret);
    const warnings: string[] = [];
    let written = 0;
    try {
      await client.connect();
      const exists = await client.query<{ exists: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        [`${quoteIdent(schema)}.${quoteIdent(table)}`],
      );
      if (!exists.rows[0]?.exists) {
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
              `${quoteIdent(col.name)} ${PG_TYPE_MAP[col.type] ?? 'text'}${
                pk.length === 1 && col.primaryKey ? ' PRIMARY KEY' : ''
              }`,
          )
          .join(', ');
        const tablePk = pk.length > 1 ? `, PRIMARY KEY (${pk.map(quoteIdent).join(', ')})` : '';
        await client.query(`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(table)} (${cols}${tablePk})`);
        ctx.log('info', `Created table ${request.resource}`);
      }

      const existing = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
      );
      const existingCols = new Set(existing.rows.map((row) => row.column_name));
      const insertColumns = request.columns.map((col) => col.name).filter((name) => existingCols.has(name));
      const missing = request.columns.filter((col) => !existingCols.has(col.name)).map((col) => col.name);
      if (missing.length > 0) warnings.push(`Columns not present in target ignored: ${missing.join(', ')}`);
      if (insertColumns.length === 0) {
        throw new UdmtError('INVALID_INPUT', 'No importable columns matched the target table.');
      }

      if (request.mode === 'truncate_and_load') {
        await client.query(`TRUNCATE TABLE ${quoteIdent(schema)}.${quoteIdent(table)}`);
        ctx.log('warn', `Truncated ${request.resource} before loading (explicitly confirmed).`);
      }

      const colList = insertColumns.map(quoteIdent).join(', ');
      const conflict = buildConflictClause(request, existingCols);

      for await (const batch of rows) {
        ctx.throwIfCancelled();
        if (batch.length === 0) continue;
        const chunkSize = Math.max(1, Math.floor(30000 / insertColumns.length));
        for (let i = 0; i < batch.length; i += chunkSize) {
          const chunk = batch.slice(i, i + chunkSize);
          const params: unknown[] = [];
          const tuples = chunk.map((row) => {
            const placeholders = insertColumns.map((name) => {
              const col = request.columns.find((c) => c.name === name);
              params.push(toPgValue(row[name], col?.type ?? 'unknown'));
              return `$${params.length}`;
            });
            return `(${placeholders.join(', ')})`;
          });
          await client.query(
            `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${colList}) VALUES ${tuples.join(', ')} ${conflict}`,
            params,
          );
          written += chunk.length;
        }
      }
      ctx.log('info', `PostgreSQL wrote ${written} rows into ${request.resource}`);
      return { rows_written: written, rows_skipped: 0, warnings };
    } catch (error) {
      if (error instanceof UdmtError) throw error;
      throw mapDriverError(error, 'PostgreSQL write');
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

function buildConflictClause(request: WriteRequest, existingCols: Set<string>): string {
  if (request.mode !== 'upsert') return '';
  const keys = (request.keyColumns ?? []).filter((key) => existingCols.has(key));
  if (keys.length === 0) {
    throw new UdmtError('INVALID_INPUT', 'Upsert requires key columns that exist in the target table.');
  }
  const updates = request.columns
    .map((col) => col.name)
    .filter((name) => existingCols.has(name) && !keys.includes(name));
  if (updates.length === 0) return `ON CONFLICT (${keys.map(quoteIdent).join(', ')}) DO NOTHING`;
  return `ON CONFLICT (${keys.map(quoteIdent).join(', ')}) DO UPDATE SET ${updates
    .map((name) => `${quoteIdent(name)} = EXCLUDED.${quoteIdent(name)}`)
    .join(', ')}`;
}

function makeClient(
  config: z.infer<typeof ConfigSchema>,
  secret: Record<string, unknown>,
): Client {
  return new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: secret.password ? String(secret.password) : undefined,
    ssl:
      config.ssl === 'disable'
        ? false
        : { rejectUnauthorized: config.ssl === 'verify-full' },
    application_name: 'udmt',
    statement_timeout: 0,
    connectionTimeoutMillis: 10_000,
  });
}

function coerce(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, port: config.port === undefined ? 5432 : Number(config.port) };
}

export function splitResource(resource: string): [string, string] {
  const parts = resource.split('.');
  if (parts.length !== 2) {
    throw new UdmtError('INVALID_INPUT', `PostgreSQL resource must be "<schema>.<table>": ${resource}`);
  }
  const [schema, table] = parts as [string, string];
  for (const part of [schema, table]) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part)) {
      throw new UdmtError('INVALID_INPUT', `Invalid PostgreSQL identifier: ${part}`);
    }
  }
  return [schema, table];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = Buffer.isBuffer(value) ? value.toString('base64') : value;
  }
  return out;
}

function toPgValue(value: unknown, type: CanonicalType): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'binary':
      return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(String(value));
    case 'integer':
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : /^(1|true|yes)$/i.test(String(value));
    default:
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
  }
}

export function pgTypeToCanonical(dataType: string, udtName: string): CanonicalType {
  const t = dataType.toLowerCase();
  if (t.includes('integer') || t === 'bigint' || t === 'smallint' || t === 'serial' || t === 'bigserial') return 'integer';
  if (t.includes('numeric') || t.includes('real') || t.includes('double')) return 'number';
  if (t === 'boolean') return 'boolean';
  if (t.startsWith('timestamp') || t === 'timestamptz') return 'timestamp';
  if (t === 'date') return 'date';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'bytea') return 'binary';
  if (t.includes('array')) return 'json';
  if (udtName && !['varchar', 'text', 'bpchar', 'name', 'uuid', 'inet', 'cidr', 'numeric'].includes(udtName) && t === 'user-defined') {
    return 'string';
  }
  return 'string';
}

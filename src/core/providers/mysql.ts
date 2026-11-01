import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
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
  port: z.number().int().min(1).max(65535).default(3306),
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
];

const MYSQL_TYPE_MAP: Record<CanonicalType, string> = {
  string: 'TEXT',
  integer: 'BIGINT',
  number: 'DOUBLE',
  boolean: 'TINYINT(1)',
  timestamp: 'DATETIME(3)',
  date: 'DATE',
  json: 'JSON',
  binary: 'LONGBLOB',
  unknown: 'TEXT',
};

export class MySqlProvider implements DataProvider {
  readonly providerId = 'mysql';

  descriptor(): ProviderDescriptor {
    return {
      provider_id: 'mysql',
      display_name: 'MySQL / MariaDB',
      version: '1.0.0',
      built_in: true,
      capabilities: caps(...CAPS),
      service_profiles: [
        { id: 'mysql', display_name: 'MySQL' },
        { id: 'mariadb', display_name: 'MariaDB', notes: ['Upsert uses ON DUPLICATE KEY UPDATE, which MariaDB supports.'] },
        { id: 'planetscale', display_name: 'PlanetScale', notes: ['Enable safe migrations before destructive imports.'] },
      ],
      secret_fields: ['password'],
      config_fields: [
        { name: 'host', label: 'Host', type: 'text', required: true, default: 'localhost', placeholder: 'localhost' },
        { name: 'port', label: 'Port', type: 'number', required: true, default: 3306 },
        { name: 'database', label: 'Database', type: 'text', required: true, placeholder: 'app' },
        { name: 'user', label: 'User', type: 'text', required: true, default: 'root', placeholder: 'root' },
        { name: 'password', label: 'Password', type: 'password', required: false },
        {
          name: 'ssl',
          label: 'TLS mode',
          type: 'select',
          required: true,
          default: 'require',
          options: [
            { value: 'require', label: 'Require TLS' },
            { value: 'verify-full', label: 'Verify full (CA + hostname)' },
            { value: 'disable', label: 'Disable TLS (local/trusted network only)' },
          ],
        },
      ],
    };
  }

  validateConfig(config: Record<string, unknown>): ValidatedConnectionConfig {
    const parsed = ConfigSchema.safeParse({ ...config, port: config.port === undefined ? 3306 : Number(config.port) });
    if (!parsed.success) {
      throw new UdmtError(
        'INVALID_CONFIG',
        `MySQL config is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
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
    let connection: Connection | undefined;
    try {
      connection = await connect(parsed, secret);
      const [versionRows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
      const [dbRows] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS user');
      return {
        success: true,
        server_version: String(versionRows[0]?.version ?? 'unknown'),
        database: String(dbRows[0]?.db ?? parsed.database),
        diagnostics: [
          `user: ${String(dbRows[0]?.user ?? parsed.user)}`,
          `latency: ${Date.now() - started}ms`,
        ],
        detected_capabilities: CAPS,
      };
    } catch (error) {
      const mapped = mapDriverError(error, 'MySQL connection test');
      return {
        success: false,
        server_version: null,
        database: parsed.database,
        diagnostics: [mapped.message],
        detected_capabilities: [],
      };
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }

  async discoverResources(config: Record<string, unknown>, secret: Record<string, unknown>): Promise<ResourceDescriptor[]> {
    const parsed = ConfigSchema.parse(config);
    let connection: Connection | undefined;
    try {
      connection = await connect(parsed, secret);
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
         WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
         ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      );
      const records = rows as Array<{ TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string }>;
      const schemas = [...new Set(records.map((row) => row.TABLE_SCHEMA))];
      return [
        ...schemas.map((schema) => ({ id: schema, namespace: schema, name: schema, type: 'database' as const })),
        ...records.map((row) => ({
          id: `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`,
          namespace: row.TABLE_SCHEMA,
          name: row.TABLE_NAME,
          type: row.TABLE_TYPE === 'VIEW' ? ('view' as const) : ('table' as const),
        })),
      ];
    } catch (error) {
      throw mapDriverError(error, 'MySQL resource discovery');
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }

  async readSchema(config: Record<string, unknown>, secret: Record<string, unknown>, resource: string) {
    const parsed = ConfigSchema.parse(config);
    const [schema, table] = splitResource(resource);
    let connection: Connection | undefined;
    try {
      connection = await connect(parsed, secret);
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [schema, table],
      );
      const columns = rows as Array<{
        COLUMN_NAME: string;
        DATA_TYPE: string;
        IS_NULLABLE: string;
        COLUMN_KEY: string;
        COLUMN_TYPE: string;
      }>;
      return {
        resource,
        source: 'declared' as const,
        rowCountEstimate: null,
        columns: columns.map((row) => ({
          name: row.COLUMN_NAME,
          type: mysqlTypeToCanonical(row.DATA_TYPE),
          nativeType: row.COLUMN_TYPE,
          nullable: row.IS_NULLABLE === 'YES',
          primaryKey: row.COLUMN_KEY === 'PRI',
        })),
      };
    } catch (error) {
      throw mapDriverError(error, 'MySQL schema read');
    } finally {
      await connection?.end().catch(() => undefined);
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
    let connection: Connection | undefined;
    try {
      connection = await connect(parsed, secret);
      const columns = request.columns?.length ? request.columns.map(quoteIdent).join(', ') : '*';
      const limitClause = request.limit ? ` LIMIT ${Math.max(0, Math.trunc(request.limit))}` : '';
      const raw = (connection as unknown as { connection: { query(sql: string): { stream(): AsyncIterable<unknown> } } })
        .connection;
      const stream = raw.query(`SELECT ${columns} FROM ${quoteIdent(schema)}.${quoteIdent(table)}${limitClause}`).stream();

      let batch: RowBatch = [];
      let emitted = 0;
      for await (const raw of stream) {
        ctx.throwIfCancelled();
        batch.push(normalizeRow(raw as Record<string, unknown>));
        emitted += 1;
        if (batch.length >= request.batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
      ctx.log('info', `MySQL read ${emitted} rows from ${request.resource}`);
    } catch (error) {
      throw mapDriverError(error, 'MySQL read');
    } finally {
      await connection?.end().catch(() => undefined);
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
    let connection: Connection | undefined;
    const warnings: string[] = [];
    let written = 0;
    try {
      connection = await connect(parsed, secret);
      const [existing] = await connection.query<RowDataPacket[]>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [schema, table],
      );
      const existingCols = new Set((existing as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME));
      const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`;

      if (existingCols.size === 0) {
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
              `${quoteIdent(col.name)} ${MYSQL_TYPE_MAP[col.type] ?? 'TEXT'}${
                pk.length === 1 && col.primaryKey ? ' PRIMARY KEY' : ''
              }`,
          )
          .join(', ');
        const tablePk = pk.length > 1 ? `, PRIMARY KEY (${pk.map(quoteIdent).join(', ')})` : '';
        await connection.query(`CREATE TABLE ${qualified} (${cols}${tablePk})`);
        for (const col of request.columns) existingCols.add(col.name);
        ctx.log('info', `Created table ${request.resource}`);
      }

      const insertColumns = request.columns.map((col) => col.name).filter((name) => existingCols.has(name));
      const missing = request.columns.filter((col) => !existingCols.has(col.name)).map((col) => col.name);
      if (missing.length > 0) warnings.push(`Columns not present in target ignored: ${missing.join(', ')}`);
      if (insertColumns.length === 0) {
        throw new UdmtError('INVALID_INPUT', 'No importable columns matched the target table.');
      }

      if (request.mode === 'truncate_and_load') {
        await connection.query(`DELETE FROM ${qualified}`);
        ctx.log('warn', `Deleted all rows in ${request.resource} before loading (explicitly confirmed).`);
      }

      const colList = insertColumns.map(quoteIdent).join(', ');
      const placeholders = `(${insertColumns.map(() => '?').join(', ')})`;
      const conflict = buildUpsertClause(request, existingCols);

      for await (const batch of rows) {
        ctx.throwIfCancelled();
        if (batch.length === 0) continue;
        const chunkSize = Math.max(1, Math.floor(30000 / insertColumns.length));
        for (let i = 0; i < batch.length; i += chunkSize) {
          const chunk = batch.slice(i, i + chunkSize);
          const params: unknown[] = [];
          for (const row of chunk) {
            for (const name of insertColumns) {
              const col = request.columns.find((c) => c.name === name);
              params.push(toMySqlValue(row[name], col?.type ?? 'unknown'));
            }
          }
          await connection.query(
            `INSERT INTO ${qualified} (${colList}) VALUES ${chunk.map(() => placeholders).join(', ')} ${conflict}`,
            params,
          );
          written += chunk.length;
        }
      }
      ctx.log('info', `MySQL wrote ${written} rows into ${request.resource}`);
      return { rows_written: written, rows_skipped: 0, warnings };
    } catch (error) {
      if (error instanceof UdmtError) throw error;
      throw mapDriverError(error, 'MySQL write');
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }
}

function buildUpsertClause(request: WriteRequest, existingCols: Set<string>): string {
  if (request.mode !== 'upsert') return '';
  const keys = (request.keyColumns ?? []).filter((key) => existingCols.has(key));
  if (keys.length === 0) {
    throw new UdmtError('INVALID_INPUT', 'Upsert requires key columns that exist in the target table.');
  }
  const updates = request.columns
    .map((col) => col.name)
    .filter((name) => existingCols.has(name) && !keys.includes(name));
  if (updates.length === 0) return '';
  return `ON DUPLICATE KEY UPDATE ${updates.map((name) => `${quoteIdent(name)} = VALUES(${quoteIdent(name)})`).join(', ')}`;
}

async function connect(config: z.infer<typeof ConfigSchema>, secret: Record<string, unknown>): Promise<Connection> {
  try {
    return await createConnection({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: secret.password ? String(secret.password) : undefined,
      ssl: config.ssl === 'disable' ? undefined : { rejectUnauthorized: config.ssl === 'verify-full' },
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true,
    });
  } catch (error) {
    throw mapDriverError(error, 'MySQL connection');
  }
}

export function splitResource(resource: string): [string, string] {
  const parts = resource.split('.');
  if (parts.length !== 2) {
    throw new UdmtError('INVALID_INPUT', `MySQL resource must be "<database>.<table>": ${resource}`);
  }
  const [schema, table] = parts as [string, string];
  for (const part of [schema, table]) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part)) {
      throw new UdmtError('INVALID_INPUT', `Invalid MySQL identifier: ${part}`);
    }
  }
  return [schema, table];
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = Buffer.isBuffer(value) ? value.toString('base64') : value;
  }
  return out;
}

function toMySqlValue(value: unknown, type: CanonicalType): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'json') return typeof value === 'string' ? value : JSON.stringify(value);
  if (type === 'binary') return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(String(value));
  if (type === 'boolean') return value ? 1 : 0;
  if (type === 'timestamp' || type === 'date') {
    if (typeof value === 'string') return value.replace('T', ' ').replace('Z', '').slice(0, 23);
    return value;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function mysqlTypeToCanonical(declared: string): CanonicalType {
  const t = declared.toLowerCase();
  if (t.includes('int')) return 'integer';
  if (t.includes('decimal') || t.includes('numeric') || t.includes('float') || t.includes('double')) return 'number';
  if (t.includes('bool') || t === 'tinyint') return 'boolean';
  if (t.includes('datetime') || t.includes('timestamp') || t.includes('time')) return 'timestamp';
  if (t === 'date') return 'date';
  if (t === 'json') return 'json';
  if (t.includes('blob') || t.includes('binary')) return 'binary';
  return 'string';
}

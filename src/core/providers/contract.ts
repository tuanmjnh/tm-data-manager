import type {
  CanonicalType,
  CapabilityDescriptor,
  CapabilityId,
  ColumnSchema,
  Row,
  RowBatch,
} from '../types.js';

export interface OperationMetrics {
  rows_read?: number;
  rows_written?: number;
  bytes_written?: number;
  current_resource?: string;
}

export interface OperationContext {
  runId: string;
  signal: AbortSignal;
  /** Throws OPERATION_CANCELLED when the run was asked to stop. */
  throwIfCancelled(): void;
  progress(update: { percent?: number; stage?: string; message?: string; metrics?: OperationMetrics }): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  warn(message: string): void;
}

export interface ReadRequest {
  resource: string;
  columns?: string[];
  /** Provider-specific filter. Providers must validate it, never interpolate raw SQL. */
  filter?: Record<string, unknown>;
  limit?: number;
  batchSize: number;
  /** Continue after this key tuple (checkpoint for resumable exports). */
  offset?: number;
  /**
   * Watermark read: return only rows whose `column` is strictly greater than
   * `after`, ordered by that column. Only used when the provider declares the
   * `incremental_read` capability; `after === null` means "read everything".
   */
  incremental?: { column: string; after: unknown };
}

export interface WriteRequest {
  resource: string;
  columns: ColumnSchema[];
  mode: 'append' | 'upsert' | 'truncate_and_load';
  keyColumns?: string[];
  createResource?: boolean;
  /** How an upsert handles an existing key. Defaults to `overwrite`. */
  onConflict?: 'overwrite' | 'ignore';
  /** `add_columns` lets a provider add missing target columns instead of ignoring them. */
  schemaEvolution?: 'ignore' | 'add_columns';
}

export interface WriteResult {
  rows_written: number;
  rows_skipped: number;
  warnings: string[];
}

export interface ConnectionTestResult {
  success: boolean;
  server_version: string | null;
  database: string | null;
  latency_ms?: number;
  diagnostics: string[];
  detected_capabilities: CapabilityId[];
}

export interface ValidatedConnectionConfig {
  config: Record<string, unknown>;
  /** Sanitized one-line summary for list views. */
  endpoint_hint: string;
}

/**
 * A provider adapter. Operations are optional capability interfaces:
 * a provider only implements what its descriptor declares.
 */
export interface DataProvider {
  readonly providerId: string;
  descriptor(): import('../types.js').ProviderDescriptor;

  validateConfig(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
  ): ValidatedConnectionConfig;

  testConnection(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    ctx: OperationContext,
  ): Promise<ConnectionTestResult>;

  discoverResources(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    ctx: OperationContext,
  ): Promise<import('../types.js').ResourceDescriptor[]>;

  readSchema?(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    resource: string,
    ctx: OperationContext,
  ): Promise<import('../types.js').ResourceSchema>;

  readRows?(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: ReadRequest,
    ctx: OperationContext,
  ): AsyncGenerator<RowBatch, void, unknown>;

  writeRows?(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: WriteRequest,
    rows: AsyncIterable<RowBatch>,
    ctx: OperationContext,
  ): Promise<WriteResult>;
}

export const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  test_connection: 'Test connection',
  discover_resources: 'Discover resources',
  read_data: 'Read data',
  write_data: 'Write data',
  schema_read: 'Read schema',
  schema_write: 'Create/alter schema',
  bulk_write: 'Bulk write',
  transactions: 'Transactions',
  consistent_snapshot: 'Consistent snapshot',
  query: 'Query',
  incremental_read: 'Incremental/watermark read',
  native_backup: 'Native backup',
  native_restore: 'Native restore',
};

export function caps(...ids: CapabilityId[]): CapabilityDescriptor[] {
  const all = Object.keys(CAPABILITY_LABELS) as CapabilityId[];
  return all.map((id) => ({ id, supported: ids.includes(id) }));
}

export function hasCapability(
  descriptor: { capabilities: CapabilityDescriptor[] },
  id: CapabilityId,
): boolean {
  return descriptor.capabilities.some((cap) => cap.id === id && cap.supported);
}

/** Normalizes values into the canonical intermediate types used by formats. */
export function canonicalizeValue(value: unknown, type: CanonicalType): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'timestamp':
    case 'date': {
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
    }
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return /^(1|true|yes|t)$/i.test(value);
      return Boolean(value);
    }
    case 'json':
      return value;
    case 'binary':
      if (Buffer.isBuffer(value)) return value.toString('base64');
      return String(value);
    case 'string':
      return typeof value === 'string' ? value : String(value);
    default:
      return value;
  }
}

export function sampleColumns(rows: Row[]): ColumnSchema[] {
  const seen = new Map<string, CanonicalType>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const inferred = inferType(value);
      const previous = seen.get(key);
      seen.set(key, previous && previous !== inferred ? 'string' : inferred);
    }
  }
  return [...seen.entries()].map(([name, type]) => ({ name, type }));
}

export function inferType(value: unknown): CanonicalType {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (value instanceof Date) return 'timestamp';
  if (Buffer.isBuffer(value)) return 'binary';
  if (typeof value === 'object') return 'json';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return 'timestamp';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
    if (/^-?\d+$/.test(value) && value.length < 16) return 'integer';
    if (/^-?\d*\.\d+$/.test(value)) return 'number';
    if (/^(true|false)$/i.test(value)) return 'boolean';
    return 'string';
  }
  return 'unknown';
}

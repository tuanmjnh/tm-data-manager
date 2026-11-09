import type { CanonicalType, ColumnSchema, SyncFieldMapping, SyncFilter } from '../types.js';

/** A row-level problem that can fail the run or be skipped and reported. */
export class SyncRowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncRowError';
  }
}

export interface CompiledSyncField {
  source: string;
  target: string;
  cast: CanonicalType;
  defaultValue: unknown;
  trim: boolean;
  mask: SyncFieldMapping['mask'];
  valueMap: Record<string, string> | null;
}

/**
 * Turns the user mapping into a deterministic field list. An empty mapping means
 * "same name on both sides", which is safe and keeps simple pipelines terse.
 */
export function compileSyncMapping(
  mapping: SyncFieldMapping[],
  sourceColumns: ColumnSchema[],
): CompiledSyncField[] {
  if (mapping.length === 0) {
    if (sourceColumns.length === 0) {
      throw new SyncRowError('MAPPING_EMPTY', 'Source schema has no columns to map.');
    }
    return sourceColumns.map((column) => ({
      source: column.name,
      target: column.name,
      cast: column.type,
      defaultValue: null,
      trim: false,
      mask: undefined,
      valueMap: null,
    }));
  }

  const sources = new Set(sourceColumns.map((column) => column.name));
  const targets = new Set<string>();
  return mapping.map((entry) => {
    const source = entry.source.trim();
    const target = (entry.target ?? entry.source).trim();
    if (!source || !target) {
      throw new SyncRowError('MAPPING_INVALID', 'Mapping entries need a source and target field name.');
    }
    if (sourceColumns.length > 0 && !sources.has(source)) {
      throw new SyncRowError('MAPPING_UNKNOWN_SOURCE', `Mapping source "${source}" is not in the source schema.`);
    }
    if (targets.has(target)) {
      throw new SyncRowError('MAPPING_DUPLICATE_TARGET', `Two mapping entries write the same target field "${target}".`);
    }
    targets.add(target);
    const column = sourceColumns.find((item) => item.name === source);
    return {
      source,
      target,
      cast: entry.cast ?? column?.type ?? 'unknown',
      defaultValue: entry.default ?? null,
      trim: entry.trim ?? false,
      mask: entry.mask,
      valueMap: entry.value_map ?? null,
    };
  });
}

/** Target column schemas derived from the mapping, used by the provider writer. */
export function syncTargetColumns(fields: CompiledSyncField[], keyColumns: string[]): ColumnSchema[] {
  return fields.map((field) => ({
    name: field.target,
    type: field.cast,
    nullable: field.defaultValue === null,
    primaryKey: keyColumns.includes(field.target),
  }));
}

export interface TransformResult {
  row: Record<string, unknown>;
  transformed: number;
}

/**
 * Applies default, trim, value map, cast and mask in that order. Unsupported or
 * lossy conversions throw instead of silently writing a different value.
 */
export function transformSyncRow(row: Record<string, unknown>, fields: CompiledSyncField[]): TransformResult {
  const out: Record<string, unknown> = {};
  let transformed = 0;
  for (const field of fields) {
    let value = readField(row, field.source);
    if (value === undefined || value === null) value = field.defaultValue;
    if (value !== undefined && value !== null) {
      if (field.trim && typeof value === 'string') value = value.trim();
      if (field.valueMap && Object.prototype.hasOwnProperty.call(field.valueMap, String(value))) {
        value = field.valueMap[String(value)];
        transformed += 1;
      }
      value = castSyncValue(value, field.cast, field.target);
      if (field.mask) value = maskValue(value, field.mask);
    }
    out[field.target] = value === undefined ? null : value;
  }
  return { row: out, transformed };
}

export function castSyncValue(value: unknown, type: CanonicalType, field = 'value'): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (type) {
    case 'string':
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    case 'integer': {
      const n = toFiniteNumber(value);
      if (!Number.isInteger(n)) {
        throw new SyncRowError('CAST_FAILED', `${field}: "${String(value)}" is not an integer.`);
      }
      return n;
    }
    case 'number': {
      const n = toFiniteNumber(value);
      if (typeof value === 'string' && /^-?\d{16,}$/.test(value.trim()) && !Number.isSafeInteger(n)) {
        throw new SyncRowError('PRECISION_LOSS', `${field}: "${value}" cannot be represented exactly as a number.`);
      }
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1;
      const text = String(value).trim().toLowerCase();
      if (text === 'true' || text === '1') return true;
      if (text === 'false' || text === '0') return false;
      throw new SyncRowError('CAST_FAILED', `${field}: "${String(value)}" is not a boolean.`);
    }
    case 'timestamp':
    case 'date': {
      const parsed = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(parsed.getTime())) {
        throw new SyncRowError('CAST_FAILED', `${field}: "${String(value)}" is not a valid date.`);
      }
      return parsed.toISOString();
    }
    case 'json': {
      if (typeof value === 'object') return JSON.stringify(value);
      const text = String(value);
      try {
        JSON.parse(text);
        return text;
      } catch {
        return JSON.stringify(text);
      }
    }
    case 'binary':
      if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
      return String(value);
    default:
      return value;
  }
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'bigint') {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new SyncRowError('PRECISION_LOSS', `"${value}" exceeds safe number precision.`);
    return n;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new SyncRowError('CAST_FAILED', `"${String(value)}" is not a number.`);
  return n;
}

export function maskValue(value: unknown, mask: NonNullable<SyncFieldMapping['mask']>): string {
  const text = String(value ?? '');
  if (mask === 'full') return '***';
  if (mask === 'email') {
    const [local = '', domain] = text.split('@');
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
  }
  return `***${text.replace(/\s/g, '').slice(-4)}`;
}

/** Reads a top-level or dotted nested field without evaluating expressions. */
export function readField(row: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, path)) return row[path];
  if (!path.includes('.')) return undefined;
  let current: unknown = row;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function evaluateSyncFilter(row: Record<string, unknown>, filter: SyncFilter | null | undefined): boolean {
  if (!filter) return true;
  const value = readField(row, filter.column);
  switch (filter.operator) {
    case 'is_null':
      return value === null || value === undefined;
    case 'not_null':
      return value !== null && value !== undefined;
    case 'eq':
      return compareValues(value, filter.value) === 0;
    case 'neq':
      return compareValues(value, filter.value) !== 0;
    case 'gt':
      return compareValues(value, filter.value) > 0;
    case 'gte':
      return compareValues(value, filter.value) >= 0;
    case 'lt':
      return compareValues(value, filter.value) < 0;
    case 'lte':
      return compareValues(value, filter.value) <= 0;
    case 'contains':
      return value !== null && value !== undefined && String(value).includes(String(filter.value ?? ''));
    case 'in':
      return Array.isArray(filter.value) && filter.value.some((item) => compareValues(value, item) === 0);
    default:
      throw new SyncRowError('FILTER_INVALID', `Unsupported filter operator: ${String(filter.operator)}`);
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : -1;
  if (right === null || right === undefined) return 1;
  const leftNumber = typeof left === 'number' ? left : Number(String(left));
  const rightNumber = typeof right === 'number' ? right : Number(String(right));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right));
}

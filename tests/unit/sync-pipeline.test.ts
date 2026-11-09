import { describe, expect, it } from 'vitest';
import {
  SyncRowError,
  castSyncValue,
  compileSyncMapping,
  evaluateSyncFilter,
  maskValue,
  readField,
  syncTargetColumns,
  transformSyncRow,
} from '../../src/core/sync/pipeline.js';
import type { ColumnSchema } from '../../src/core/types.js';

const sourceColumns: ColumnSchema[] = [
  { name: 'id', type: 'integer', nullable: false, primaryKey: true },
  { name: 'name', type: 'string', nullable: true },
  { name: 'email', type: 'string', nullable: true },
  { name: 'age', type: 'integer', nullable: true },
  { name: 'score', type: 'number', nullable: true },
  { name: 'meta', type: 'json', nullable: true },
];

describe('sync mapping', () => {
  it('maps every source column by name when no mapping is given', () => {
    const fields = compileSyncMapping([], sourceColumns);
    expect(fields.map((field) => field.target)).toEqual(['id', 'name', 'email', 'age', 'score', 'meta']);
    expect(fields[0]!.cast).toBe('integer');
  });

  it('rejects unknown sources and duplicate targets', () => {
    expect(() => compileSyncMapping([{ source: 'missing', target: 'x' }], sourceColumns)).toThrow(SyncRowError);
    expect(() =>
      compileSyncMapping(
        [
          { source: 'id', target: 'id' },
          { source: 'name', target: 'id' },
        ],
        sourceColumns,
      ),
    ).toThrow(/same target field/);
  });

  it('derives target columns and key metadata', () => {
    const fields = compileSyncMapping(
      [
        { source: 'id', target: 'user_id' },
        { source: 'name', target: 'full_name', cast: 'string' },
      ],
      sourceColumns,
    );
    const columns = syncTargetColumns(fields, ['user_id']);
    expect(columns).toEqual([
      { name: 'user_id', type: 'integer', nullable: true, primaryKey: true },
      { name: 'full_name', type: 'string', nullable: true, primaryKey: false },
    ]);
  });
});

describe('sync row transform', () => {
  it('applies default, trim, value map, cast and mask in a deterministic order', () => {
    const fields = compileSyncMapping(
      [
        { source: 'id', target: 'id', cast: 'string' },
        { source: 'name', target: 'name', trim: true },
        { source: 'email', target: 'email', mask: 'email' },
        { source: 'age', target: 'age', cast: 'integer', default: 18 },
        { source: 'meta', target: 'tier', cast: 'string', value_map: { gold: 'premium' } },
        { source: 'score', target: 'country', cast: 'string', default: 'unknown' },
      ],
      sourceColumns,
    );
    const result = transformSyncRow(
      {
        id: 7,
        name: '  Ada  ',
        email: 'ada@example.com',
        age: '42',
        meta: 'gold',
      },
      fields,
    );
    expect(result.row).toEqual({
      id: '7',
      name: 'Ada',
      email: 'a***@example.com',
      age: 42,
      tier: 'premium',
      country: 'unknown',
    });
    expect(result.transformed).toBe(1);
  });

  it('fails instead of silently writing lossy values', () => {
    expect(() => castSyncValue('12.5', 'integer', 'age')).toThrow(/not an integer/);
    expect(() => castSyncValue('9007199254740993', 'number', 'id')).toThrow(/cannot be represented exactly/);
    expect(() => castSyncValue('yes', 'boolean', 'active')).toThrow(/not a boolean/);
  });

  it('masks values without leaking the original', () => {
    expect(maskValue('ada@example.com', 'email')).toBe('a***@example.com');
    expect(maskValue('12345678', 'last4')).toBe('***5678');
    expect(maskValue('secret', 'full')).toBe('***');
  });

  it('reads dotted nested values only', () => {
    expect(readField({ nested: { value: 1 } }, 'nested.value')).toBe(1);
    expect(readField({ nested: { value: 1 } }, 'nested.missing')).toBeUndefined();
    expect(readField({ 'a.b': 2 }, 'a.b')).toBe(2);
  });
});

describe('sync filter', () => {
  const row = { id: 5, name: 'Ada', age: '42', tags: ['a', 'b'] };

  it('evaluates comparison, null, contains and in operators', () => {
    expect(evaluateSyncFilter(row, { column: 'age', operator: 'gt', value: 40 })).toBe(true);
    expect(evaluateSyncFilter(row, { column: 'age', operator: 'lt', value: 40 })).toBe(false);
    expect(evaluateSyncFilter(row, { column: 'name', operator: 'contains', value: 'da' })).toBe(true);
    expect(evaluateSyncFilter(row, { column: 'id', operator: 'in', value: [1, 5] })).toBe(true);
    expect(evaluateSyncFilter({ ...row, age: null }, { column: 'age', operator: 'is_null' })).toBe(true);
    expect(evaluateSyncFilter(row, { column: 'age', operator: 'not_null' })).toBe(true);
    expect(evaluateSyncFilter(row, null)).toBe(true);
  });
});

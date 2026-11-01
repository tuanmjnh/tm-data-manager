import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFormatWriter, detectFormat, readRowsFromFile, coerceRow } from '../../src/core/formats/index.js';
import type { ColumnSchema, Row } from '../../src/core/types.js';
import { UdmtError } from '../../src/core/errors.js';

const dir = mkdtempSync(join(tmpdir(), 'udmt-formats-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const columns: ColumnSchema[] = [
  { name: 'id', type: 'integer' },
  { name: 'name', type: 'string' },
  { name: 'active', type: 'boolean' },
  { name: 'meta', type: 'json' },
];

const rows: Row[] = [
  { id: 1, name: 'Alice, "A"', active: true, meta: { tier: 'gold' } },
  { id: 2, name: 'Bob', active: false, meta: { tier: 'basic' } },
  { id: 3, name: null, active: true, meta: null },
];

async function roundtrip(format: 'jsonl' | 'csv' | 'json', compression: 'none' | 'gzip') {
  const path = join(dir, `data.${format}${compression === 'gzip' ? '.gz' : ''}`);
  const writer = createFormatWriter(format, compression, path, format === 'csv' ? columns : []);
  for (const row of rows) await writer.write(row);
  const result = await writer.finish();
  const read: Row[] = [];
  for await (const row of readRowsFromFile(path, { format, columns, coerce: true })) read.push(row);
  return { path, result, read };
}

describe('format adapters', () => {
  it('round-trips JSONL without loss', async () => {
    const { result, read } = await roundtrip('jsonl', 'none');
    expect(result.row_count).toBe(3);
    expect(read).toEqual(rows);
  });

  it('round-trips gzipped JSONL and reports compressed bytes', async () => {
    const { path, result, read } = await roundtrip('jsonl', 'gzip');
    expect(read).toHaveLength(3);
    expect(result.bytes_written).toBe(statSync(path).size);
    expect(read[0]?.name).toBe('Alice, "A"');
  });

  it('round-trips a JSON array and coerces typed columns', async () => {
    const { read } = await roundtrip('json', 'none');
    expect(read).toHaveLength(3);
    expect(read[0]?.active).toBe(true);
    expect(read[2]?.meta).toBeNull();
  });

  it('escapes CSV values and preserves nested JSON', async () => {
    const { path, read } = await roundtrip('csv', 'none');
    expect(read).toHaveLength(3);
    expect(read[0]?.name).toBe('Alice, "A"');
    expect(read[0]?.meta).toEqual({ tier: 'gold' });
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe('id,name,active,meta');
  });

  it('rejects non-array JSON documents', async () => {
    const path = join(dir, 'invalid.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{"not":"an array"}');
    await expect(async () => {
      for await (const row of readRowsFromFile(path, { format: 'json', columns, coerce: true })) void row;
    }).rejects.toThrow(UdmtError);
  });

  it('detects formats from file names', () => {
    expect(detectFormat('x.jsonl.gz')).toBe('jsonl');
    expect(detectFormat('x.ndjson')).toBe('jsonl');
    expect(detectFormat('x.CSV')).toBe('csv');
    expect(detectFormat('x.json')).toBe('json');
    expect(() => detectFormat('x.parquet')).toThrow(UdmtError);
  });

  it('coerces CSV strings to the manifest types', () => {
    const coerced = coerceRow(
      { id: '42', name: 'x', active: 'false', meta: '{"a":1}' },
      columns,
    );
    expect(coerced.id).toBe(42);
    expect(coerced.active).toBe(false);
    expect(coerced.meta).toEqual({ a: 1 });
  });
});

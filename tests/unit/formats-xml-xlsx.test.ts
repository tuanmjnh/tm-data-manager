import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFormatWriter, detectFormat, readRowsFromFile } from '../../src/core/formats/index.js';
import type { ColumnSchema, Row } from '../../src/core/types.js';

const columns: ColumnSchema[] = [
  { name: 'id', type: 'integer' },
  { name: 'name', type: 'string' },
  { name: 'active', type: 'boolean' },
  { name: 'score', type: 'number' },
  { name: 'meta', type: 'json' },
  { name: 'note', type: 'string' },
];

const rows: Row[] = [
  { id: 1, name: 'Ada & <Lovelace>', active: true, score: 1.5, meta: { tier: 'gold' }, note: null },
  { id: 2, name: ' Grace ', active: false, score: 2, meta: { tier: 'basic' }, note: 'ok' },
];

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-formats-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('XML format adapter', () => {
  it('round-trips typed values, nested JSON, nulls and escaped text', async () => {
    const path = join(workDir, 'rows.xml');
    const writer = createFormatWriter('xml', 'none', path, columns);
    for (const row of rows) await writer.write(row);
    const result = await writer.finish();
    expect(result.row_count).toBe(2);

    const read: Row[] = [];
    for await (const row of readRowsFromFile(path, { format: 'xml', columns: [], coerce: false })) read.push(row);
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({
      id: 1,
      name: 'Ada & <Lovelace>',
      active: true,
      score: 1.5,
      meta: { tier: 'gold' },
      note: null,
    });
    expect(read[1]!.name).toBe(' Grace ');
    expect(detectFormat(path)).toBe('xml');
  });

  it('parses generic XML row elements produced by other tools', async () => {
    const path = join(workDir, 'generic.xml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '<rows><row><id>7</id><name>Ada</name></row><row><id>8</id><name>Grace</name></row></rows>');
    const read: Row[] = [];
    for await (const row of readRowsFromFile(path, { format: 'xml', columns: [], coerce: false })) read.push(row);
    // Generic XML has no type metadata, so cells stay strings; manifests/providers coerce them.
    expect(read).toEqual([
      { id: '7', name: 'Ada' },
      { id: '8', name: 'Grace' },
    ]);
  });
});

describe('XLSX format adapter', () => {
  it('writes a header row and reads typed cells with manifest coercion', async () => {
    const path = join(workDir, 'rows.xlsx');
    const writer = createFormatWriter('xlsx', 'none', path, columns);
    for (const row of rows) await writer.write(row);
    const result = await writer.finish();
    expect(result.row_count).toBe(2);
    expect(result.bytes_written).toBeGreaterThan(0);

    const read: Row[] = [];
    for await (const row of readRowsFromFile(path, { format: 'xlsx', columns, coerce: true })) read.push(row);
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({ id: 1, name: 'Ada & <Lovelace>', active: true, score: 1.5 });
    expect(read[0]!.meta).toEqual({ tier: 'gold' });
    expect(read[1]!.name).toBe(' Grace ');
    expect(detectFormat(path)).toBe('xlsx');
  });

  it('rejects gzip compression because XLSX is already a zip container', async () => {
    expect(() => createFormatWriter('xlsx', 'gzip', join(workDir, 'x.xlsx'), columns)).toThrow(/already a compressed/);
  });
});

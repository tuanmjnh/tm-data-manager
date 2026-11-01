import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteProvider } from '../../src/core/providers/sqlite.js';
import type { OperationContext } from '../../src/core/providers/contract.js';

const dir = mkdtempSync(join(tmpdir(), 'udmt-provider-'));
const path = join(dir, 'test.db');

const ctx: OperationContext = {
  runId: 'test',
  signal: new AbortController().signal,
  throwIfCancelled: () => undefined,
  progress: () => undefined,
  log: () => undefined,
  warn: () => undefined,
};

const provider = new SqliteProvider();

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SQLite provider', () => {
  it('validates configuration', () => {
    expect(provider.validateConfig({ path }).endpoint_hint).toBe(path);
    expect(() => provider.validateConfig({})).toThrow();
  });

  it('names the missing file instead of a bare "unable to open database file"', async () => {
    const missing = join(dir, 'does-not-exist.db');
    await expect(provider.discoverResources({ path: missing })).rejects.toThrow(/not found: .*does-not-exist\.db/);
    const read = async () => {
      for await (const _batch of provider.readRows({ path: missing }, {}, { resource: 'users', batchSize: 10 }, ctx)) {
        // drain
      }
    };
    await expect(read()).rejects.toThrow(/not found: .*does-not-exist\.db/);
  });

  it('creates a table, writes rows and reads them back', async () => {
    const config = { path: join(dir, 'write.db') };
    const columns = [
      { name: 'id', type: 'integer' as const, primaryKey: true },
      { name: 'name', type: 'string' as const },
      { name: 'active', type: 'boolean' as const },
      { name: 'meta', type: 'json' as const },
    ];

    async function* rows() {
      yield [
        { id: 1, name: 'Alice', active: true, meta: { tier: 'gold' } },
        { id: 2, name: 'Bob', active: false, meta: { tier: 'basic' } },
      ];
    }

    const result = await provider.writeRows(
      config,
      {},
      { resource: 'people', columns, mode: 'append', createResource: true },
      rows(),
      ctx,
    );
    expect(result.rows_written).toBe(2);

    const schema = await provider.readSchema(config, {}, 'people');
    expect(schema.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true);
    expect(schema.rowCountEstimate).toBe(2);

    const read: Array<Record<string, unknown>> = [];
    for await (const batch of provider.readRows(config, {}, { resource: 'people', batchSize: 1 }, ctx)) {
      read.push(...batch);
    }
    expect(read).toHaveLength(2);
    expect(read[0]?.meta).toBe('{"tier":"gold"}');

    // Upsert updates the existing primary key instead of duplicating it.
    async function* update() {
      yield [{ id: 1, name: 'Alice Updated', active: false, meta: { tier: 'gold' } }];
    }
    await provider.writeRows(
      config,
      {},
      { resource: 'people', columns, mode: 'upsert', keyColumns: ['id'], createResource: false },
      update(),
      ctx,
    );
    const after: Array<Record<string, unknown>> = [];
    for await (const batch of provider.readRows(config, {}, { resource: 'people', batchSize: 10 }, ctx)) after.push(...batch);
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.id === 1)?.name).toBe('Alice Updated');
  });

  it('reports a clear error when the target table is missing', async () => {
    const config = { path: join(dir, 'missing.db') };
    async function* rows() {
      yield [{ id: 1 }];
    }
    await expect(
      provider.writeRows(config, {}, { resource: 'nope', columns: [{ name: 'id', type: 'integer' }], mode: 'append', createResource: false }, rows(), ctx),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('honours cancellation between batches', async () => {
    const controller = new AbortController();
    controller.abort();
    const config = { path: join(dir, 'cancel.db') };
    const cancelledCtx: OperationContext = {
      ...ctx,
      signal: controller.signal,
      throwIfCancelled: () => {
        throw new Error('cancelled');
      },
    };
    async function* rows() {
      yield [{ id: 1 }];
    }
    await expect(
      provider.writeRows(config, {}, { resource: 't', columns: [{ name: 'id', type: 'integer' }], mode: 'append', createResource: true }, rows(), cancelledCtx),
    ).rejects.toThrow();
  });
});


#!/usr/bin/env node
/**
 * Reference UDMT external provider (protocol `udmt-provider/1`).
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. It keeps an in-memory
 * dataset so a plugin host can be exercised end-to-end (discover, schema, read,
 * write) with no network access. Notifications are ignored; every request gets a
 * single response.
 */
import { createInterface } from 'node:readline';

const PROTOCOL = 'udmt-provider/1';
const CAPABILITIES = ['test_connection', 'discover_resources', 'read_data', 'write_data', 'schema_read', 'bulk_write'];

const database = new Map([
  ['items', seedRows(25)],
]);

let grantedPermissions = [];
let received = [];

function seedRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Item ${index + 1}`,
    score: (index + 1) * 1.5,
    active: index % 2 === 0,
  }));
}

function rowsFor(resource) {
  if (!database.has(resource)) database.set(resource, []);
  return database.get(resource);
}

const handlers = {
  initialize(params) {
    grantedPermissions = Array.isArray(params?.permissions) ? params.permissions : [];
    return { protocol: PROTOCOL, server: { name: 'sample.jsonapi', version: '1.0.0' }, capabilities: CAPABILITIES };
  },
  'provider.testConnection'() {
    return {
      success: true,
      server_version: 'sample-1.0.0',
      database: 'in-memory',
      latency_ms: 1,
      diagnostics: [`permissions: ${grantedPermissions.join(',') || 'none'}`],
      detected_capabilities: CAPABILITIES,
    };
  },
  'provider.discoverResources'() {
    return [...database.keys()].map((name) => ({
      id: name,
      namespace: 'sample',
      name,
      type: 'collection',
      metadata: { rows: rowsFor(name).length },
    }));
  },
  'provider.readSchema'(params) {
    const rows = rowsFor(params.resource);
    const sample = rows[0] ?? { id: 0, name: '', score: 0, active: true };
    return {
      resource: params.resource,
      columns: Object.keys(sample).map((name) => ({ name, type: typeof sample[name] === 'number' ? 'number' : typeof sample[name] === 'boolean' ? 'boolean' : 'string' })),
      rowCountEstimate: rows.length,
      source: 'sampled',
    };
  },
  'provider.readBatch'(params) {
    const { resource, batchSize = 1000, limit, offset = 0 } = params.request ?? {};
    const rows = rowsFor(resource);
    const start = Number(offset) || 0;
    const end = limit ? Math.min(start + batchSize, Number(limit)) : Math.min(start + batchSize, rows.length);
    const slice = rows.slice(start, end);
    const next = end < rows.length && (!limit || end < Number(limit)) ? end : null;
    return { rows: slice, next_offset: next };
  },
  'provider.writeBatch'(params) {
    const { resource, rows } = params;
    const target = rowsFor(resource);
    target.push(...rows);
    received = received.concat(rows);
    return { rows_written: rows.length, rows_skipped: 0, warnings: [] };
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.method === 'shutdown') {
    process.exit(0);
  }
  if (message.id === undefined) return; // notification
  const handler = handlers[message.method];
  if (!handler) {
    respond({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    return;
  }
  try {
    respond({ jsonrpc: '2.0', id: message.id, result: handler(message.params ?? {}) });
  } catch (error) {
    respond({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: error.message, data: { code: 'OPERATION_FAILED' } },
    });
  }
});

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

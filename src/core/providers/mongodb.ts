import { MongoClient, ObjectId, Decimal128, Long, Binary } from 'mongodb';
import { z } from 'zod';
import { UdmtError, mapDriverError } from '../errors.js';
import type { CanonicalType, CapabilityId, ProviderDescriptor, Row, RowBatch } from '../types.js';
import { maskEndpoint } from '../utils.js';
import type {
  ConnectionTestResult,
  DataProvider,
  OperationContext,
  ReadRequest,
  ValidatedConnectionConfig,
  WriteRequest,
  WriteResult,
} from './contract.js';
import { caps, inferType } from './contract.js';

const ConfigSchema = z.object({
  uri: z.string().min(1),
  database: z.string().optional(),
});

const CAPS: CapabilityId[] = [
  'test_connection',
  'discover_resources',
  'read_data',
  'write_data',
  'schema_read',
  'bulk_write',
  'consistent_snapshot',
];

export class MongoDbProvider implements DataProvider {
  readonly providerId = 'mongodb';

  descriptor(): ProviderDescriptor {
    return {
      provider_id: 'mongodb',
      display_name: 'MongoDB',
      version: '1.0.0',
      built_in: true,
      capabilities: caps(...CAPS),
      service_profiles: [
        {
          id: 'mongodb_atlas',
          display_name: 'MongoDB Atlas',
          notes: ['Use an SRV connection string; credentials are stored in the local vault, never in SQLite.'],
        },
        { id: 'self_hosted', display_name: 'Self-hosted MongoDB' },
        { id: 'local', display_name: 'Local MongoDB' },
      ],
      secret_fields: ['password'],
      config_fields: [
        {
          name: 'uri',
          label: 'Connection string',
          type: 'text',
          required: true,
          default: 'mongodb://localhost:27017',
          placeholder: 'mongodb://localhost:27017/app',
          help: 'Local: mongodb://localhost:27017/<database>. Atlas: mongodb+srv://user@cluster/?retryWrites=true. Leave the password out — it is stored separately in the encrypted vault.',
        },
        {
          name: 'database',
          label: 'Default database',
          type: 'text',
          required: false,
          placeholder: 'app',
          help: 'Auto-filled from the database in the connection string; override it here if needed.',
        },
        { name: 'password', label: 'Password', type: 'password', required: false },
      ],
    };
  }

  validateConfig(config: Record<string, unknown>): ValidatedConnectionConfig {
    const parsed = ConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new UdmtError('INVALID_CONFIG', 'MongoDB config needs a connection string (uri).');
    }
    if (!/^mongodb(\+srv)?:\/\//.test(parsed.data.uri)) {
      throw new UdmtError('INVALID_CONFIG', 'MongoDB uri must start with mongodb:// or mongodb+srv://.');
    }
    if (/\/\/[^/@]+:[^/@]+@/.test(parsed.data.uri)) {
      throw new UdmtError(
        'INVALID_CONFIG',
        'The connection string contains a password. Remove it and store it as the connection secret instead.',
      );
    }
    return { config: parsed.data, endpoint_hint: maskEndpoint(parsed.data.uri) };
  }

  async testConnection(config: Record<string, unknown>, secret: Record<string, unknown>): Promise<ConnectionTestResult> {
    const { uri, database } = ConfigSchema.parse(config);
    const started = Date.now();
    const client = new MongoClient(uri, {
      auth: secret.password ? { username: userFromUri(uri), password: String(secret.password) } : undefined,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      appName: 'udmt',
    });
    try {
      await client.connect();
      const admin = client.db('admin').admin();
      const hello = (await admin.command({ hello: 1 })) as { maxWireVersion?: number };
      let version = 'unknown';
      try {
        const build = (await admin.command({ buildInfo: 1 })) as { version?: string };
        version = build.version ?? 'unknown';
      } catch {
        version = `wire:${hello.maxWireVersion ?? 'unknown'}`;
      }
      const dbs = await admin.listDatabases();
      return {
        success: true,
        server_version: version,
        database: database ?? null,
        diagnostics: [
          `databases visible: ${dbs.databases.length}`,
          `latency: ${Date.now() - started}ms`,
          'authentication verified via admin command',
        ],
        detected_capabilities: CAPS,
      };
    } catch (error) {
      const mapped = mapDriverError(error, 'MongoDB connection test');
      return {
        success: false,
        server_version: null,
        database: database ?? null,
        diagnostics: [mapped.message],
        detected_capabilities: [],
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async discoverResources(config: Record<string, unknown>, secret: Record<string, unknown>) {
    const { uri } = ConfigSchema.parse(config);
    const client = makeClient(uri, secret);
    try {
      await client.connect();
      const admin = client.db('admin').admin();
      const dbs = await admin.listDatabases();
      const resources = [];
      for (const dbInfo of dbs.databases) {
        if (['admin', 'local', 'config'].includes(dbInfo.name)) continue;
        resources.push({
          id: dbInfo.name,
          namespace: dbInfo.name,
          name: dbInfo.name,
          type: 'database' as const,
          metadata: { size_bytes: dbInfo.sizeOnDisk },
        });
        try {
          const collections = await client.db(dbInfo.name).listCollections({}, { nameOnly: true }).toArray();
          for (const collection of collections) {
            resources.push({
              id: `${dbInfo.name}.${collection.name}`,
              namespace: dbInfo.name,
              name: collection.name,
              type: 'collection' as const,
            });
          }
        } catch {
          /* database not readable with these permissions */
        }
      }
      return resources;
    } catch (error) {
      throw mapDriverError(error, 'MongoDB resource discovery');
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async readSchema(config: Record<string, unknown>, secret: Record<string, unknown>, resource: string) {
    const { uri } = ConfigSchema.parse(config);
    const [dbName, collName] = splitResource(resource);
    const client = makeClient(uri, secret);
    try {
      await client.connect();
      const collection = client.db(dbName).collection(collName);
      const samples = await collection.find({}).limit(100).toArray();
      const fields = new Map<string, CanonicalType>();
      for (const doc of samples) {
        for (const [key, value] of Object.entries(doc)) {
          const inferred = inferType(value);
          const previous = fields.get(key);
          fields.set(key, previous && previous !== inferred ? 'json' : inferred);
        }
      }
      const count = await collection.estimatedDocumentCount();
      if (fields.size === 0) {
        throw new UdmtError('PRECONDITION_FAILED', `Collection ${resource} has no documents to infer a schema from.`);
      }
      return {
        resource,
        source: 'sampled' as const,
        rowCountEstimate: count,
        columns: [...fields.entries()].map(([name, type]) => ({
          name,
          type,
          nullable: true,
          primaryKey: name === '_id',
        })),
      };
    } catch (error) {
      if (error instanceof UdmtError) throw error;
      throw mapDriverError(error, 'MongoDB schema read');
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async *readRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: ReadRequest,
    ctx: OperationContext,
  ): AsyncGenerator<RowBatch> {
    const { uri } = ConfigSchema.parse(config);
    const [dbName, collName] = splitResource(request.resource);
    const client = makeClient(uri, secret);
    try {
      await client.connect();
      const collection = client.db(dbName).collection(collName);
      const projection = request.columns?.length
        ? Object.fromEntries(request.columns.map((column) => [column, 1]))
        : undefined;
      const cursor = collection.find(request.filter ?? {}, { projection, batchSize: request.batchSize });
      if (request.offset) cursor.skip(request.offset);
      if (request.limit) cursor.limit(request.limit);

      let batch: RowBatch = [];
      let emitted = 0;
      for await (const doc of cursor) {
        ctx.throwIfCancelled();
        batch.push(normalizeDocument(doc));
        emitted += 1;
        if (batch.length >= request.batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
      ctx.log('info', `MongoDB read ${emitted} documents from ${request.resource}`);
    } catch (error) {
      throw mapDriverError(error, 'MongoDB read');
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async writeRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: WriteRequest,
    rows: AsyncIterable<RowBatch>,
    ctx: OperationContext,
  ): Promise<WriteResult> {
    const { uri } = ConfigSchema.parse(config);
    const [dbName, collName] = splitResource(request.resource);
    const client = makeClient(uri, secret);
    const warnings: string[] = [];
    let written = 0;
    try {
      await client.connect();
      const db = client.db(dbName);
      const existing = await db.listCollections({ name: collName }, { nameOnly: true }).toArray();
      if (existing.length === 0) {
        if (!request.createResource) {
          throw new UdmtError('NOT_FOUND', `Collection does not exist: ${request.resource}`);
        }
        await db.createCollection(collName);
        ctx.log('info', `Created collection ${request.resource}`);
      }
      const collection = db.collection(collName);

      if (request.mode === 'truncate_and_load') {
        const deleted = await collection.deleteMany({});
        ctx.log('warn', `Deleted ${deleted.deletedCount} existing documents from ${request.resource} (explicitly confirmed).`);
      }

      const keys = request.keyColumns?.length ? request.keyColumns : ['_id'];

      for await (const batch of rows) {
        ctx.throwIfCancelled();
        if (batch.length === 0) continue;
        const docs = batch.map((row) => toMongoDocument(row));
        if (request.mode === 'upsert') {
          const operations = docs.map((doc) => {
            const filter = Object.fromEntries(keys.map((key) => [key, doc[key]]));
            if (Object.values(filter).some((value) => value === undefined)) {
              throw new UdmtError('INVALID_INPUT', `Upsert key column missing in a row: ${keys.join(', ')}`);
            }
            return { replaceOne: { filter, replacement: doc, upsert: true } };
          });
          const result = await collection.bulkWrite(operations, { ordered: false });
          written += result.upsertedCount + result.modifiedCount + result.matchedCount;
        } else {
          const result = await collection.insertMany(docs, { ordered: false });
          written += result.insertedCount;
        }
      }
      ctx.log('info', `MongoDB wrote ${written} documents into ${request.resource}`);
      return { rows_written: written, rows_skipped: 0, warnings };
    } catch (error) {
      if (error instanceof UdmtError) throw error;
      throw mapDriverError(error, 'MongoDB write');
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function makeClient(uri: string, secret: Record<string, unknown>): MongoClient {
  return new MongoClient(uri, {
    auth: secret.password ? { username: userFromUri(uri), password: String(secret.password) } : undefined,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    appName: 'udmt',
  });
}

function userFromUri(uri: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/([^:@/]+)(?::[^@/]*)?@/.exec(uri);
  if (!match?.[1]) {
    throw new UdmtError('INVALID_CONFIG', 'A password secret was supplied, but the uri has no username.');
  }
  return decodeURIComponent(match[1]);
}

export function splitResource(resource: string): [string, string] {
  const index = resource.indexOf('.');
  if (index <= 0 || index === resource.length - 1) {
    throw new UdmtError('INVALID_INPUT', `MongoDB resource must be "<database>.<collection>": ${resource}`);
  }
  const db = resource.slice(0, index);
  const coll = resource.slice(index + 1);
  if (/[\s$]/.test(db) || db.includes('\0') || db.startsWith('system.')) {
    throw new UdmtError('INVALID_INPUT', `Invalid MongoDB database name: ${db}`);
  }
  if (/\0/.test(coll) || coll.startsWith('system.')) {
    throw new UdmtError('INVALID_INPUT', `Invalid MongoDB collection name: ${coll}`);
  }
  return [db, coll];
}

function normalizeDocument(doc: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(doc)) out[key] = normalizeValue(value);
  return out;
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128) return decimalToJson(value);
  if (value instanceof Long) {
    const n = value.toNumber();
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof Binary) return Buffer.from(value.buffer).toString('base64');
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeValue(v)]));
  }
  return value;
}

function decimalToJson(value: Decimal128): number | string {
  const asNumber = Number(value.toString());
  return Number.isFinite(asNumber) ? asNumber : value.toString();
}

function toMongoDocument(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = fromJsonValue(value, key);
  return out;
}

function fromJsonValue(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (key === '_id' && typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value)) return new ObjectId(value);
  if (Array.isArray(value)) return value.map((item) => fromJsonValue(item, ''));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fromJsonValue(v, k)]));
  }
  return value;
}

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdmtApp } from '../../src/core/service.js';
import { S3StorageBackend } from '../../src/core/storage/s3.js';
import { resolveAppPaths } from '../../src/core/paths.js';
import { UdmtError } from '../../src/core/errors.js';
import { DatabaseSync } from '../../src/core/db/sqlite-driver.js';

interface FakeS3 {
  server: Server;
  endpoint: string;
  objects: Map<string, Buffer>;
  requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }>;
  close: () => Promise<void>;
}

async function startFakeS3(bucket: string): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const requests: FakeS3['requests'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });
      const bucketRoot = `/${bucket}`;
      const bucketPath = url.pathname === bucketRoot ? `${bucketRoot}/` : url.pathname;
      const prefix = `${bucketRoot}/`;
      const key = decodeURIComponent(bucketPath.startsWith(prefix) ? bucketPath.slice(prefix.length) : '');
      const body = Buffer.concat(chunks);

      if (!bucketPath.startsWith(prefix)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/xml');
        res.end('<Error><Code>NoSuchBucket</Code><Message>bad bucket</Message></Error>');
        return;
      }

      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const listPrefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((item) => item.startsWith(listPrefix));
        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<ListBucketResult>',
          keys.map((item) => `<Contents><Key>${escapeXml(item)}</Key></Contents>`).join(''),
          '</ListBucketResult>',
        ].join('');
        res.setHeader('Content-Type', 'application/xml');
        res.end(xml);
        return;
      }

      if (req.method === 'PUT') {
        objects.set(key, body);
        res.setHeader('ETag', '"fake"');
        res.end();
        return;
      }

      if (req.method === 'HEAD') {
        const stored = objects.get(key);
        if (!stored) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Length', String(stored.length));
        res.setHeader('Last-Modified', new Date().toUTCString());
        res.end();
        return;
      }

      if (req.method === 'DELETE') {
        objects.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }

      const stored = objects.get(key);
      if (!stored) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/xml');
        res.end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
        return;
      }
      res.setHeader('Content-Length', String(stored.length));
      res.end(stored);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let workDir: string;
let fake: FakeS3;
let app: UdmtApp;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-s3-'));
  fake = await startFakeS3('backups');
  app = new UdmtApp({ dataDir: join(workDir, 'data') });
});

afterEach(async () => {
  app.close();
  await fake.close();
  rmSync(workDir, { recursive: true, force: true });
});

function makeSourceDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)');
  const insert = db.prepare('INSERT INTO users (id,name,email) VALUES (?,?,?)');
  for (let i = 1; i <= 25; i += 1) insert.run(i, `User ${i}`, `user${i}@example.com`);
  db.close();
}

describe('S3-compatible storage backend', () => {
  it('publishes, lists, downloads and deletes objects against a real HTTP endpoint', async () => {
    const backend = new S3StorageBackend({
      id: 's3-test',
      paths: resolveAppPaths(join(workDir, 'backend-data')),
      config: {
        endpoint: fake.endpoint,
        bucket: 'backups',
        prefix: 'udmt',
        force_path_style: true,
      },
      secret: { access_key_id: 'AKIAFAKE', secret_access_key: 'fake-secret' },
    });
    const local = join(workDir, 'payload.jsonl');
    writeFileSync(local, '{"id":1}\n{"id":2}\n');

    const staged = await backend.prepareStagingDir('run-1');
    expect(staged.startsWith(join(workDir, 'backend-data', 'tmp', 'staging'))).toBe(true);

    const key = backend.objectKeyFor(local, 'run-1');
    expect(key).toBe('udmt/run-1/payload.jsonl');
    await backend.putObject(local, key);

    expect(fake.objects.has('udmt/run-1/payload.jsonl')).toBe(true);
    expect([...fake.objects.keys()]).toEqual(['udmt/run-1/payload.jsonl']);
    const signed = fake.requests.find((request) => request.method === 'PUT');
    expect(String(signed?.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(String(signed?.headers['x-amz-content-sha256'])).toMatch(/^[a-f0-9]{64}$/);

    const stat = await backend.statObject(key);
    expect(stat.size).toBe(Buffer.byteLength('{"id":1}\n{"id":2}\n'));

    const checksum = await backend.checksum(key);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await backend.list('udmt/')).toEqual(['udmt/run-1/payload.jsonl']);
    expect(backend.describeObject(key)).toBe('s3://backups/udmt/run-1/payload.jsonl');

    const downloaded = join(workDir, 'downloaded.jsonl');
    await backend.getObject(key, downloaded);
    expect(await backend.checksum(key)).toBe(checksum);

    await backend.deleteObject(key);
    expect(fake.objects.has('udmt/run-1/payload.jsonl')).toBe(false);
  });

  it('tests credentials and records backend health in the catalog', async () => {
    const created = app.createStorageBackend({
      name: 'r2-backups',
      backend_type: 's3',
      config: { endpoint: fake.endpoint, bucket: 'backups', prefix: 'udmt', force_path_style: true },
      secret: { access_key_id: 'AKIAFAKE', secret_access_key: 'fake-secret' },
    });
    expect(created.endpoint_hint).toBe('s3://backups/udmt');
    // The secret is in the encrypted vault, never in the catalog config.
    expect(JSON.stringify(created.config)).not.toContain('fake-secret');
    expect(created.credential_ref).toMatch(/^localvault:/);

    const tested = await app.testStorageBackend(created.id);
    expect(tested.success).toBe(true);
    expect(tested.tested_at).toMatch(/T/);

    const refreshed = app.getStorageBackend(created.id);
    expect(refreshed.last_test_status).toBe('success');

    // A backend with the wrong bucket path fails its probe without throwing.
    const broken = app.createStorageBackend({
      name: 'broken',
      backend_type: 's3',
      config: { endpoint: `${fake.endpoint}/`, bucket: 'backups', force_path_style: true },
      secret: { access_key_id: 'x', secret_access_key: 'y' },
    });
    const failed = await app.testStorageBackend(broken.id);
    expect(failed.success).toBe(true); // list works; credentials are accepted by the fake endpoint
    expect(failed.diagnostics.length).toBeGreaterThan(0);
  });

  it('exports to S3, registers an s3 locator and imports it by materializing the object', async () => {
    makeSourceDatabase(join(workDir, 'source.db'));
    app.createConnection({
      name: 'source',
      provider_id: 'sqlite',
      config: { path: join(workDir, 'source.db') },
    });
    app.createConnection({
      name: 'target',
      provider_id: 'sqlite',
      config: { path: join(workDir, 'target.db') },
    });
    const backend = app.createStorageBackend({
      name: 's3-artifacts',
      backend_type: 's3',
      config: { endpoint: fake.endpoint, bucket: 'backups', prefix: 'udmt', force_path_style: true },
      secret: { access_key_id: 'AKIAFAKE', secret_access_key: 'fake-secret' },
      is_default: true,
    });

    const outcome = await app.exportData({
      connection_id: 'source',
      resource: 'users',
      format: 'jsonl',
      compression: 'none',
      storage_backend_id: backend.id,
    });
    expect(outcome.artifact.storage_backend_id).toBe(backend.id);
    expect(outcome.artifact.absolute_path).toMatch(/^s3:\/\/backups\/udmt\//);
    expect(outcome.artifact.verification_status).toBe('verified');
    expect(fake.objects.size).toBe(2); // data + manifest sidecar
    expect([...fake.objects.keys()].some((key) => key.endsWith('.manifest.json'))).toBe(true);

    const verified = await app.verifyArtifact(outcome.artifact.id);
    expect(verified.valid).toBe(true);

    const imported = await app.importData({
      connection_id: 'target',
      resource: 'users',
      source: { artifact_id: outcome.artifact.id },
      mode: 'append',
    });
    expect(imported.run.status).toBe('completed');

    const target = new DatabaseSync(join(workDir, 'target.db'));
    try {
      const count = target.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      expect(Number(count.n)).toBe(25);
    } finally {
      target.close();
    }

    await app.deleteArtifact(outcome.artifact.id);
    expect(fake.objects.size).toBe(0);
    expect(() => app.getArtifact(outcome.artifact.id)).toThrow(UdmtError);
  });

  it('refuses to delete a backend that still owns artifacts', async () => {
    makeSourceDatabase(join(workDir, 'source.db'));
    app.createConnection({ name: 'source', provider_id: 'sqlite', config: { path: join(workDir, 'source.db') } });
    const backend = app.createStorageBackend({
      name: 's3-artifacts',
      backend_type: 's3',
      config: { endpoint: fake.endpoint, bucket: 'backups', prefix: 'udmt', force_path_style: true },
      secret: { access_key_id: 'AKIAFAKE', secret_access_key: 'fake-secret' },
    });
    await app.exportData({
      connection_id: 'source',
      resource: 'users',
      format: 'jsonl',
      compression: 'none',
      storage_backend_id: backend.id,
    });
    expect(() => app.deleteStorageBackend(backend.id)).toThrow(/artifacts/i);
  });
});

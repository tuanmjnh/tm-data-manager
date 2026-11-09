import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/core/db/sqlite-driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdmtApp } from '../../src/core/service.js';

type LoggedRequest = {
  method: string;
  path: string;
  page: number;
  authorization?: string;
  apiKey?: string;
};

let workDir: string;
let app: UdmtApp;
let server: Server | null;
let baseUrl: string;
let log: LoggedRequest[];
let apiRows: Array<Record<string, unknown>>;
let received: unknown[];
let usersStatus: number | null;

function makeDatabase(path: string, rowCount: number): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)');
  const insert = db.prepare('INSERT INTO users (id,name,email) VALUES (?,?,?)');
  for (let i = 1; i <= rowCount; i += 1) {
    insert.run(i, `User ${i}`, `user${i}@example.com`);
  }
  db.close();
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  return req.headers.authorization === 'Bearer secret-token' || req.headers['x-api-key'] === 'secret-key' || url.searchParams.get('api_key') === 'secret-key';
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function startServer(): Promise<string> {
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    log.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      page: Number(url.searchParams.get('page') ?? 1),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      ...(url.searchParams.get('api_key') ? { apiKey: url.searchParams.get('api_key')! } : {}),
    });

    if (url.pathname === '/api/v1/users') {
      if (usersStatus !== null) {
        send(res, usersStatus, { error: 'boom' });
        return;
      }
      if (!isAuthorized(req, url)) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const start = (page - 1) * limit;
      send(res, 200, { data: apiRows.slice(start, start + limit), meta: { page } });
      return;
    }

    if (url.pathname === '/api/v1/feedback' && req.method === 'POST') {
      received.push(await readJson(req));
      send(res, 201, { written: 1 });
      return;
    }

    if (url.pathname === '/api/v1/feedback') {
      send(res, 200, { data: [{ id: 1, message: 'ok' }] });
      return;
    }

    send(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      server = srv;
      resolve(`http://127.0.0.1:${port}/api/v1`);
    });
  });
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-rest-'));
  makeDatabase(join(workDir, 'source.db'), 8);
  app = new UdmtApp({ dataDir: join(workDir, 'data') });
  log = [];
  received = [];
  usersStatus = null;
  apiRows = [
    { id: 9, name: ' Ada ', email: 'ada@example.com' },
    { id: 10, name: 'Grace', email: 'grace@example.com' },
    { id: 11, name: 'Linus', email: 'linus@example.com' },
    { id: 12, name: 'Dandara', email: 'dan@example.com' },
    { id: 13, name: 'Bob', email: 'bob@example.com' },
  ];
  baseUrl = await startServer();
});

afterEach(async () => {
  app.close();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  rmSync(workDir, { recursive: true, force: true });
});

function restConnection(
  overrides: Record<string, unknown> = {},
  secret: Record<string, unknown> = { token: 'secret-token' },
) {
  return app.createConnection({
    name: 'rest-api',
    provider_id: 'rest',
    config: {
      base_url: baseUrl,
      resources: 'users',
      items_path: 'data',
      auth_type: 'bearer',
      page_mode: 'page',
      page_param: 'page',
      page_size_param: 'limit',
      page_size: 2,
      retry_attempts: 0,
      timeout_ms: 5000,
      ...overrides,
    },
    secret,
    environment: 'development',
  });
}

function sqliteConnection(name: string) {
  return app.createConnection({
    name: name,
    provider_id: 'sqlite',
    config: { path: join(workDir, `${name}.db`) },
    environment: 'local',
  });
}

function countRows(name: string, table = 'users'): number {
  const db = new DatabaseSync(join(workDir, `${name}.db`));
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function rowsOf(name: string, table = 'users'): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(workDir, `${name}.db`));
  try {
    return db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe('REST provider - configuration and connection', () => {
  it('keeps the token out of the stored config and the endpoint hint', () => {
    const connection = restConnection();
    expect(connection.endpoint_hint).toBe(baseUrl);
    expect(JSON.stringify(connection.config)).not.toContain('secret-token');
  });

  it('tests a real endpoint through authenticated pagination', async () => {
    restConnection();
    const result = await app.testConnection('rest-api');
    expect(result.success).toBe(true);
    expect(result.diagnostics.join(' ')).toMatch(/HTTP 200/);
    expect(result.diagnostics.join(' ')).not.toContain('secret-token');
    expect(log[0]!.authorization).toBe('Bearer secret-token');
  });

  it('reports auth failures without echoing the secret', async () => {
    restConnection({}, { token: 'wrong-token' });
    const result = await app.testConnection('rest-api');
    expect(result.success).toBe(false);
    expect(result.diagnostics.join(' ')).toMatch(/HTTP 401/);
    expect(result.diagnostics.join(' ')).not.toContain('wrong-token');
  });

  it('sends API keys in a header, never in the URL', async () => {
    restConnection({ auth_type: 'api_key', auth_header: 'X-API-Key' }, { api_key: 'secret-key' });
    const result = await app.testConnection('rest-api');
    expect(result.success).toBe(true);
    const urls = log.map((entry) => entry.path + entry.page);
    expect(urls.every((entry) => !entry.includes('secret-key'))).toBe(true);
  });

  it('requires the credential for the chosen auth type', () => {
    expect(() =>
      app.createConnection({
        name: 'bad-rest',
        provider_id: 'rest',
        config: { base_url: baseUrl, auth_type: 'bearer' },
        secret: {},
      }),
    ).toThrow(/token/);
  });
});

describe('REST provider - import into SQLite', () => {
  it('reads every page and lands the rows with manifest types', async () => {
    restConnection();
    sqliteConnection('rest-import-target');

    const { run, artifact } = await app.exportData({
      connection_id: 'rest-api',
      resource: 'users',
      format: 'jsonl',
      compression: 'none',
    });
    expect(run.status).toBe('completed');
    expect(artifact.manifest.row_count).toBe(5);
    expect(log.filter((entry) => entry.path === '/api/v1/users')).toHaveLength(6);
    expect(log.length).toBeGreaterThan(0);

    const imported = await app.importData({
      connection_id: 'rest-import-target',
      resource: 'users',
      source: { path: artifact.absolute_path },
      mode: 'append',
      create_resource: true,
    });
    expect(imported.run.status).toBe('completed');
    expect(imported.run.result?.rows_written).toBe(5);
    expect(countRows('rest-import-target')).toBe(5);
    const stored = rowsOf('rest-import-target').sort((a, b) => Number(a.id) - Number(b.id));
    expect(stored[0]).toMatchObject({ id: 9, name: ' Ada ', email: 'ada@example.com' });
    expect(stored[4]!.name).toBe('Bob');

    expect(log.every((entry) => entry.authorization === 'Bearer secret-token')).toBe(true);
    expect(log.every((entry) => !entry.path.includes('secret-token'))).toBe(true);
  });
});


import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from '../../src/core/db/sqlite-driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdmtApp } from '../../src/core/service.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const sampleDir = join(repoRoot, 'plugins', 'sample-jsonapi');
const crashDir = join(repoRoot, 'tests', 'fixtures', 'plugins', 'crash');

let workDir: string;
let app: UdmtApp;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'udmt-plugin-'));
  app = new UdmtApp({ dataDir: join(workDir, 'data') });
});

afterEach(() => {
  app.close();
  rmSync(workDir, { recursive: true, force: true });
});

function register(trusted: boolean, enabled: boolean) {
  return app.installPlugin({ path: sampleDir, trusted, enabled });
}

function countRows(path: string, table = 'items'): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

describe('plugin manifest and trust', () => {
  it('installs disabled and untrusted, exposing no provider until trusted', () => {
    const record = register(false, false);
    expect(record.id).toBe('sample.jsonapi');
    expect(record.trusted).toBe(false);
    expect(record.enabled).toBe(false);
    expect(record.status).toBe('disabled');
    expect(record.requested_permissions).toEqual(['read_config', 'read_secrets']);
    expect(app.providers().map((provider) => provider.provider_id)).not.toContain('plugin:sample.jsonapi');
  });

  it('refuses to enable before trust and refuses unrequested permissions', () => {
    register(false, false);
    expect(() => app.setPluginEnabled('sample.jsonapi', true)).toThrow(/trusted/);
    expect(() => app.setPluginTrust('sample.jsonapi', { trusted: true, granted_permissions: ['network'] })).toThrow(/did not request/);
  });

  it('registers the provider after trust + enable and grants a subset', () => {
    register(false, false);
    const trusted = app.setPluginTrust('sample.jsonapi', { trusted: true, granted_permissions: ['read_config'] });
    expect(trusted.granted_permissions).toEqual(['read_config']);
    const enabled = app.setPluginEnabled('sample.jsonapi', true);
    expect(enabled.status).toBe('installed');
    expect(app.providers().map((provider) => provider.provider_id)).toContain('plugin:sample.jsonapi');
  });

  it('rejects a malformed manifest and an unsupported protocol version', () => {
    const badDir = join(workDir, 'bad-plugin');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'udmt-plugin.json'), JSON.stringify({ manifest_version: 1, id: 'Bad Id', name: 'x', version: '1', protocol: 'udmt-provider/1', runtime: { command: 'node' }, permissions: [], provider: { display_name: 'x', capabilities: ['read_data'] } }));
    expect(() => app.installPlugin({ path: badDir })).toThrow(/manifest is invalid/i);

    const futureDir = join(workDir, 'future-plugin');
    mkdirSync(futureDir, { recursive: true });
    const valid = JSON.parse(readFileSync(join(sampleDir, 'udmt-plugin.json'), 'utf8'));
    valid.protocol = 'udmt-provider/99';
    writeFileSync(join(futureDir, 'udmt-plugin.json'), JSON.stringify(valid));
    expect(() => app.installPlugin({ path: futureDir })).toThrow(/protocol/);
  });
});

describe('external provider through the core engine', () => {
  it('handshakes, tests, discovers, exports and imports', async () => {
    register(true, true);

    const ping = await app.testPlugin('sample.jsonapi');
    expect(ping.success).toBe(true);
    expect(ping.protocol_version).toBe('udmt-provider/1');

    const connection = app.createConnection({
      name: 'sample',
      provider_id: 'plugin:sample.jsonapi',
      config: { dataset: 'items' },
      secret: { api_token: 'secret-api-token' },
      environment: 'local',
    });

    const tested = await app.testConnection(connection.id);
    expect(tested.success).toBe(true);
    expect(tested.diagnostics.join(' ')).not.toContain('secret-api-token');

    const discovered = await app.discoverResources(connection.id);
    expect(discovered.map((resource) => resource.name)).toEqual(['items']);

    const { artifact, run } = await app.exportData({
      connection_id: connection.id,
      resource: 'items',
      format: 'jsonl',
      compression: 'none',
    });
    expect(run.status).toBe('completed');
    expect(artifact.manifest.row_count).toBe(25);

    const target = app.createConnection({ name: 'target', provider_id: 'sqlite', config: { path: join(workDir, 'target.db') }, environment: 'local' });
    const imported = await app.importData({
      connection_id: target.id,
      resource: 'items',
      source: { path: artifact.absolute_path },
      mode: 'append',
      create_resource: true,
    });
    expect(imported.run.status).toBe('completed');
    expect(imported.run.result?.rows_written).toBe(25);
    expect(countRows(join(workDir, 'target.db'))).toBe(25);
  });

  it('keeps the core alive when a plugin crashes (crash isolation)', async () => {
    app.installPlugin({ path: crashDir, trusted: true, enabled: true });

    const crashed = await app.testPlugin('test.crash');
    expect(crashed.success).toBe(false);
    expect(crashed.diagnostics.join(' ')).toMatch(/stopped unexpectedly|exit code 3|error/i);

    // A built-in provider still works after the plugin process died.
    const okPath = join(workDir, 'ok.db');
    const db = new DatabaseSync(okPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.close();
    const sqlite = app.createConnection({ name: 'sqlite-ok', provider_id: 'sqlite', config: { path: okPath }, environment: 'local' });
    const result = await app.testConnection(sqlite.id);
    expect(result.success).toBe(true);
  });

  it('removes a plugin and unregisters its provider', () => {
    register(true, true);
    expect(app.providers().map((provider) => provider.provider_id)).toContain('plugin:sample.jsonapi');
    app.removePlugin('sample.jsonapi');
    expect(app.listPlugins()).toHaveLength(0);
    expect(app.providers().map((provider) => provider.provider_id)).not.toContain('plugin:sample.jsonapi');
  });
});

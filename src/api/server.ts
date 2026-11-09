import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UdmtError, toUdmtError } from '../core/errors.js';
import type { UdmtApp } from '../core/service.js';
import { nowIso } from '../core/utils.js';
import type { ExportRequest, ImportRequest, PluginPermission, SyncRequest } from '../core/types.js';

export interface ApiServerHandle {
  url: string;
  uiUrl: string | null;
  close: () => Promise<void>;
  server: Server;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Local HTTP facade for the Nuxt GUI. Binds loopback only and rejects
 * cross-origin mutations (roadmap 16.1: one facade, no business logic in Vue).
 */
export async function startApiServer(
  app: UdmtApp,
  options: { port: number; host: string },
): Promise<ApiServerHandle> {
  const server = createServer((req, res) => {
    void handle(app, req, res).catch((error) => {
      const udmt = toUdmtError(error);
      if (!res.headersSent) {
        sendJson(res, udmt.code === 'NOT_FOUND' ? 404 : udmt.code === 'INVALID_INPUT' ? 400 : 500, { error: udmt.toJSON() });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolvePromise());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host}:${port}`;
  const uiDir = findUiRoot();
  const uiUrl = uiDir ? `${url}/` : null;

  return {
    url,
    uiUrl,
    server,
    close: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

async function handle(app: UdmtApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (process.env.UDMT_ACCESS_LOG) {
    // Opt-in request log; used to prove which client loaded the GUI when a
    // desktop window comes up empty.
    process.stderr.write(
      `${new Date().toISOString()} ${method} ${req.url ?? '/'} ua="${String(req.headers['user-agent'] ?? '').slice(0, 40)}"\n`,
    );
  }
  const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = parsed.pathname.replace(/\/+$/, '') || '/';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Loopback-only service: block DNS-rebinding style Host headers.
  const host = (req.headers.host ?? '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Host not allowed.' } });
  }
  const origin = req.headers.origin;
  const originAllowed = Boolean(origin && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin));
  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (method === 'OPTIONS') {
    if (!originAllowed) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Origin not allowed.' } });
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use the API.' } });
    }
    return serveStatic(res, path);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    if (origin && !originAllowed) {
      return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected.' } });
    }
    if (req.headers['content-type'] && !String(req.headers['content-type']).includes('application/json')) {
      return sendJson(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected application/json.' } });
    }
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (path === '/api/health' && method === 'GET') {
      const status = app.workerStatus();
      return sendJson(res, 200, {
        ok: true,
        app: 'udmt',
        time: nowIso(),
        version: app.doctor().app_version,
        worker: { running: status.running, heartbeat_age_seconds: status.heartbeat_age_seconds },
        counts: app.store.counts(),
      });
    }

    if (path === '/api/doctor' && method === 'GET') {
      return sendJson(res, 200, app.doctor());
    }

    if (path === '/api/providers' && method === 'GET') {
      return sendJson(res, 200, app.providers());
    }

    if (path === '/api/connections' && method === 'GET') {
      return sendJson(res, 200, app.listConnections());
    }

    if (path === '/api/connections' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, app.createConnection(body as never));
    }

    const connectionMatch = /^\/api\/connections\/([^/]+)$/.exec(path);
    if (connectionMatch && method === 'GET') {
      return sendJson(res, 200, app.getConnection(decodeURIComponent(connectionMatch[1]!)));
    }
    if (connectionMatch && method === 'PATCH') {
      const body = await readJson(req);
      return sendJson(res, 200, app.updateConnection(decodeURIComponent(connectionMatch[1]!), body as never));
    }
    if (connectionMatch && method === 'DELETE') {
      app.deleteConnection(decodeURIComponent(connectionMatch[1]!));
      return sendJson(res, 200, { deleted: true });
    }

    const testMatch = /^\/api\/connections\/([^/]+)\/test$/.exec(path);
    if (testMatch && method === 'POST') {
      return sendJson(res, 200, await app.testConnection(decodeURIComponent(testMatch[1]!)));
    }

    const resourcesMatch = /^\/api\/connections\/([^/]+)\/resources$/.exec(path);
    if (resourcesMatch && method === 'GET') {
      return sendJson(res, 200, await app.discoverResources(decodeURIComponent(resourcesMatch[1]!)));
    }

    const schemaMatch = /^\/api\/connections\/([^/]+)\/schema$/.exec(path);
    if (schemaMatch && method === 'GET') {
      const resource = parsed.searchParams.get('resource');
      if (!resource) throw new UdmtError('INVALID_INPUT', 'resource query parameter is required.');
      return sendJson(res, 200, await app.resourceSchema(decodeURIComponent(schemaMatch[1]!), resource));
    }

    const rowsMatch = /^\/api\/connections\/([^/]+)\/rows$/.exec(path);
    if (rowsMatch && method === 'GET') {
      const resource = parsed.searchParams.get('resource');
      if (!resource) throw new UdmtError('INVALID_INPUT', 'resource query parameter is required.');
      const limit = parsed.searchParams.get('limit');
      return sendJson(
        res,
        200,
        await app.previewRows(decodeURIComponent(rowsMatch[1]!), resource, {
          ...(limit ? { limit: Number(limit) } : {}),
        }),
      );
    }

    if (path === '/api/export' && method === 'POST') {
      const body = (await readJson(req)) as unknown as ExportRequest;
      const started = app.startExport(body);
      return sendJson(res, 202, started.run);
    }

    if (path === '/api/import' && method === 'POST') {
      const body = (await readJson(req)) as unknown as ImportRequest;
      let started;
      try {
        started = app.startImport(body);
      } catch (error) {
        const udmt = toUdmtError(error);
        return sendJson(res, udmt.code === 'CONFIRMATION_REQUIRED' ? 409 : 400, { error: udmt.toJSON() });
      }
      return sendJson(res, 202, started.run);
    }

    if (path === '/api/runs' && method === 'GET') {
      return sendJson(res, 200, app.listRuns({
        limit: Number(parsed.searchParams.get('limit') ?? 50),
        ...(parsed.searchParams.get('status') ? { status: parsed.searchParams.get('status')! } : {}),
        ...(parsed.searchParams.get('type') ? { operation_type: parsed.searchParams.get('type')! } : {}),
      }));
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (runMatch && method === 'GET') {
      const run = app.getRun(decodeURIComponent(runMatch[1]!));
      return sendJson(res, 200, run);
    }

    const logsMatch = /^\/api\/runs\/([^/]+)\/logs$/.exec(path);
    if (logsMatch && method === 'GET') {
      return sendJson(res, 200, app.runLogs(decodeURIComponent(logsMatch[1]!), {
        limit: Number(parsed.searchParams.get('limit') ?? 500),
        afterSequence: Number(parsed.searchParams.get('after') ?? 0),
      }));
    }

    const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch && method === 'POST') {
      return sendJson(res, 200, app.cancelRun(app.getRun(decodeURIComponent(cancelMatch[1]!)).id));
    }

    const runErrorsMatch = /^\/api\/runs\/([^/]+)\/errors$/.exec(path);
    if (runErrorsMatch && method === 'GET') {
      return sendJson(res, 200, app.syncErrors(decodeURIComponent(runErrorsMatch[1]!), Number(parsed.searchParams.get('limit') ?? 200)));
    }

    if (path === '/api/sync/pipelines' && method === 'GET') {
      return sendJson(res, 200, app.listSyncPipelines());
    }
    if (path === '/api/sync/pipelines' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, app.createSyncPipeline(body as never));
    }

    const syncPipelineMatch = /^\/api\/sync\/pipelines\/([^/]+)$/.exec(path);
    if (syncPipelineMatch && method === 'GET') {
      const pipeline = app.getSyncPipeline(decodeURIComponent(syncPipelineMatch[1]!));
      return sendJson(res, 200, { pipeline, state: app.syncState(pipeline.id) });
    }
    if (syncPipelineMatch && method === 'PATCH') {
      const body = await readJson(req);
      return sendJson(res, 200, app.updateSyncPipeline(decodeURIComponent(syncPipelineMatch[1]!), body as never));
    }
    if (syncPipelineMatch && method === 'DELETE') {
      app.deleteSyncPipeline(decodeURIComponent(syncPipelineMatch[1]!));
      return sendJson(res, 200, { deleted: true });
    }

    const syncRunMatch = /^\/api\/sync\/pipelines\/([^/]+)\/run$/.exec(path);
    if (syncRunMatch && method === 'POST') {
      const body = (await readJson(req)) as Omit<SyncRequest, 'pipeline_id'>;
      const pipeline = app.getSyncPipeline(decodeURIComponent(syncRunMatch[1]!));
      const started = app.engine.startSync({ ...body, pipeline_id: pipeline.id });
      void started.done;
      return sendJson(res, 202, started.run);
    }

    const syncValidateMatch = /^\/api\/sync\/pipelines\/([^/]+)\/validate$/.exec(path);
    if (syncValidateMatch && method === 'POST') {
      const body = (await readJson(req)) as { limit?: number; batch_size?: number };
      const result = await app.validateSyncPipeline(decodeURIComponent(syncValidateMatch[1]!), body ?? {});
      return sendJson(res, 200, result.run);
    }

    const syncStateMatch = /^\/api\/sync\/pipelines\/([^/]+)\/state$/.exec(path);
    if (syncStateMatch && method === 'GET') {
      return sendJson(res, 200, app.syncState(decodeURIComponent(syncStateMatch[1]!)));
    }

    if (path === '/api/plugins' && method === 'GET') {
      return sendJson(res, 200, app.listPlugins());
    }
    if (path === '/api/plugins' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, app.installPlugin(body as never));
    }

    const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(path);
    if (pluginMatch && method === 'GET') {
      const id = decodeURIComponent(pluginMatch[1]!);
      return sendJson(res, 200, { plugin: app.getPlugin(id), diagnostics: app.pluginDiagnostics(id) });
    }
    if (pluginMatch && method === 'PATCH') {
      const id = decodeURIComponent(pluginMatch[1]!);
      const body = (await readJson(req)) as {
        enabled?: boolean;
        trusted?: boolean;
        granted_permissions?: PluginPermission[];
      };
      let record = app.getPlugin(id);
      if (body.trusted !== undefined) record = app.setPluginTrust(id, { trusted: body.trusted, ...(body.granted_permissions ? { granted_permissions: body.granted_permissions } : {}) });
      if (body.enabled !== undefined) record = app.setPluginEnabled(id, body.enabled);
      return sendJson(res, 200, record);
    }
    if (pluginMatch && method === 'DELETE') {
      app.removePlugin(decodeURIComponent(pluginMatch[1]!));
      return sendJson(res, 200, { deleted: true });
    }

    const pluginUpdateMatch = /^\/api\/plugins\/([^/]+)\/update$/.exec(path);
    if (pluginUpdateMatch && method === 'POST') {
      return sendJson(res, 200, app.updatePlugin(decodeURIComponent(pluginUpdateMatch[1]!)));
    }
    const pluginTestMatch = /^\/api\/plugins\/([^/]+)\/test$/.exec(path);
    if (pluginTestMatch && method === 'POST') {
      return sendJson(res, 200, await app.testPlugin(decodeURIComponent(pluginTestMatch[1]!)));
    }

    if (path === '/api/artifacts' && method === 'GET') {
      return sendJson(res, 200, app.listArtifacts({ limit: Number(parsed.searchParams.get('limit') ?? 100) }));
    }

    const artifactMatch = /^\/api\/artifacts\/([^/]+)$/.exec(path);
    if (artifactMatch && method === 'GET') {
      return sendJson(res, 200, app.getArtifact(decodeURIComponent(artifactMatch[1]!)));
    }
    if (artifactMatch && method === 'DELETE') {
      await app.deleteArtifact(decodeURIComponent(artifactMatch[1]!));
      return sendJson(res, 200, { deleted: true });
    }

    const verifyMatch = /^\/api\/artifacts\/([^/]+)\/verify$/.exec(path);
    if (verifyMatch && method === 'POST') {
      const result = await app.verifyArtifact(decodeURIComponent(verifyMatch[1]!));
      return sendJson(res, result.valid ? 200 : 409, {
        valid: result.valid,
        run: result.run,
        artifact: result.artifact,
      });
    }

    const pinMatch = /^\/api\/artifacts\/([^/]+)\/pin$/.exec(path);
    if (pinMatch && method === 'POST') {
      const body = (await readJson(req)) as { pinned?: boolean };
      return sendJson(res, 200, app.pinArtifact(decodeURIComponent(pinMatch[1]!), body.pinned !== false));
    }

    if (path === '/api/artifacts/prune' && method === 'POST') {
      const body = (await readJson(req)) as { older_than_days: number; keep_last?: number; dry_run?: boolean };
      return sendJson(res, 200, await app.cleanupArtifacts(body));
    }

    if (path === '/api/jobs' && method === 'GET') {
      return sendJson(res, 200, app.listJobs());
    }
    if (path === '/api/jobs/export' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, app.createExportJob(body as never));
    }
    if (path === '/api/jobs/import' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, app.createImportJob(body as never));
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (jobMatch && method === 'DELETE') {
      app.deleteJob(decodeURIComponent(jobMatch[1]!));
      return sendJson(res, 200, { deleted: true });
    }

    if (path === '/api/schedules' && method === 'GET') {
      return sendJson(res, 200, app.listSchedules());
    }

    const scheduleMatch = /^\/api\/schedules\/([^/]+)\/(enable|disable)$/.exec(path);
    if (scheduleMatch && method === 'POST') {
      return sendJson(res, 200, app.setScheduleEnabled(decodeURIComponent(scheduleMatch[1]!), scheduleMatch[2] === 'enable'));
    }

    const scheduleDeleteMatch = /^\/api\/schedules\/([^/]+)$/.exec(path);
    if (scheduleDeleteMatch && method === 'DELETE') {
      app.deleteSchedule(decodeURIComponent(scheduleDeleteMatch[1]!));
      return sendJson(res, 200, { deleted: true });
    }

    if (path === '/api/worker' && method === 'GET') {
      return sendJson(res, 200, app.workerStatus());
    }

    if (path === '/api/storage' && method === 'GET') {
      return sendJson(res, 200, { backends: app.listStorageBackends(), root: app.paths.artifactsDir });
    }

    if (path === '/api/storage/backends' && method === 'GET') {
      return sendJson(res, 200, app.listStorageBackends());
    }
    if (path === '/api/storage/backends' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, app.createStorageBackend(body as never));
    }

    const storageMatch = /^\/api\/storage\/backends\/([^/]+)$/.exec(path);
    if (storageMatch && method === 'GET') {
      return sendJson(res, 200, app.getStorageBackend(decodeURIComponent(storageMatch[1]!)));
    }
    if (storageMatch && method === 'PATCH') {
      const body = await readJson(req);
      return sendJson(res, 200, app.updateStorageBackend(decodeURIComponent(storageMatch[1]!), body as never));
    }
    if (storageMatch && method === 'DELETE') {
      app.deleteStorageBackend(decodeURIComponent(storageMatch[1]!));
      return sendJson(res, 200, { deleted: true });
    }

    const storageTestMatch = /^\/api\/storage\/backends\/([^/]+)\/test$/.exec(path);
    if (storageTestMatch && method === 'POST') {
      return sendJson(res, 200, await app.testStorageBackend(decodeURIComponent(storageTestMatch[1]!)));
    }

    const storageDefaultMatch = /^\/api\/storage\/backends\/([^/]+)\/default$/.exec(path);
    if (storageDefaultMatch && method === 'POST') {
      return sendJson(res, 200, app.setDefaultStorageBackend(decodeURIComponent(storageDefaultMatch[1]!)));
    }

    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Unknown endpoint: ${method} ${path}` } });
  } catch (error) {
    const udmt = toUdmtError(error);
    const status =
      udmt.code === 'NOT_FOUND'
        ? 404
        : udmt.code === 'CONFIRMATION_REQUIRED'
          ? 409
          : ['INVALID_INPUT', 'INVALID_CONFIG', 'VALIDATION_FAILED', 'CONFIRMATION_REQUIRED', 'PATH_UNSAFE'].includes(udmt.code)
            ? 400
            : udmt.code === 'CAPABILITY_UNSUPPORTED'
              ? 422
              : 500;
    return sendJson(res, status, { error: udmt.toJSON() });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new UdmtError('INVALID_INPUT', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new UdmtError('INVALID_INPUT', 'Request body is not valid JSON.');
  }
}

function findUiRoot(): string | null {
  // Works from the project root, from a linked install, and from dist/ or src/.
  // `UDMT_UI_DIR` is set by the desktop shell, which ships the SPA next to the runtime.
  const fromModule = (() => {
    try {
      return fileURLToPath(new URL('../../app/.output/public', import.meta.url));
    } catch {
      // Bundled CommonJS build: no import.meta.url. Callers use UDMT_UI_DIR instead.
      return null;
    }
  })();
  const candidates = [
    ...(process.env.UDMT_UI_DIR ? [resolve(process.env.UDMT_UI_DIR)] : []),
    resolve(process.cwd(), '.output/public'),
    resolve(process.cwd(), 'app/.output/public'),
    ...(fromModule ? [fromModule] : []),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

function serveStatic(res: ServerResponse, path: string): void {
  const root = findUiRoot();
  if (!root) {
    return sendJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: 'GUI build not found. Run `pnpm run build:gui`, or use `pnpm run dev:gui` during development.',
      },
    });
  }
  const requested = path === '/' ? '/index.html' : path;
  const file = resolve(root, `.${normalize(requested)}`);
  if (!file.startsWith(root)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Path not allowed.' } });
  const target = existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html');
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extname(target)] ?? 'application/octet-stream');
  createReadStream(target).pipe(res);
}

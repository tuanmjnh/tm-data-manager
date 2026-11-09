import { z } from 'zod';
import { UdmtError } from '../errors.js';
import type { CapabilityId, ProviderDescriptor, ResourceDescriptor, ResourceSchema, Row, RowBatch } from '../types.js';
import type {
  ConnectionTestResult,
  DataProvider,
  OperationContext,
  ReadRequest,
  ValidatedConnectionConfig,
  WriteRequest,
  WriteResult,
} from './contract.js';
import { caps, sampleColumns } from './contract.js';

const ConfigSchema = z.object({
  base_url: z.string().min(1),
  resources: z.string().optional(),
  items_path: z.string().default('data'),
  headers: z.union([z.string(), z.record(z.string())]).optional(),
  auth_type: z.enum(['none', 'bearer', 'api_key', 'basic']).default('none'),
  auth_header: z.string().default('X-API-Key'),
  auth_query_param: z.string().optional(),
  username: z.string().optional(),
  page_mode: z.enum(['none', 'page', 'offset', 'cursor', 'link']).default('page'),
  page_param: z.string().default('page'),
  cursor_param: z.string().default('cursor'),
  page_size_param: z.string().default('limit'),
  page_size: z.coerce.number().int().min(1).max(10_000).default(100),
  next_path: z.string().default('next'),
  timeout_ms: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  rate_limit_per_minute: z.coerce.number().int().min(0).max(60_000).default(0),
  retry_attempts: z.coerce.number().int().min(0).max(10).default(2),
  retry_backoff_ms: z.coerce.number().int().min(0).max(30_000).default(500),
  write_method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  write_path: z.string().optional(),
  write_batch: z.boolean().default(true),
});

type RestConfig = z.infer<typeof ConfigSchema>;

const CAPS: CapabilityId[] = [
  'test_connection',
  'discover_resources',
  'read_data',
  'write_data',
  'schema_read',
  'bulk_write',
];

const SECRET_FIELDS = ['token', 'api_key', 'password'];

export class RestProvider implements DataProvider {
  readonly providerId = 'rest';

  descriptor(): ProviderDescriptor {
    return {
      provider_id: 'rest',
      display_name: 'REST API (JSON)',
      version: '1.0.0',
      built_in: true,
      capabilities: caps(...CAPS),
      service_profiles: [],
      secret_fields: SECRET_FIELDS,
      config_fields: [
        {
          name: 'base_url',
          label: 'Base URL',
          type: 'text',
          required: true,
          placeholder: 'https://api.example.com/v1',
          help: 'All resource paths resolve against this origin. Redirects to another origin are rejected.',
        },
        {
          name: 'resources',
          label: 'Resources',
          type: 'text',
          required: false,
          placeholder: 'users, orders',
          help: 'Comma-separated endpoint paths. A resource can also be typed directly in operations.',
        },
        {
          name: 'items_path',
          label: 'Items JSON path',
          type: 'text',
          required: false,
          default: 'data',
          help: 'Dot path to the row array in the response, e.g. data.items. Leave empty for a root array.',
        },
        {
          name: 'headers',
          label: 'Extra headers (JSON)',
          type: 'text',
          required: false,
          placeholder: '{"X-Tenant":"acme"}',
          help: 'Optional non-secret headers. Authentication headers are configured below.',
        },
        {
          name: 'auth_type',
          label: 'Authentication',
          type: 'select',
          required: false,
          default: 'none',
          options: [
            { value: 'none', label: 'None' },
            { value: 'bearer', label: 'Bearer token' },
            { value: 'api_key', label: 'API key header/query' },
            { value: 'basic', label: 'Basic auth' },
          ],
        },
        {
          name: 'auth_header',
          label: 'API key header',
          type: 'text',
          required: false,
          default: 'X-API-Key',
          help: 'Used when authentication is API key and no query parameter is set.',
        },
        {
          name: 'auth_query_param',
          label: 'API key query parameter',
          type: 'text',
          required: false,
          placeholder: 'api_key',
          help: 'Leave empty to send the key in a header. Never logged by the provider.',
        },
        { name: 'username', label: 'Basic auth username', type: 'text', required: false },
        {
          name: 'token',
          label: 'Bearer token',
          type: 'password',
          required: false,
          help: 'Stored in the encrypted vault, never in the metadata database.',
        },
        { name: 'api_key', label: 'API key', type: 'password', required: false },
        { name: 'password', label: 'Basic auth password', type: 'password', required: false },
        {
          name: 'page_mode',
          label: 'Pagination',
          type: 'select',
          required: false,
          default: 'page',
          options: [
            { value: 'none', label: 'Single response' },
            { value: 'page', label: 'Page number' },
            { value: 'offset', label: 'Offset' },
            { value: 'cursor', label: 'Cursor token' },
            { value: 'link', label: 'Link header' },
          ],
        },
        { name: 'page_param', label: 'Page parameter', type: 'text', required: false, default: 'page' },
        { name: 'cursor_param', label: 'Cursor parameter', type: 'text', required: false, default: 'cursor' },
        { name: 'page_size_param', label: 'Page size parameter', type: 'text', required: false, default: 'limit' },
        { name: 'page_size', label: 'Page size', type: 'number', required: false, default: 100 },
        {
          name: 'next_path',
          label: 'Next cursor JSON path',
          type: 'text',
          required: false,
          default: 'next',
          help: 'Used by cursor pagination to read the next token from the response body.',
        },
        { name: 'timeout_ms', label: 'Request timeout (ms)', type: 'number', required: false, default: 30_000 },
        {
          name: 'rate_limit_per_minute',
          label: 'Rate limit (requests/minute)',
          type: 'number',
          required: false,
          default: 0,
          help: '0 disables client-side throttling.',
        },
        { name: 'retry_attempts', label: 'Retry attempts', type: 'number', required: false, default: 2 },
        { name: 'retry_backoff_ms', label: 'Retry backoff (ms)', type: 'number', required: false, default: 500 },
        {
          name: 'write_method',
          label: 'Write method',
          type: 'select',
          required: false,
          default: 'POST',
          options: [
            { value: 'POST', label: 'POST' },
            { value: 'PUT', label: 'PUT' },
            { value: 'PATCH', label: 'PATCH' },
          ],
        },
        { name: 'write_path', label: 'Write endpoint override', type: 'text', required: false },
        { name: 'write_batch', label: 'Send batches as an array', type: 'boolean', required: false, default: true },
      ],
    };
  }

  validateConfig(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
  ): ValidatedConnectionConfig {
    const parsed = ConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new UdmtError(
        'INVALID_CONFIG',
        `REST config is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    }
    const normalized = normalizeConfig(parsed.data);
    const auth = normalized.auth_type ?? 'none';
    if (auth === 'bearer' && !secret.token) {
      throw new UdmtError('INVALID_CONFIG', 'REST bearer authentication requires a token.');
    }
    if (auth === 'api_key' && !secret.api_key) {
      throw new UdmtError('INVALID_CONFIG', 'REST API key authentication requires an api_key.');
    }
    if (auth === 'basic' && (!normalized.username || !secret.password)) {
      throw new UdmtError('INVALID_CONFIG', 'REST basic authentication requires a username and password.');
    }
    return {
      config: normalized,
      endpoint_hint: safeBase(normalized.base_url),
    };
  }

  async testConnection(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    ctx: OperationContext,
  ): Promise<ConnectionTestResult> {
    const normalized = ConfigSchema.parse(config);
    const started = Date.now();
    const resource = firstResource(normalized);
    try {
      const response = await this.request(normalized, secret, resource ?? '', ctx, undefined, {
        method: 'GET',
        pageSize: 1,
      });
      const diagnostics = [`HTTP ${response.status}`, `latency: ${Date.now() - started}ms`];
      if (normalized.auth_type && normalized.auth_type !== 'none') {
        diagnostics.push(`auth: ${normalized.auth_type}`);
      }
      return {
        success: true,
        server_version: null,
        database: safeBase(normalized.base_url),
        latency_ms: Date.now() - started,
        diagnostics,
        detected_capabilities: CAPS,
      };
    } catch (error) {
      return {
        success: false,
        server_version: null,
        database: safeBase(normalized.base_url),
        diagnostics: [sanitize((error as Error).message)],
        detected_capabilities: [],
      };
    }
  }

  async discoverResources(
    config: Record<string, unknown>,
  ): Promise<ResourceDescriptor[]> {
    const normalized = ConfigSchema.parse(config);
    const resources = splitResources(normalized.resources);
    return resources.map((resource) => ({
      id: resource,
      namespace: safeBase(normalized.base_url),
      name: resource,
      type: 'collection',
      metadata: { path: buildUrl(normalized, resource).toString() },
    }));
  }

  async readSchema(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    resource: string,
    ctx: OperationContext,
  ): Promise<ResourceSchema> {
    const normalized = ConfigSchema.parse(config);
    const rows: Row[] = [];
    for await (const batch of this.readRows(
      normalized,
      secret,
      { resource, batchSize: 5, limit: 5 },
      ctx,
    )) {
      rows.push(...batch);
      if (rows.length >= 5) break;
    }
    return { resource, columns: sampleColumns(rows), rowCountEstimate: null, source: 'sampled' };
  }

  async *readRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: ReadRequest,
    ctx: OperationContext,
  ): AsyncGenerator<RowBatch, void, unknown> {
    const normalized = ConfigSchema.parse(config);
    const pageSize = normalized.page_size ?? 100;
    const pageMode = normalized.page_mode ?? 'page';
    const limiter = new RateLimiter(normalized.rate_limit_per_minute ?? 0);
    const wanted = request.columns && request.columns.length > 0 ? new Set(request.columns) : null;
    let page = 1;
    let offset = 0;
    let cursor: string | null = null;
    let nextUrl: URL | null = null;
    let buffer: RowBatch = [];
    let emitted = 0;

    while (true) {
      ctx.throwIfCancelled();
      const url = nextUrl ?? buildUrl(normalized, request.resource, { page, offset, cursor, pageSize });
      const response = await this.request(normalized, secret, request.resource, ctx, url, { method: 'GET', limiter });
      const items = extractItems(response.body, normalized.items_path);
      if (!Array.isArray(items)) {
        throw new UdmtError(
          'VALIDATION_FAILED',
          `REST response has no row array at "${normalized.items_path || '(root)'}" for ${request.resource}.`,
        );
      }
      if (items.length === 0) break;
      for (const item of items) {
        if (request.limit !== undefined && emitted >= request.limit) break;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new UdmtError('VALIDATION_FAILED', 'REST rows must be JSON objects.');
        }
        const source = item as Row;
        const row: Row = {};
        for (const [key, value] of Object.entries(source)) {
          if (wanted && !wanted.has(key)) continue;
          row[key] = value;
        }
        buffer.push(row);
        emitted += 1;
        if (buffer.length >= request.batchSize) {
          ctx.progress({ metrics: { rows_read: emitted } });
          yield buffer;
          buffer = [];
        }
      }
      if (request.limit !== undefined && emitted >= request.limit) break;
      if (pageMode === 'none') break;

      if (pageMode === 'page') {
        if (items.length < pageSize) break;
        page += 1;
      } else if (pageMode === 'offset') {
        if (items.length < pageSize) break;
        offset += pageSize;
      } else if (pageMode === 'cursor') {
        const next = readPath(response.body, normalized.next_path || 'next');
        if (next === null || next === undefined || next === '') break;
        cursor = String(next);
      } else if (pageMode === 'link') {
        const link = parseNextLink(response.headers.get('link'));
        if (!link) break;
        nextUrl = ensureSameOrigin(normalized, link);
      }
      if (request.limit !== undefined && emitted >= request.limit) break;
    }
    if (buffer.length > 0) yield buffer;
  }

  async writeRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: WriteRequest,
    rows: AsyncIterable<RowBatch>,
    ctx: OperationContext,
  ): Promise<WriteResult> {
    const normalized = ConfigSchema.parse(config);
    if (request.mode !== 'append') {
      throw new UdmtError(
        'CAPABILITY_UNSUPPORTED',
        'REST targets support append writes only; upsert/truncate must be implemented by the API.',
      );
    }
    const path = normalized.write_path || request.resource;
    const method = normalized.write_method ?? 'POST';
    const batchMode = normalized.write_batch ?? true;
    const limiter = new RateLimiter(normalized.rate_limit_per_minute ?? 0);
    let written = 0;
    for await (const batch of rows) {
      if (batchMode) {
        await this.request(normalized, secret, path, ctx, undefined, {
          method,
          body: batch,
          limiter,
        });
        written += batch.length;
      } else {
        for (const row of batch) {
          await this.request(normalized, secret, path, ctx, undefined, { method, body: row, limiter });
          written += 1;
        }
      }
    }
    return { rows_written: written, rows_skipped: 0, warnings: [] };
  }

  private async request(
    config: RestConfig,
    secret: Record<string, unknown>,
    resource: string,
    ctx: OperationContext | undefined,
    urlOverride?: URL,
    options: { method: string; body?: unknown; pageSize?: number; limiter?: RateLimiter } = { method: 'GET' },
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const url = urlOverride ?? buildUrl(config, resource, { page: 1, offset: 0, cursor: null, pageSize: options.pageSize });
    if (url.origin !== new URL(config.base_url).origin) {
      throw new UdmtError('INVALID_CONFIG', `REST request escaped the configured origin: ${url.origin}`);
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...parseHeaders(config.headers),
    };
    const auth = config.auth_type ?? 'none';
    if (auth === 'bearer') headers.authorization = `Bearer ${String(secret.token ?? '')}`;
    if (auth === 'api_key') {
      const key = String(secret.api_key ?? '');
      if (config.auth_query_param) url.searchParams.set(config.auth_query_param, key);
      else headers[(config.auth_header || 'X-API-Key').toLowerCase()] = key;
    }
    if (auth === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${config.username ?? ''}:${String(secret.password ?? '')}`).toString('base64')}`;
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const attempts = Math.max(1, (config.retry_attempts ?? 2) + 1);
    const backoff = config.retry_backoff_ms ?? 500;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (ctx) ctx.throwIfCancelled();
      if (options.limiter) await options.limiter.wait();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? 30_000);
      const onAbort = () => controller.abort();
      ctx?.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetch(url, {
          method: options.method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
          redirect: 'manual',
        });
        if (response.status >= 300 && response.status < 400) {
          throw new UdmtError('CONNECTION_FAILED', `REST endpoint returned a redirect (HTTP ${response.status}); redirects are not followed.`);
        }
        const text = await response.text();
        let body: unknown = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        if (response.ok) return { status: response.status, body, headers: response.headers };
        const retryable = response.status === 429 || response.status >= 500;
        const message = `REST ${options.method} ${url.pathname} failed with HTTP ${response.status}: ${sanitize(text.slice(0, 300))}`;
        if (!retryable || attempt === attempts) {
          throw new UdmtError(mapStatus(response.status), message, { retryable });
        }
        lastError = new UdmtError(mapStatus(response.status), message, { retryable });
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff * attempt;
        if (ctx) ctx.log('warn', `Retrying REST request in ${wait}ms after HTTP ${response.status}.`);
        await sleep(wait);
      } catch (error) {
        if (error instanceof UdmtError) {
          if (attempt === attempts) throw error;
          lastError = error;
          continue;
        }
        if (ctx?.signal.aborted) {
          ctx.throwIfCancelled();
          throw new UdmtError('OPERATION_CANCELLED', 'REST request cancelled.');
        }
        if (attempt === attempts) {
          throw new UdmtError('CONNECTION_FAILED', `REST request failed: ${sanitize((error as Error).message)}`, {
            cause: error,
            retryable: true,
          });
        }
        lastError = error;
        await sleep(backoff * attempt);
      } finally {
        clearTimeout(timeout);
        ctx?.signal.removeEventListener('abort', onAbort);
      }
    }
    throw new UdmtError('CONNECTION_FAILED', `REST request failed: ${sanitize(String(lastError))}`);
  }
}

function normalizeConfig(input: RestConfig): RestConfig {
  const base = input.base_url.trim();
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new UdmtError('INVALID_CONFIG', `REST base_url is not a valid URL: ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UdmtError('INVALID_CONFIG', 'REST base_url must use http or https.');
  }
  const headers = parseHeaders(input.headers);
  for (const name of Object.keys(headers)) {
    if (/^authorization$/i.test(name) || /cookie/i.test(name)) {
      throw new UdmtError('INVALID_CONFIG', 'Use auth_type instead of putting Authorization/Cookie in extra headers.');
    }
  }
  return {
    ...input,
    base_url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`,
    resources: splitResources(input.resources).join(', '),
    headers,
  };
}

function parseHeaders(value: string | Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new UdmtError('INVALID_CONFIG', 'REST extra headers must be a JSON object.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UdmtError('INVALID_CONFIG', 'REST extra headers must be a JSON object.');
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    out[key.toLowerCase()] = String(entry);
  }
  return out;
}

function splitResources(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function firstResource(config: RestConfig): string | null {
  return splitResources(config.resources)[0] ?? null;
}

function buildUrl(
  config: RestConfig,
  resource: string,
  paging?: { page: number; offset: number; cursor: string | null; pageSize?: number },
): URL {
  const base = new URL(`${config.base_url.replace(/\/+$/, '')}/`);
  const url = new URL(resource.replace(/^\/+/, '') || '.', base);
  if (url.origin !== base.origin) {
    throw new UdmtError('INVALID_CONFIG', 'REST resource paths must stay on the configured origin.');
  }
  if (paging) {
    const pageSize = paging.pageSize ?? config.page_size ?? 100;
    if (config.page_size_param) url.searchParams.set(config.page_size_param, String(pageSize));
    const mode = config.page_mode ?? 'page';
    if (mode === 'page' && config.page_param) url.searchParams.set(config.page_param, String(paging.page));
    if (mode === 'offset') {
      const name = config.page_param || 'offset';
      url.searchParams.set(name, String(paging.offset));
    }
    if (mode === 'cursor' && paging.cursor) {
      url.searchParams.set(config.cursor_param || 'cursor', paging.cursor);
    }
  }
  return url;
}

function extractItems(body: unknown, path: string | undefined): unknown {
  if (!path) return body;
  return readPath(body, path);
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}

function ensureSameOrigin(config: RestConfig, link: string): URL {
  let url: URL;
  try {
    url = new URL(link, config.base_url);
  } catch {
    throw new UdmtError('VALIDATION_FAILED', 'REST pagination returned an invalid next link.');
  }
  if (url.origin !== new URL(config.base_url).origin) {
    throw new UdmtError('VALIDATION_FAILED', 'REST pagination next link points to another origin; refusing to follow it.');
  }
  return url;
}

function safeBase(base: string): string {
  try {
    const url = new URL(base);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return base;
  }
}

function mapStatus(status: number): 'AUTH_FAILED' | 'NOT_FOUND' | 'CONNECTION_FAILED' {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  return 'CONNECTION_FAILED';
}

function sanitize(message: string): string {
  return message.replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
}

class RateLimiter {
  private readonly intervalMs: number;
  private lastAt = 0;

  constructor(requestsPerMinute: number) {
    this.intervalMs = requestsPerMinute > 0 ? Math.ceil(60_000 / requestsPerMinute) : 0;
  }

  async wait(): Promise<void> {
    if (this.intervalMs === 0) return;
    const elapsed = Date.now() - this.lastAt;
    if (elapsed < this.intervalMs) await sleep(this.intervalMs - elapsed);
    this.lastAt = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

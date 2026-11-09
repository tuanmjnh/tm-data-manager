import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { UdmtError } from '../errors.js';
import type { AppPaths } from '../paths.js';
import { sha256File } from '../utils.js';
import type { StorageBackend, StorageObjectInfo, StorageTestResult } from './contract.js';

const ConfigSchema = z.object({
  endpoint: z.string().url(),
  region: z.string().min(1).default('auto'),
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  force_path_style: z.boolean().optional(),
  /** Informational only; signing is identical for R2, MinIO and B2. */
  profile: z.enum(['custom', 'aws', 'r2', 'minio', 'b2']).optional(),
});

const SecretSchema = z.object({
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  session_token: z.string().optional(),
});

export type S3Config = z.infer<typeof ConfigSchema>;
export type S3Secret = z.infer<typeof SecretSchema>;

export interface S3StorageOptions {
  id: string;
  paths: AppPaths;
  config: Record<string, unknown>;
  secret: Record<string, unknown>;
}

/**
 * S3-compatible artifact backend (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
 * Implemented with fetch + SigV4 so no vendor SDK is bundled into the desktop
 * runtime. Path-style addressing is the default because R2/MinIO/B2 all accept
 * it; use `force_path_style: false` for virtual-host buckets.
 */
export class S3StorageBackend implements StorageBackend {
  readonly backend_type = 's3' as const;
  readonly isRemote = true;
  readonly id: string;
  readonly config: S3Config;
  private readonly secret: S3Secret;
  private readonly stagingRoot: string;
  readonly endpoint_hint: string;

  constructor(options: S3StorageOptions) {
    this.id = options.id;
    const parsed = ConfigSchema.safeParse(options.config);
    if (!parsed.success) {
      throw new UdmtError(
        'INVALID_CONFIG',
        `S3 storage config is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    this.config = normalizeConfig(parsed.data);
    const secrets = SecretSchema.safeParse(options.secret);
    if (!secrets.success) {
      throw new UdmtError('INVALID_CONFIG', 'S3 storage needs access_key_id and secret_access_key.');
    }
    this.secret = secrets.data;
    this.stagingRoot = join(options.paths.tempDir, 'staging');
    this.endpoint_hint = `s3://${this.config.bucket}/${this.config.prefix ?? ''}`;
  }

  async prepareStagingDir(runId: string): Promise<string> {
    const dir = join(this.stagingRoot, runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  objectKeyFor(localPath: string, runId: string): string {
    const prefix = (this.config.prefix ?? '').replace(/^\/+|\/+$/g, '');
    return [prefix, runId, basename(localPath)].filter(Boolean).join('/');
  }

  describeObject(objectKey: string): string {
    return `s3://${this.config.bucket}/${objectKey}`;
  }

  async putObject(localPath: string, objectKey: string, options: {} = {}): Promise<void> {
    const body = createReadStream(localPath);
    const [sha256, info] = await Promise.all([sha256File(localPath), stat(localPath)]);
    const response = await this.request('PUT', objectKey, {
      body: Readable.toWeb(body) as ReadableStream,
      payloadHash: sha256,
      headers: { 'content-type': guessContentType(localPath), 'content-length': String(info.size) },
    });
    if (!response.ok) await this.raise(response, `PUT ${objectKey}`);
  }

  async getObject(objectKey: string, localPath: string): Promise<void> {
    const response = await this.request('GET', objectKey);
    if (!response.ok) await this.raise(response, `GET ${objectKey}`);
    if (!response.body) throw new UdmtError('STORAGE_ERROR', `Object ${objectKey} has no body.`);
    await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(localPath, { mode: 0o600 }));
  }

  async statObject(objectKey: string): Promise<StorageObjectInfo> {
    const response = await this.request('HEAD', objectKey);
    if (!response.ok) await this.raise(response, `HEAD ${objectKey}`);
    return {
      size: Number(response.headers.get('content-length') ?? 0),
      mtime: response.headers.get('last-modified')
        ? new Date(response.headers.get('last-modified')!).toISOString()
        : null,
    };
  }

  async checksum(objectKey: string): Promise<string> {
    const response = await this.request('GET', objectKey);
    if (!response.ok) await this.raise(response, `GET ${objectKey}`);
    if (!response.body) throw new UdmtError('STORAGE_ERROR', `Object ${objectKey} has no body.`);
    const hash = createHash('sha256');
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  async list(prefix = ''): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    // `prefix` is an absolute object-key prefix (same contract as the local
    // backend). With no argument, scope the listing to the configured prefix.
    const base = prefix.replace(/^\/+/, '') || (this.config.prefix ?? '');
    do {
      const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
      if (base) query.prefix = base;
      if (token) query['continuation-token'] = token;
      const response = await this.request('GET', '', { query });
      if (!response.ok) await this.raise(response, 'LIST');
      const xml = await response.text();
      keys.push(...decodeXmlValues(xml, 'Key'));
      token = decodeXmlValues(xml, 'NextContinuationToken')[0];
      if (!token) break;
    } while (true);
    return keys;
  }

  async deleteObject(objectKey: string): Promise<void> {
    const response = await this.request('DELETE', objectKey);
    if (!response.ok && response.status !== 404) await this.raise(response, `DELETE ${objectKey}`);
  }

  async test(): Promise<StorageTestResult> {
    const started = Date.now();
    try {
      const response = await this.request('GET', '', {
        query: { 'list-type': '2', 'max-keys': '1' },
      });
      if (!response.ok) {
        const message = await describeFailure(response);
        return {
          success: false,
          latency_ms: Date.now() - started,
          diagnostics: [message],
          endpoint_hint: this.endpoint_hint,
        };
      }
      const xml = await response.text();
      const count = decodeXmlValues(xml, 'Key').length;
      return {
        success: true,
        latency_ms: Date.now() - started,
        diagnostics: [
          `endpoint: ${this.config.endpoint}`,
          `bucket: ${this.config.bucket}`,
          `region: ${this.config.region}`,
          `list probe: ok (${count} key(s) in first page)`,
        ],
        endpoint_hint: this.endpoint_hint,
      };
    } catch (error) {
      return {
        success: false,
        latency_ms: Date.now() - started,
        diagnostics: [(error as Error).message],
        endpoint_hint: this.endpoint_hint,
      };
    }
  }

  // ------------------------------------------------------------------ signer
  private buildUrl(objectKey: string, query: Record<string, string> = {}): { url: URL; canonicalPath: string; host: string } {
    const endpoint = new URL(this.config.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const usePathStyle = this.config.force_path_style !== false;
    const encodedKey = objectKey.split('/').filter(Boolean).map(encodeRfc3986).join('/');

    let host = endpoint.host;
    let path: string;
    if (usePathStyle) {
      path = `${basePath}/${encodeRfc3986(this.config.bucket)}${encodedKey ? `/${encodedKey}` : ''}`;
    } else {
      host = `${this.config.bucket}.${endpoint.host}`;
      path = `${basePath}${encodedKey ? `/${encodedKey}` : ''}`;
    }
    path = path.replace(/\/{2,}/g, '/') || '/';

    const params = Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
      .join('&');

    const url = new URL(endpoint.href);
    url.host = host;
    url.pathname = path;
    url.search = params ? `?${params}` : '';
    return { url, canonicalPath: path, host };
  }

  private async request(
    method: string,
    objectKey: string,
    options: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: RequestInit['body'];
      payloadHash?: string;
    } = {},
  ): Promise<Response> {
    const { url, canonicalPath, host } = this.buildUrl(objectKey, options.query);
    const payloadHash = options.payloadHash ?? sha256Hex('');
    const now = new Date();
    const amzDate = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(options.headers ?? {}),
    };
    if (this.secret.session_token) headers['x-amz-security-token'] = this.secret.session_token;

    const signedHeaderNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(headers[findHeaderKey(headers, name)] ?? '').trim().replace(/\s+/g, ' ')}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalQuery = new URLSearchParams(
      [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ).toString();
    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.secret.secret_access_key}`, dateStamp), this.config.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.secret.access_key_id}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      ...(options.body ? { body: options.body, duplex: 'half' } : {}),
    };
    return fetch(url, init);
  }

  private async raise(response: Response, operation: string): Promise<never> {
    throw new UdmtError('STORAGE_ERROR', `S3 ${operation} failed: ${await describeFailure(response)}`, {
      details: { status: response.status, endpoint: this.config.endpoint, bucket: this.config.bucket },
    });
  }
}

function normalizeConfig(config: S3Config): S3Config {
  const prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '');
  if (prefix.split('/').includes('..')) {
    throw new UdmtError('INVALID_CONFIG', 'S3 prefix must not contain "..".');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) && !config.force_path_style) {
    throw new UdmtError('INVALID_CONFIG', `Invalid S3 bucket name: ${config.bucket}`);
  }
  return {
    ...config,
    endpoint: config.endpoint.replace(/\/+$/, ''),
    prefix,
    profile: config.profile ?? 'custom',
    force_path_style: config.force_path_style !== false,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function findHeaderKey(headers: Record<string, string>, lower: string): string {
  return Object.keys(headers).find((name) => name.toLowerCase() === lower) ?? lower;
}

/** AWS canonical URI encoding: every byte except A-Z a-z 0-9 - _ . ~ */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeXmlValues(xml: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  for (const match of xml.matchAll(pattern)) {
    values.push(decodeXmlEntities(match[1] ?? ''));
  }
  return values;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1];
  if (code || message) return `${response.status} ${code ?? ''} ${message ?? ''}`.trim();
  return `${response.status} ${response.statusText}`.trim();
}

function guessContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.manifest.json')) return 'application/json';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'application/x-ndjson';
  if (lower.endsWith('.xml')) return 'application/xml';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

/** Used by tests and diagnostics. */
export function s3Locator(config: { bucket: string; prefix?: string }, key: string): string {
  return `s3://${config.bucket}/${[config.prefix, key].filter(Boolean).join('/')}`;
}

export function resolveStagingPath(paths: AppPaths, runId: string, file: string): string {
  return resolve(join(paths.tempDir, 'staging', runId, file));
}

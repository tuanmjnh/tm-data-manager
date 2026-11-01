import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export const APP_VERSION = '0.1.0';

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Masks credentials in any endpoint summary shown in lists/logs. */
export function maskEndpoint(input: string): string {
  return input
    .replace(/\/\/([^:/@\s]+):([^@\s]+)@/g, '//$1:***@')
    .replace(/([?&](?:password|token|secret|api_key)=)[^&\s]+/gi, '$1***');
}

export function sanitizeName(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._@-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'item';
}

export function truncate(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash as unknown as NodeJS.WritableStream);
  return hash.digest('hex');
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

/** Reads a stream to completion with a callback for each chunk. */
export async function consumeStream(stream: Readable, onChunk: (chunk: Buffer) => void): Promise<void> {
  for await (const chunk of stream) onChunk(chunk as Buffer);
}

export function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return /^(1|true|yes|y|on)$/i.test(value.trim());
  return fallback;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

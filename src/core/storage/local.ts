import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, stat, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { assertSafePath } from '../paths.js';
import { UdmtError } from '../errors.js';
import { sha256File } from '../utils.js';
import type { AppPaths } from '../paths.js';

/**
 * Local filesystem artifact backend (roadmap 9.1).
 * Every path is validated against the backend root before use.
 */
export class LocalStorageBackend {
  readonly id: string;
  readonly root: string;

  constructor(readonly paths: AppPaths, readonly backendId = 'local-default', root?: string) {
    this.id = backendId;
    this.root = resolve(root ?? paths.artifactsDir);
    if (!existsSync(this.root)) mkdir(this.root, { recursive: true, mode: 0o700 }).catch(() => undefined);
  }

  resolveKey(objectKey: string): string {
    if (objectKey.includes('\0') || objectKey.split(/[\\/]/).includes('..')) {
      throw new UdmtError('PATH_UNSAFE', `Unsafe artifact key: ${objectKey}`);
    }
    const absolute = resolve(this.root, objectKey);
    assertSafePath(absolute, [this.root]);
    return absolute;
  }

  async prepareRunDir(runId: string): Promise<string> {
    const dir = join(this.root, runId);
    assertSafePath(dir, [this.root]);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  objectKeyFor(absolutePath: string): string {
    const key = relative(this.root, absolutePath);
    if (key.startsWith('..') || key.includes(':') && process.platform === 'win32' && key.startsWith('..')) {
      throw new UdmtError('PATH_UNSAFE', `Artifact is outside the storage root: ${absolutePath}`);
    }
    return key.split('\\').join('/');
  }

  async statObject(objectKey: string): Promise<{ size: number; mtime: string }> {
    const absolute = this.resolveKey(objectKey);
    const info = await stat(absolute);
    return { size: info.size, mtime: info.mtime.toISOString() };
  }

  async checksum(objectKey: string): Promise<string> {
    return sha256File(this.resolveKey(objectKey));
  }

  async list(prefix = ''): Promise<string[]> {
    const dir = prefix ? this.resolveKey(prefix) : this.root;
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(this.root, join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name)).split('\\').join('/'));
  }

  async deleteObject(objectKey: string): Promise<void> {
    const absolute = this.resolveKey(objectKey);
    assertSafePath(absolute, [this.root], { mustExist: true });
    await rm(absolute, { force: false });
  }

  async deleteRunDir(runId: string): Promise<void> {
    const dir = join(this.root, runId);
    assertSafePath(dir, [this.root], { mustExist: true });
    await rm(dir, { recursive: true, force: false });
  }

  async moveObject(fromKey: string, toKey: string): Promise<void> {
    const from = this.resolveKey(fromKey);
    const to = this.resolveKey(toKey);
    assertSafePath(from, [this.root], { mustExist: true });
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await rename(from, to);
  }

  readStream(objectKey: string): NodeJS.ReadableStream {
    return createReadStream(this.resolveKey(objectKey));
  }

  sizeOfFile(absolutePath: string): number {
    return statSync(absolutePath).size;
  }
}

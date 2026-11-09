import { createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { assertSafePath } from '../paths.js';
import { UdmtError } from '../errors.js';
import { sha256File } from '../utils.js';
import type { AppPaths } from '../paths.js';
import type { StorageBackend, StorageObjectInfo, StorageTestResult } from './contract.js';

/**
 * Local filesystem artifact backend (roadmap 9.1).
 * Every path is validated against the backend root before use.
 */
export class LocalStorageBackend implements StorageBackend {
  readonly id: string;
  readonly backend_type = 'local' as const;
  readonly isRemote = false;
  readonly endpoint_hint: string;
  readonly root: string;

  constructor(readonly paths: AppPaths, readonly backendId = 'local-default', root?: string) {
    this.id = backendId;
    this.root = resolve(root ?? paths.artifactsDir);
    this.endpoint_hint = this.root;
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

  async prepareStagingDir(runId: string): Promise<string> {
    const dir = join(this.root, runId);
    assertSafePath(dir, [this.root]);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  objectKeyFor(absolutePath: string): string {
    const key = relative(this.root, absolutePath);
    if (key.startsWith('..') || (key.includes(':') && process.platform === 'win32' && key.startsWith('..'))) {
      throw new UdmtError('PATH_UNSAFE', `Artifact is outside the storage root: ${absolutePath}`);
    }
    return key.split('\\').join('/');
  }

  describeObject(objectKey: string): string {
    return this.resolveKey(objectKey);
  }

  async putObject(localPath: string, objectKey: string): Promise<void> {
    const target = this.resolveKey(objectKey);
    if (resolve(localPath) === target) return;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(localPath, target);
  }

  async getObject(objectKey: string, localPath: string): Promise<void> {
    const source = this.resolveKey(objectKey);
    if (resolve(source) === resolve(localPath)) return;
    await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
    await copyFile(source, localPath);
  }

  async statObject(objectKey: string): Promise<StorageObjectInfo> {
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
      .map((entry) =>
        relative(
          this.root,
          join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name),
        ).split('\\').join('/'),
      );
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

  async test(): Promise<StorageTestResult> {
    const started = Date.now();
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const probe = join(this.root, `.udmt-write-test-${process.pid}-${Date.now()}`);
      await mkdir(probe, { recursive: false, mode: 0o700 });
      await rm(probe, { recursive: true, force: true });
      return {
        success: true,
        latency_ms: Date.now() - started,
        diagnostics: [`root: ${this.root}`, 'read/write probe: ok'],
        endpoint_hint: this.root,
      };
    } catch (error) {
      return {
        success: false,
        latency_ms: Date.now() - started,
        diagnostics: [(error as Error).message],
        endpoint_hint: this.root,
      };
    }
  }
}

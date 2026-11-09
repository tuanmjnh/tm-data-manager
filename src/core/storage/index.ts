import type { AppPaths } from '../paths.js';
import type { StorageBackendRecord } from '../types.js';
import { LocalStorageBackend } from './local.js';
import { S3StorageBackend } from './s3.js';
import type { StorageBackend } from './contract.js';

/**
 * Builds a backend instance from a catalog record. Secrets come from the
 * encrypted vault; `config` in SQLite never contains credentials.
 */
export function createStorageBackend(
  paths: AppPaths,
  record: StorageBackendRecord,
  secret: Record<string, unknown> = {},
): StorageBackend {
  if (record.backend_type === 's3') {
    return new S3StorageBackend({
      id: record.id,
      paths,
      config: record.config,
      secret,
    });
  }
  const root = typeof record.config.root === 'string' ? record.config.root : paths.artifactsDir;
  return new LocalStorageBackend(paths, record.id, root);
}

/** The always-present managed local backend, used as a safe fallback. */
export function managedLocalBackend(paths: AppPaths): LocalStorageBackend {
  return new LocalStorageBackend(paths, 'local-default', paths.artifactsDir);
}

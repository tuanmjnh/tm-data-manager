import type { StorageBackendType } from '../types.js';

export interface StorageTestResult {
  success: boolean;
  latency_ms: number;
  diagnostics: string[];
  endpoint_hint: string | null;
}

export interface StorageObjectInfo {
  size: number;
  mtime: string | null;
}

/**
 * Artifact storage abstraction (roadmap 9.1). The engine always streams to a
 * local staging file and then asks the backend to publish it, so providers and
 * the export engine never need to know whether a backend is local or remote.
 */
export interface StorageBackend {
  readonly id: string;
  readonly backend_type: StorageBackendType;
  /** False when the backend reads/writes plain files in place. */
  readonly isRemote: boolean;
  /** Human-readable location shown in the UI (never contains credentials). */
  readonly endpoint_hint: string | null;

  /** Local directory the engine may write a run's files into. */
  prepareStagingDir(runId: string): Promise<string>;
  /** Object key for a local staging file. */
  objectKeyFor(localPath: string, runId: string): string;
  /** Publish a finished local file. Local backends treat this as a no-op. */
  putObject(localPath: string, objectKey: string, options?: { contentType?: string; sha256?: string }): Promise<void>;
  /** Download an object to a local path. Local backends verify/copy only when needed. */
  getObject(objectKey: string, localPath: string): Promise<void>;
  statObject(objectKey: string): Promise<StorageObjectInfo>;
  checksum(objectKey: string): Promise<string>;
  /** List object keys under an absolute prefix (local path or object key). */
  list(prefix?: string): Promise<string[]>;
  deleteObject(objectKey: string): Promise<void>;
  /** Absolute filesystem path (local) or `s3://bucket/key` locator. */
  describeObject(objectKey: string): string;
  test(): Promise<StorageTestResult>;
}

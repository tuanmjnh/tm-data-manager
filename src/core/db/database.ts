import { DatabaseSync, type DatabaseSyncInstance } from './sqlite-driver.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations.js';

/**
 * Thin wrapper over `node:sqlite`.
 *
 * The metadata store is local-only and small: every call is synchronous and
 * fast (no network). Long data movement never goes through this database.
 */
export class Db {
  readonly raw: DatabaseSyncInstance;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:' && !existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.raw.prepare(sql).run(...(params as never[])) as {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }

  integrityCheck(): string {
    const rows = this.all<{ integrity_check: string }>('PRAGMA integrity_check');
    return rows[0]?.integrity_check ?? 'unknown';
  }

  close(): void {
    this.raw.close();
  }
}

export function openDatabase(path: string): Db {
  const db = new Db(path);
  try {
    runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

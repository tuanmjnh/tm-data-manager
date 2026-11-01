declare module 'pg-cursor' {
  import type { Submittable } from 'pg';

  interface CursorConfig {
    rowMode?: 'array' | 'object';
  }

  class Cursor<R = Record<string, unknown>> implements Submittable {
    constructor(text: string, values?: unknown[], config?: CursorConfig);
    read(rowCount: number): Promise<R[]>;
    close(): Promise<void>;
  }

  export = Cursor;
}

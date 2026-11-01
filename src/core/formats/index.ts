import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { stringify } from 'csv-stringify';
import { parse } from 'csv-parse';
import { UdmtError } from '../errors.js';
import type { CanonicalType, ColumnSchema, Compression, ExportFormat, Row } from '../types.js';

export interface FormatWriter {
  write(row: Row): Promise<void>;
  finish(): Promise<{ bytes_written: number; row_count: number }>;
  abort(): Promise<void>;
}

export function createFormatWriter(
  format: ExportFormat,
  compression: Compression,
  outPath: string,
  columns: ColumnSchema[],
): FormatWriter {
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  let bytes = 0;
  let rows = 0;
  let failed = false;

  const file = createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
  let sink: Writable;
  let ready: Promise<void>;
  if (compression === 'gzip') {
    const gzip = createGzip();
    sink = gzip;
    ready = pipeline(gzip, counter, file);
  } else {
    sink = counter;
    ready = pipeline(counter, file);
  }

  let csv: ReturnType<typeof stringify> | null = null;
  let csvDone: Promise<void> | null = null;

  if (format === 'csv') {
    if (columns.length === 0) {
      throw new UdmtError('INVALID_INPUT', 'CSV export requires a column list.');
    }
    csv = stringify({
      header: true,
      columns: columns.map((column) => column.name),
      cast: { boolean: (value) => (value ? 'true' : 'false') },
    });
    csvDone = pipeline(csv, counter as unknown as Writable);
    csvDone.catch(() => undefined);
  }

  let first = true;

  async function writeText(text: string): Promise<void> {
    if (!sink.write(text)) {
      await new Promise<void>((resolve, reject) => {
        sink.once('drain', resolve);
        sink.once('error', reject);
      });
    }
  }

  return {
    async write(row: Row): Promise<void> {
      if (failed) throw new UdmtError('IO_ERROR', 'Writer already failed.');
      rows += 1;
      if (format === 'csv' && csv) {
        csv.write(row);
        return;
      }
      if (format === 'jsonl') {
        await writeText(`${JSON.stringify(row)}\n`);
        return;
      }
      if (first) {
        first = false;
        await writeText(`[${JSON.stringify(row)}`);
      } else {
        await writeText(`,\n${JSON.stringify(row)}`);
      }
    },
    async finish(): Promise<{ bytes_written: number; row_count: number }> {
      try {
        if (format === 'csv' && csv) {
          csv.end();
          await csvDone;
          await ready;
        } else {
          if (format === 'json') await writeText(first ? '[]' : '\n]');
          sink.end();
          await ready;
        }
        return { bytes_written: bytes, row_count: rows };
      } catch (error) {
        failed = true;
        throw new UdmtError('IO_ERROR', `Failed writing export file: ${(error as Error).message}`, { cause: error });
      }
    },
    async abort(): Promise<void> {
      failed = true;
      sink.destroy();
      await ready.catch(() => undefined);
    },
  };
}

export interface FormatReaderOptions {
  format: ExportFormat;
  columns: ColumnSchema[];
  /** Capability check: importers must reject values that cannot be mapped. */
  coerce: boolean;
}

export async function* readRowsFromFile(path: string, options: FormatReaderOptions): AsyncGenerator<Row> {
  const compressed = path.toLowerCase().endsWith('.gz');
  const base: Readable = createReadStream(path);
  const input: Readable = compressed ? base.pipe(createGunzip()) : base;

  try {
    if (compressed && path.toLowerCase().endsWith('.json')) {
      // handled by the streaming JSON reader below via gunzip output
    }
    if (options.format === 'jsonl') {
      const rl = createInterface({ input, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row: unknown;
        try {
          row = JSON.parse(trimmed);
        } catch (error) {
          throw new UdmtError('VALIDATION_FAILED', `Invalid JSONL line: ${(error as Error).message}`);
        }
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          throw new UdmtError('VALIDATION_FAILED', 'JSONL rows must be objects.');
        }
        yield options.coerce ? coerceRow(row as Row, options.columns) : (row as Row);
      }
      return;
    }

    if (options.format === 'csv') {
      const parser = input.pipe(
        parse({ columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }),
      );
      try {
        for await (const record of parser) {
          yield options.coerce ? coerceRow(record as Row, options.columns) : (record as Row);
        }
      } catch (error) {
        throw new UdmtError('VALIDATION_FAILED', `Invalid CSV: ${(error as Error).message}`);
      }
      return;
    }

    // Streaming JSON array reader: tracks depth so we never hold the file in memory.
    let buffer = '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    let object = '';
    for await (const chunk of input) {
      buffer += chunk.toString('utf8');
      let consumed = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const char = buffer[i]!;
        if (!started) {
          if (char === '[') started = true;
          else if (char === ',' || /\s/.test(char)) continue;
          else throw new UdmtError('VALIDATION_FAILED', 'JSON export must be an array of objects.');
          consumed = i + 1;
          continue;
        }
        if (depth === 0) {
          if (char === ']') {
            started = false;
            consumed = i + 1;
            continue;
          }
          if (char === ',' || /\s/.test(char)) {
            consumed = i + 1;
            continue;
          }
        }
        object += char;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') {
          inString = true;
        } else if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(object);
            } catch (error) {
              throw new UdmtError('VALIDATION_FAILED', `Invalid JSON record: ${(error as Error).message}`);
            }
            object = '';
            yield options.coerce ? coerceRow(parsed as Row, options.columns) : (parsed as Row);
          }
        }
        consumed = i + 1;
      }
      buffer = buffer.slice(consumed);
      if (!started && depth === 0) break;
    }
  } finally {
    input.destroy();
    base.destroy();
  }
}

/** Parses values according to the manifest column types (CSV has no types). */
export function coerceRow(row: Row, columns: ColumnSchema[]): Row {
  if (columns.length === 0) return row;
  const out: Row = { ...row };
  for (const column of columns) {
    const value = out[column.name];
    if (value === undefined) continue;
    out[column.name] = coerceValue(value, column.type);
  }
  return out;
}

export function coerceValue(value: unknown, type: CanonicalType): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'integer': {
      if (typeof value === 'number') return Math.trunc(value);
      const n = Number(String(value).trim());
      return Number.isFinite(n) ? Math.trunc(n) : value;
    }
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(String(value).trim());
      return Number.isFinite(n) ? n : value;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (/^(1|true|yes|t)$/i.test(String(value))) return true;
      if (/^(0|false|no|f)$/i.test(String(value))) return false;
      return value;
    }
    case 'json': {
      if (typeof value === 'object') return value;
      const text = String(value).trim();
      if (!/^[[{]/.test(text)) return value;
      try {
        return JSON.parse(text);
      } catch {
        return value;
      }
    }
    default:
      return value;
  }
}

export function detectFormat(path: string): ExportFormat {
  const lower = path.toLowerCase().replace(/\.gz$/, '');
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  throw new UdmtError('FORMAT_UNSUPPORTED', `Cannot detect export format from file name: ${path}`);
}

export function defaultExtension(format: ExportFormat, compression: Compression): string {
  const base = format === 'jsonl' ? '.jsonl' : format === 'csv' ? '.csv' : '.json';
  return compression === 'gzip' ? `${base}.gz` : base;
}

import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { stringify } from 'csv-stringify';
import { parse } from 'csv-parse';
import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
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
  if (format === 'xlsx') {
    if (compression === 'gzip') {
      throw new UdmtError('INVALID_INPUT', 'XLSX is already a compressed container; choose compression "none".');
    }
    if (columns.length === 0) {
      throw new UdmtError('INVALID_INPUT', 'XLSX export requires a column list.');
    }
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outPath, useStyles: true });
    const sheet = workbook.addWorksheet('rows');
    sheet.addRow(columns.map((column) => column.name)).commit();
    let xlsxRows = 0;
    let xlsxClosed = false;
    return {
      async write(row: Row): Promise<void> {
        if (xlsxClosed) throw new UdmtError('IO_ERROR', 'Writer already finished.');
        sheet.addRow(columns.map((column) => xlsxValue(row[column.name]))).commit();
        xlsxRows += 1;
      },
      async finish(): Promise<{ bytes_written: number; row_count: number }> {
        try {
          await sheet.commit();
          await workbook.commit();
          xlsxClosed = true;
          const info = await stat(outPath);
          return { bytes_written: info.size, row_count: xlsxRows };
        } catch (error) {
          throw new UdmtError('IO_ERROR', `Failed writing XLSX file: ${(error as Error).message}`, { cause: error });
        }
      },
      async abort(): Promise<void> {
        xlsxClosed = true;
        try {
          await workbook.commit();
        } catch {
          /* best effort; the engine removes the partial file */
        }
      },
    };
  }

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
  const xmlNames = columns.map((column) => column.name);

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
      if (format === 'xml') {
        if (first) {
          first = false;
          await writeText('<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n');
        }
        const keys = xmlNames.length > 0 ? xmlNames : Object.keys(row);
        const fields = keys.map((name) => xmlField(name, row[name])).join('');
        await writeText(`<row>${fields}</row>\n`);
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
        } else if (format === 'xml') {
          if (first) await writeText('<?xml version="1.0" encoding="UTF-8"?>\n');
          await writeText('</rows>\n');
          sink.end();
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
  if (options.format === 'xlsx') {
    if (path.toLowerCase().endsWith('.gz')) {
      throw new UdmtError('FORMAT_UNSUPPORTED', 'Compressed XLSX files are not supported; unzip the workbook first.');
    }
    yield* readRowsFromXlsx(path, options);
    return;
  }
  if (options.format === 'xml') {
    yield* readRowsFromXml(path, options);
    return;
  }
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

async function* readRowsFromXlsx(path: string, options: FormatReaderOptions): AsyncGenerator<Row> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path);
  } catch (error) {
    throw new UdmtError('VALIDATION_FAILED', `Invalid XLSX workbook: ${(error as Error).message}`, { cause: error });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return;
  const header = sheet.getRow(1).values as unknown[];
  const names: Array<string | null> = [];
  for (let index = 1; index < (header?.length ?? 0); index += 1) {
    const value = cellValue(header[index]);
    names[index] = value === null || value === undefined || value === '' ? null : String(value);
  }
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = sheet.getRow(rowNumber).values as unknown[];
    const row: Row = {};
    for (let index = 1; index < names.length; index += 1) {
      const name = names[index];
      if (!name) continue;
      const value = cellValue(values[index]);
      if (value !== undefined) row[name] = value;
    }
    if (Object.keys(row).length === 0) continue;
    yield options.coerce ? coerceRow(row, options.columns) : row;
  }
}

function cellValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  const cell = value as {
    text?: unknown;
    result?: unknown;
    richText?: Array<{ text?: string }>;
    error?: unknown;
    formula?: unknown;
  };
  if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text ?? '').join('');
  if (cell.result !== undefined) return cell.result;
  if (cell.text !== undefined) return cell.text;
  if (cell.error !== undefined) return null;
  return value;
}

async function* readRowsFromXml(path: string, options: FormatReaderOptions): AsyncGenerator<Row> {
  const text = await readAllText(path);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => name === 'row' || name === 'field' || name === 'column',
  });
  let doc: unknown;
  try {
    doc = parser.parse(text);
  } catch (error) {
    throw new UdmtError('VALIDATION_FAILED', `Invalid XML: ${(error as Error).message}`, { cause: error });
  }
  const root = (doc as { rows?: unknown }).rows ?? doc;
  const rawRows = (root as { row?: unknown }).row;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows === undefined ? [] : [rawRows];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const fields = node.field ?? node.column;
    const row: Row = {};
    if (fields !== undefined) {
      const list = Array.isArray(fields) ? fields : [fields];
      for (const field of list) {
        if (!field || typeof field !== 'object') continue;
        const entry = field as Record<string, unknown>;
        const name = entry['@_name'];
        if (typeof name !== 'string' || !name) continue;
        row[name] = xmlFieldValue(entry);
      }
    } else {
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('@_') || key === '#text') continue;
        row[key] = xmlGenericValue(value);
      }
    }
    if (Object.keys(row).length === 0) continue;
    yield options.coerce ? coerceRow(row, options.columns) : row;
  }
}

async function readAllText(path: string): Promise<string> {
  const base = createReadStream(path);
  const input: Readable = path.toLowerCase().endsWith('.gz') ? base.pipe(createGunzip()) : base;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  } finally {
    input.destroy();
    base.destroy();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function xmlFieldValue(field: Record<string, unknown>): unknown {
  if (field['@_nil'] === 'true' || field['@_nil'] === true) return null;
  const raw = field['#text'];
  if (raw === undefined || raw === null) return null;
  const text = String(raw);
  const type = field['@_type'];
  if (type === 'integer') {
    const value = Number(text);
    return Number.isFinite(value) ? Math.trunc(value) : text;
  }
  if (type === 'number') {
    const value = Number(text);
    return Number.isFinite(value) ? value : text;
  }
  if (type === 'boolean') return /^(1|true|yes|t)$/i.test(text);
  if (type === 'json') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function xmlGenericValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(xmlGenericValue);
  if (typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  if ('#text' in node) return node['#text'];
  return JSON.stringify(node);
}

function xmlField(name: string, value: unknown): string {
  const safeName = escapeXml(name);
  if (value === null || value === undefined) return `<field name="${safeName}" nil="true"/>`;
  const type =
    typeof value === 'number'
      ? Number.isInteger(value)
        ? 'integer'
        : 'number'
      : typeof value === 'boolean'
        ? 'boolean'
        : typeof value === 'object'
          ? 'json'
          : 'string';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `<field name="${safeName}" type="${type}">${escapeXml(text)}</field>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xlsxValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
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
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  throw new UdmtError('FORMAT_UNSUPPORTED', `Cannot detect export format from file name: ${path}`);
}

export function defaultExtension(format: ExportFormat, compression: Compression): string {
  const base =
    format === 'jsonl'
      ? '.jsonl'
      : format === 'csv'
        ? '.csv'
        : format === 'xml'
          ? '.xml'
          : format === 'xlsx'
            ? '.xlsx'
            : '.json';
  return compression === 'gzip' ? `${base}.gz` : base;
}

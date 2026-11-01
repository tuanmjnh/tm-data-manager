import type { UdmtError } from '../core/errors.js';

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  INVALID_INPUT: 2,
  CONNECTION: 3,
  OPERATION: 4,
  CANCELLED: 5,
} as const;

export function exitCodeFor(error: UdmtError): number {
  switch (error.code) {
    case 'INVALID_INPUT':
    case 'INVALID_CONFIG':
    case 'VALIDATION_FAILED':
    case 'FORMAT_UNSUPPORTED':
    case 'CONFIRMATION_REQUIRED':
      return EXIT.INVALID_INPUT;
    case 'CONNECTION_FAILED':
    case 'AUTH_FAILED':
      return EXIT.CONNECTION;
    case 'OPERATION_CANCELLED':
      return EXIT.CANCELLED;
    case 'NOT_FOUND':
    case 'ALREADY_EXISTS':
    case 'CONFLICT':
    case 'CAPABILITY_UNSUPPORTED':
    case 'PRECONDITION_FAILED':
    case 'PATH_UNSAFE':
    case 'LOCKED':
    case 'IO_ERROR':
    case 'OPERATION_FAILED':
    case 'INTERRUPTED':
      return EXIT.OPERATION;
    default:
      return EXIT.INTERNAL;
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printTable(rows: Array<Record<string, unknown>>, columns: string[]): void {
  if (rows.length === 0) {
    process.stdout.write('(none)\n');
    return;
  }
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => formatCell(row[column]).length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();
  process.stdout.write(`${line(columns)}\n`);
  process.stdout.write(`${line(widths.map((width) => '─'.repeat(width)))}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(columns.map((column) => formatCell(row[column])))}\n`);
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function statusColor(status: string): string {
  if (['completed'].includes(status)) return '\u001b[32m';
  if (['completed_with_warnings', 'cancelled', 'interrupted', 'cancel_requested'].includes(status)) return '\u001b[33m';
  if (['failed'].includes(status)) return '\u001b[31m';
  return '\u001b[36m';
}

export const RESET = '\u001b[0m';

export function logLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

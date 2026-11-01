import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSafePath, assertSafeSegment, resolveAppPaths } from '../../src/core/paths.js';
import { UdmtError } from '../../src/core/errors.js';
import { sanitizeErrorMessage } from '../../src/core/errors.js';
import { maskEndpoint, sanitizeName } from '../../src/core/utils.js';

const dir = mkdtempSync(join(tmpdir(), 'udmt-paths-'));
mkdirSync(join(dir, 'root'), { recursive: true });
mkdirSync(join(dir, 'outside'), { recursive: true });
writeFileSync(join(dir, 'root', 'ok.txt'), 'ok');
writeFileSync(join(dir, 'outside', 'secret.txt'), 'secret');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('path safety', () => {
  it('accepts paths inside a managed root', () => {
    const resolved = assertSafePath(join(dir, 'root', 'ok.txt'), [join(dir, 'root')], { mustExist: true });
    expect(resolved.endsWith('ok.txt')).toBe(true);
  });

  it('rejects traversal and outside paths', () => {
    expect(() => assertSafePath(join(dir, 'root', '..', 'outside', 'secret.txt'), [join(dir, 'root')])).toThrow(UdmtError);
    expect(() => assertSafePath(join(dir, 'outside', 'secret.txt'), [join(dir, 'root')])).toThrow(UdmtError);
    expect(() => assertSafePath('/etc/passwd', [join(dir, 'root')])).toThrow(UdmtError);
  });

  it('rejects NUL bytes and unsafe segments', () => {
    expect(() => assertSafePath(`${join(dir, 'root')}\0x`, [join(dir, 'root')])).toThrow(UdmtError);
    expect(() => assertSafeSegment('../etc')).toThrow(UdmtError);
    expect(assertSafeSegment('users-2026.csv')).toBe('users-2026.csv');
  });

  it('uses an override data directory', () => {
    const paths = resolveAppPaths(join(dir, 'data'));
    expect(paths.dbPath.startsWith(join(dir, 'data'))).toBe(true);
  });
});

describe('redaction', () => {
  it('masks credentials in endpoints and error messages', () => {
    expect(maskEndpoint('mongodb://user:secret@host/db?password=abc')).not.toContain('secret');
    const message = sanitizeErrorMessage('mongodb://user:secret@host/db failed: password=hunter2');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('hunter2');
  });

  it('sanitizes artifact/file names', () => {
    expect(sanitizeName('a/b:c d')).toBe('a-b-c-d');
    expect(sanitizeName('***')).toBe('item');
  });
});

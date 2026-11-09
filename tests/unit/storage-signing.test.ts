import { describe, expect, it } from 'vitest';
import { encodeRfc3986, s3Locator, S3StorageBackend } from '../../src/core/storage/s3.js';
import { UdmtError } from '../../src/core/errors.js';
import { resolveAppPaths } from '../../src/core/paths.js';

describe('S3 request signing helpers', () => {
  it('uses RFC 3986 encoding for every non-unreserved byte', () => {
    expect(encodeRfc3986('AZaz09-_.~')).toBe('AZaz09-_.~');
    expect(encodeRfc3986('a b/c?d#e')).toBe('a%20b%2Fc%3Fd%23e');
    expect(encodeRfc3986("!*'()")).toBe('%21%2A%27%28%29');
    expect(encodeRfc3986('ü')).toBe('%C3%BC');
  });

  it('builds a sanitized s3 locator', () => {
    expect(s3Locator({ bucket: 'backups', prefix: 'udmt' }, 'run-1/file.jsonl')).toBe(
      's3://backups/udmt/run-1/file.jsonl',
    );
    expect(s3Locator({ bucket: 'backups' }, 'file.jsonl')).toBe('s3://backups/file.jsonl');
  });

  it('rejects an unsafe prefix and missing credentials at construction', () => {
    const paths = resolveAppPaths(process.cwd());
    expect(
      () =>
        new S3StorageBackend({
          id: 'bad-prefix',
          paths,
          config: { endpoint: 'https://example.invalid', bucket: 'b', prefix: 'a/../b' },
          secret: { access_key_id: 'x', secret_access_key: 'y' },
        }),
    ).toThrow(UdmtError);
    expect(
      () =>
        new S3StorageBackend({
          id: 'no-secret',
          paths,
          config: { endpoint: 'https://example.invalid', bucket: 'b' },
          secret: {},
        }),
    ).toThrow(UdmtError);
  });
});

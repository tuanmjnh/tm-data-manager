import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Db } from './db/database.js';
import type { AppPaths } from './paths.js';
import { newId, nowIso } from './utils.js';
import { UdmtError } from './errors.js';

/**
 * Secret storage (roadmap 5.2).
 *
 * Design: secrets are AES-256-GCM encrypted before touching SQLite. The master
 * key lives in a 0600 file inside the app data directory. This is the documented
 * fallback: an OS keyring (Windows Credential Manager / macOS Keychain / libsecret)
 * is the preferred backend, and `backendName` reports which one is in use so the
 * UI can warn honestly. We never fall back to plaintext.
 */
export class SecretStore {
  private readonly key: Buffer;
  readonly backendName = 'encrypted-file (AES-256-GCM)';
  readonly warning: string;

  constructor(private readonly db: Db, private readonly paths: AppPaths) {
    this.key = loadOrCreateKey(paths);
    this.warning =
      'Master key is stored in a 0600 file in the app data directory, not an OS keyring. ' +
      'Protect that file with your OS account; a keyring backend is planned.';
  }

  save(secret: Record<string, unknown>): string | null {
    const clean = Object.fromEntries(
      Object.entries(secret).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    );
    if (Object.keys(clean).length === 0) return null;
    const id = newId();
    const ciphertext = this.encrypt(JSON.stringify(clean));
    const now = nowIso();
    this.db.run(
      'INSERT INTO secrets (id, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)',
      id,
      ciphertext,
      now,
      now,
    );
    return `localvault:${id}`;
  }

  replace(credentialRef: string | null, secret: Record<string, unknown>): string | null {
    const clean = Object.fromEntries(
      Object.entries(secret).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    );
    if (Object.keys(clean).length === 0) {
      if (credentialRef) this.delete(credentialRef);
      return null;
    }
    if (credentialRef) {
      const id = parseRef(credentialRef);
      this.db.run(
        'UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE id = ?',
        this.encrypt(JSON.stringify(clean)),
        nowIso(),
        id,
      );
      return credentialRef;
    }
    return this.save(clean);
  }

  load(credentialRef: string | null | undefined): Record<string, unknown> {
    if (!credentialRef) return {};
    const id = parseRef(credentialRef);
    const row = this.db.get<{ ciphertext: string }>('SELECT ciphertext FROM secrets WHERE id = ?', id);
    if (!row) {
      throw new UdmtError('NOT_FOUND', 'Connection secret is missing from the local vault. Re-enter the credential.', {
        details: { credential_ref: credentialRef },
      });
    }
    try {
      return JSON.parse(this.decrypt(row.ciphertext)) as Record<string, unknown>;
    } catch {
      throw new UdmtError(
        'PRECONDITION_FAILED',
        'Connection secret could not be decrypted (wrong or rotated master key). Re-enter the credential.',
      );
    }
  }

  delete(credentialRef: string): void {
    this.db.run('DELETE FROM secrets WHERE id = ?', parseRef(credentialRef));
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') });
  }

  private decrypt(payload: string): string {
    const parsed = JSON.parse(payload) as { v: number; iv: string; tag: string; data: string };
    if (parsed.v !== 1) throw new UdmtError('PRECONDITION_FAILED', 'Unsupported secret payload version.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
  }
}

function parseRef(ref: string): string {
  if (!ref.startsWith('localvault:')) {
    throw new UdmtError('INVALID_CONFIG', 'Unsupported credential reference. Expected localvault:<id>.');
  }
  return ref.slice('localvault:'.length);
}

function loadOrCreateKey(paths: AppPaths): Buffer {
  if (existsSync(paths.secretsKeyPath)) {
    const raw = readFileSync(paths.secretsKeyPath);
    if (raw.length !== 32) {
      throw new UdmtError('PRECONDITION_FAILED', `Secret key file is corrupt: ${paths.secretsKeyPath}`);
    }
    return raw;
  }
  const key = randomBytes(32);
  writeFileSync(paths.secretsKeyPath, key, { mode: 0o600 });
  try {
    chmodSync(paths.secretsKeyPath, 0o600);
  } catch {
    /* Windows ACLs: best effort only */
  }
  return key;
}

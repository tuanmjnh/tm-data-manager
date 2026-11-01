import { existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { UdmtError } from './errors.js';

/**
 * Resolves the on-disk locations for metadata, artifacts and logs.
 * `UDMT_DATA_DIR` overrides everything (used by tests and portable installs).
 */
export interface AppPaths {
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  logsDir: string;
  tempDir: string;
  secretsKeyPath: string;
}

export function resolveAppPaths(dataDirOverride?: string): AppPaths {
  const base = dataDirOverride
    ? resolve(expandHome(dataDirOverride))
    : process.env.UDMT_DATA_DIR
      ? resolve(expandHome(process.env.UDMT_DATA_DIR))
      : defaultDataDir();

  return {
    dataDir: base,
    dbPath: join(base, 'udmt.db'),
    artifactsDir: join(base, 'artifacts'),
    logsDir: join(base, 'logs'),
    tempDir: join(base, 'tmp'),
    secretsKeyPath: join(base, 'secrets.key'),
  };
}

function defaultDataDir(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'udmt');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'udmt');
  }
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'udmt');
}

export function ensureAppDirs(paths: AppPaths): void {
  for (const dir of [paths.dataDir, paths.artifactsDir, paths.logsDir, paths.tempDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}

function isInside(parent: string, child: string): boolean {
  const a = resolve(parent);
  const b = resolve(child);
  return a === b || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * Validates a user-supplied filesystem path before the app writes to it.
 * Rejects traversal outside the managed roots and symlinked escape paths
 * (roadmap 9.4).
 */
export function assertSafePath(target: string, allowedRoots: string[], opts: { mustExist?: boolean } = {}): string {
  const raw = expandHome(target);
  if (raw.includes('\0')) {
    throw new UdmtError('PATH_UNSAFE', 'Path contains a NUL byte.');
  }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
  const allowed = allowedRoots.map((root) => resolve(root));
  if (!allowed.some((root) => isInside(root, absolute))) {
    throw new UdmtError('PATH_UNSAFE', `Path is outside the managed roots: ${absolute}`, {
      details: { allowed_roots: allowed },
    });
  }

  // Resolve the closest existing ancestor to catch symlink escapes.
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..');
    if (parent === probe) break;
    probe = parent;
  }
  if (existsSync(probe)) {
    const realProbe = realpathSync(probe);
    const realAllowed = allowed.some((root) => existsSync(root) && isInside(realpathSync(root), realProbe));
    if (!realAllowed) {
      throw new UdmtError('PATH_UNSAFE', `Path resolves through an unmanaged location: ${absolute}`);
    }
  }

  if (opts.mustExist) {
    if (!existsSync(absolute)) {
      throw new UdmtError('NOT_FOUND', `Path does not exist: ${absolute}`);
    }
    if (!statSync(absolute).isFile() && !statSync(absolute).isDirectory()) {
      throw new UdmtError('PATH_UNSAFE', `Path is not a regular file or directory: ${absolute}`);
    }
  }
  return absolute;
}

/** Path segments must not contain separators or traversal sequences. */
export function assertSafeSegment(segment: string, label = 'segment'): string {
  if (!/^[A-Za-z0-9._@-]+$/.test(segment) || segment === '.' || segment === '..') {
    throw new UdmtError('PATH_UNSAFE', `Invalid ${label}: ${segment}`);
  }
  return segment;
}

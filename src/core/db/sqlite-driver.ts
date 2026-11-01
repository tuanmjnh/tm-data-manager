import { createRequire } from 'node:module';

/**
 * Loads `node:sqlite` through createRequire.
 *
 * The driver is only available from Node 22.5 and Vite's builtin list does not
 * always know it, so a static `import ... from 'node:sqlite'` breaks test
 * tooling. Node itself resolves this lazily at runtime.
 */
// `import.meta.url` disappears when the CLI is bundled to a single CommonJS file
// for the desktop build, so fall back to the executable path there.
const require = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url,
);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSyncInstance = InstanceType<typeof sqlite.DatabaseSync>;

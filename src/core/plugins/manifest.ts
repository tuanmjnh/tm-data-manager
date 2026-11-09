import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { UdmtError } from '../errors.js';
import { PLUGIN_PROTOCOL_VERSION, PLUGIN_PERMISSIONS, type PluginManifest } from '../types.js';

const CAPABILITY_IDS = [
  'test_connection',
  'discover_resources',
  'read_data',
  'write_data',
  'schema_read',
  'schema_write',
  'bulk_write',
  'transactions',
  'consistent_snapshot',
  'query',
  'native_backup',
  'native_restore',
] as const;

const ConfigFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'password', 'number', 'boolean', 'select', 'path']),
  required: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

const ManifestSchema = z.object({
  manifest_version: z.literal(1),
  id: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, 'id must be lowercase letters/digits/._- and start/end alphanumeric'),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  protocol: z.string().min(1),
  description: z.string().max(500).optional(),
  homepage: z.string().max(300).optional(),
  runtime: z.object({
    command: z.string().min(1).max(1000),
    args: z.array(z.string().max(1000)).max(50).optional(),
    env: z.record(z.string().max(2000)).optional(),
    cwd: z.string().max(1000).optional(),
  }),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS as [string, ...string[]])).max(20),
  provider: z.object({
    display_name: z.string().min(1).max(120),
    version: z.string().max(40).optional(),
    capabilities: z.array(z.enum(CAPABILITY_IDS)).min(1),
    config_fields: z.array(ConfigFieldSchema).max(100).optional(),
    secret_fields: z.array(z.string().max(80)).max(50).optional(),
    service_profiles: z
      .array(z.object({ id: z.string().min(1), display_name: z.string().min(1), notes: z.array(z.string()).optional() }))
      .max(50)
      .optional(),
  }),
});

export const PLUGIN_MANIFEST_FILENAMES = ['udmt-plugin.json', 'manifest.json'];

export function parsePluginManifest(raw: unknown, source: string): PluginManifest {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new UdmtError('VALIDATION_FAILED', `Plugin manifest is invalid (${source}): ${detail}`);
  }
  const manifest = parsed.data as PluginManifest;
  if (manifest.protocol !== PLUGIN_PROTOCOL_VERSION) {
    throw new UdmtError(
      'CAPABILITY_UNSUPPORTED',
      `Plugin "${manifest.id}" speaks protocol "${manifest.protocol}" but this build supports "${PLUGIN_PROTOCOL_VERSION}".`,
    );
  }
  return manifest;
}

export function manifestPathFor(dir: string): string {
  for (const name of PLUGIN_MANIFEST_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new UdmtError('NOT_FOUND', `No plugin manifest (${PLUGIN_MANIFEST_FILENAMES.join(' or ')}) found in ${dir}`);
}

export function readPluginManifest(dirOrFile: string): { manifest: PluginManifest; installPath: string; manifestPath: string } {
  const absolute = resolve(dirOrFile);
  if (!existsSync(absolute)) throw new UdmtError('NOT_FOUND', `Plugin path does not exist: ${absolute}`);
  const file = absolute.toLowerCase().endsWith('.json') ? absolute : manifestPathFor(absolute);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UdmtError('VALIDATION_FAILED', `Could not read plugin manifest ${file}: ${(error as Error).message}`);
  }
  return { manifest: parsePluginManifest(raw, file), installPath: file === absolute ? resolve(file, '..') : absolute, manifestPath: file };
}

/** Resolves a manifest-relative command/arg without a shell. */
export function resolveRuntimePath(baseDir: string, value: string): string {
  if (value.startsWith('./') || value.startsWith('.\\') || value.startsWith('../') || value.startsWith('..\\')) {
    return resolve(baseDir, value);
  }
  return isAbsolute(value) ? value : value;
}

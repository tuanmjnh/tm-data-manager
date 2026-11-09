#!/usr/bin/env node
import { Command, Option } from 'commander';
import { hostname } from 'node:os';
import { UdmtApp } from '../core/service.js';
import { UdmtError, toUdmtError } from '../core/errors.js';
import { APP_VERSION } from '../core/utils.js';
import { WorkerRuntime } from '../core/worker.js';
import { startApiServer } from '../api/server.js';
import type { ExportFormat, ImportRequest, OperationRun, PluginPermission, SyncFieldMapping, SyncLoadMode, SyncOptions } from '../core/types.js';
import {
  EXIT,
  RESET,
  exitCodeFor,
  formatBytes,
  formatDuration,
  logLine,
  printJson,
  printTable,
  readStdin,
  statusColor,
} from './output.js';

/** Default loopback port for the GUI/API facade. */
const DEFAULT_PORT = 4004;

const program = new Command('udmt')
  .description('Universal Data Management Tool — export/import data across sources')
  .version(APP_VERSION)
  .option('--json', 'machine-readable JSON output')
  .option('--quiet', 'suppress progress output')
  .option('--verbose', 'print operation logs to stderr')
  .option('--data-dir <path>', 'override the app data directory')
  .option('--non-interactive', 'never prompt; fail if confirmation is required');

const globalOptions = () => program.opts<{
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  dataDir?: string;
  nonInteractive?: boolean;
}>();

function openApp(): UdmtApp {
  const opts = globalOptions();
  return new UdmtApp(opts.dataDir ? { dataDir: opts.dataDir } : {});
}

/**
 * A second `udmt gui` is usually not a failure: the GUI may already be open.
 * Probe the loopback port so we can say so instead of printing a raw EADDRINUSE.
 */
async function probeRunningServer(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { app?: string; version?: string };
    if (body?.app !== 'udmt') return null;
    return `http://127.0.0.1:${port}/`;
  } catch {
    return null;
  }
}

async function withApp<T>(fn: (app: UdmtApp) => Promise<T> | T): Promise<T> {
  const app = openApp();
  try {
    return await fn(app);
  } finally {
    app.close();
  }
}

async function main(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const udmt = toUdmtError(error, 'INTERNAL_ERROR');
    const opts = globalOptions();
    if (opts.json) {
      printJson({ error: udmt.toJSON() });
    } else {
      process.stderr.write(`error [${udmt.code}]: ${udmt.message}\n`);
      if (udmt.details && opts.verbose) process.stderr.write(`details: ${JSON.stringify(udmt.details, null, 2)}\n`);
    }
    process.exit(exitCodeFor(udmt));
  }
}

/** Polls the durable run state and renders progress on stderr. */
async function watchRun(app: UdmtApp, runId: string): Promise<OperationRun> {
  const opts = globalOptions();
  const showProgress = !opts.quiet && !opts.json && process.stderr.isTTY;
  let lastLogSequence = 0;
  for (;;) {
    const run = app.store.requireRun(runId);
    if (opts.verbose) {
      for (const entry of app.store.listLogs(runId, { afterSequence: lastLogSequence, limit: 50 })) {
        lastLogSequence = entry.sequence;
        process.stderr.write(`  [${entry.level}] ${entry.message}\n`);
      }
    }
    const finished = ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(run.status);
    if (showProgress) {
      const progress = run.progress;
      const percent = progress ? String(Math.round(progress.percent)).padStart(3) : '  -';
      const rows = progress?.rows_written ?? progress?.rows_read;
      process.stderr.write(
        `\r${statusColor(run.status)}●${RESET} ${run.operation_type} ${run.status.padEnd(20)} ${percent}%${rows ? ` rows=${rows}` : ''}`,
      );
    }
    if (finished) {
      if (showProgress) process.stderr.write('\n');
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function assertSuccess(run: OperationRun): OperationRun {
  if (!['completed', 'completed_with_warnings'].includes(run.status)) {
    throw new UdmtError(
      (run.error_code as UdmtError['code']) ?? 'OPERATION_FAILED',
      run.error_message_safe ?? `Run finished with status ${run.status}`,
      { details: { run_id: run.id } },
    );
  }
  return run;
}

function parseKeyColumns(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function connectionConfigFromFlags(provider: string, options: Record<string, unknown>): Record<string, unknown> {
  if (typeof options.config === 'string') {
    const parsed = JSON.parse(options.config) as Record<string, unknown>;
    return parsed;
  }
  switch (provider) {
    case 'sqlite':
      if (!options.path) throw new UdmtError('INVALID_INPUT', 'SQLite needs --path <file> or --config <json>.');
      return { path: String(options.path), read_only: options.readOnly !== false };
    case 'rest':
      throw new UdmtError('INVALID_INPUT', 'REST needs --config <json> with base_url; see docs/provider-contract/rest-connector.md.');
    case 'mongodb':
      if (!options.uri) throw new UdmtError('INVALID_INPUT', 'MongoDB needs --uri <connection string>.');
      return {
        uri: String(options.uri),
        ...(options.database ? { database: String(options.database) } : {}),
      };
    case 'postgresql':
    case 'mysql':
      if (options.url) return { url: String(options.url) };
      if (!options.host || !options.database || !options.user) {
        throw new UdmtError('INVALID_INPUT', `${provider} needs --host, --database, --user (or --url).`);
      }
      return {
        host: String(options.host),
        port: options.port ? Number(options.port) : provider === 'mysql' ? 3306 : 5432,
        database: String(options.database),
        user: String(options.user),
        ssl: String(options.ssl ?? 'require'),
      };
    default:
      throw new UdmtError('CAPABILITY_UNSUPPORTED', `Unknown provider: ${provider}`);
  }
}

async function resolvePassword(options: Record<string, unknown>): Promise<string | undefined> {
  if (typeof options.passwordStdin === 'boolean' && options.passwordStdin) {
    const value = await readStdin();
    return value || undefined;
  }
  if (typeof options.password === 'string' && options.password) return options.password;
  return undefined;
}

// ------------------------------------------------------------------ providers
program
  .command('provider')
  .description('Inspect built-in providers and capabilities')
  .addCommand(
    new Command('list')
      .description('List providers')
      .action(async () => {
        await withApp((app) => {
          const providers = app.providers();
          if (globalOptions().json) return printJson(providers);
          printTable(
            providers.map((provider) => ({
              provider: provider.provider_id,
              name: provider.display_name,
              version: provider.version,
              capabilities: provider.capabilities.filter((cap) => cap.supported).map((cap) => cap.id).join(','),
              profiles: provider.service_profiles.map((profile) => profile.id).join(',') || '—',
            })),
            ['provider', 'name', 'version', 'capabilities', 'profiles'],
          );
        });
      }),
  )
  .addCommand(
    new Command('inspect')
      .argument('<provider_id>')
      .description('Show provider capabilities and config fields')
      .action(async (providerId: string) => {
        await withApp((app) => {
          const descriptor = app.provider(providerId);
          if (globalOptions().json) return printJson(descriptor);
          process.stdout.write(`${descriptor.display_name} (${descriptor.provider_id}) v${descriptor.version}\n`);
          process.stdout.write('\nCapabilities:\n');
          for (const capability of descriptor.capabilities) {
            process.stdout.write(`  ${capability.supported ? '✓' : '✗'} ${capability.id}\n`);
          }
          if (descriptor.service_profiles.length > 0) {
            process.stdout.write('\nService profiles:\n');
            for (const profile of descriptor.service_profiles) {
              process.stdout.write(`  ${profile.id} — ${profile.display_name}\n`);
            }
          }
          process.stdout.write('\nConfig fields:\n');
          for (const field of descriptor.config_fields) {
            process.stdout.write(`  ${field.name} (${field.type})${field.required ? ' required' : ''}\n`);
          }
        });
      }),
  );

// ------------------------------------------------------------------ connections
const connection = program.command('connection').description('Manage connections');

connection
  .command('list')
  .description('List connections')
  .action(async () => {
    await withApp((app) => {
      const rows = app.listConnections();
      if (globalOptions().json) return printJson(rows);
      printTable(
        rows.map((row) => ({
          name: row.name,
          provider: row.provider_id,
          profile: row.service_profile ?? '—',
          env: row.environment,
          endpoint: row.endpoint_hint ?? '—',
          last_test: row.last_test_status ? `${row.last_test_status} @ ${row.last_tested_at}` : 'never',
          active: row.is_active,
        })),
        ['name', 'provider', 'profile', 'env', 'endpoint', 'last_test', 'active'],
      );
    });
  });

connection
  .command('add')
  .description('Add a connection (credentials go to the encrypted local vault)')
  .requiredOption('--name <name>')
  .requiredOption('--provider <provider_id>')
  .option('--profile <service_profile>')
  .option('--env <environment>', 'local|development|staging|production|custom', 'local')
  .option('--description <text>')
  .option('--config <json>', 'raw config JSON')
  .option('--path <file>', 'sqlite database file')
  .option('--uri <uri>', 'mongodb connection string')
  .option('--host <host>')
  .option('--port <port>')
  .option('--database <name>')
  .option('--user <name>')
  .option('--password <password>', 'prefer --password-stdin to keep it out of shell history')
  .option('--password-stdin', 'read the password from stdin')
  .option('--token <token>', 'REST bearer token (stored in the vault)')
  .option('--api-key <key>', 'REST API key (stored in the vault)')
  .option('--ssl <mode>', 'require|verify-full|disable')
  .option('--url <url>', 'postgres/mysql connection URL (password is moved to the vault)')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      const password = await resolvePassword(options);
      await withApp((app) => {
        const provider = String(options.provider);
        const config: Record<string, unknown> = connectionConfigFromFlags(provider, options);
        // REST credentials are passed inline so normalizeInlineSecret moves them to the vault.
        if (provider === 'rest') {
          if (typeof options.token === 'string' && options.token) config.bearer_token = options.token;
          else if (typeof options.apiKey === 'string' && options.apiKey) config.api_key = options.apiKey;
          else if (password) config.bearer_token = password;
          if (typeof options.user === 'string' && options.user && !config.username) config.username = options.user;
        }
        const created = app.createConnection({
          name: String(options.name),
          provider_id: provider,
          service_profile: (options.profile as string | undefined) ?? null,
          config,
          secret: password ? { password } : {},
          environment: String(options.env) as never,
          description: (options.description as string | undefined) ?? null,
        });
        if (globalOptions().json) return printJson(created);
        process.stdout.write(`Created connection "${created.name}" (${created.provider_id}).\n`);
        process.stdout.write(`Endpoint: ${created.endpoint_hint ?? '—'}\n`);
      });
    });
  });

connection
  .command('inspect')
  .argument('<connection>')
  .description('Show a connection (secrets are never printed)')
  .action(async (name: string) => {
    await withApp((app) => {
      const found = app.getConnection(name);
      if (globalOptions().json) return printJson(found);
      process.stdout.write(`${found.name} — ${found.provider_id}${found.service_profile ? ` / ${found.service_profile}` : ''}\n`);
      process.stdout.write(`environment: ${found.environment}\n`);
      process.stdout.write(`endpoint:    ${found.endpoint_hint ?? '—'}\n`);
      process.stdout.write(`active:      ${found.is_active ? 'yes' : 'no'}\n`);
      process.stdout.write(`last test:   ${found.last_test_status ?? 'never'} ${found.last_tested_at ?? ''}\n`);
      process.stdout.write(`credential:  ${found.credential_ref ? 'stored encrypted' : 'none'}\n`);
      process.stdout.write(`config:      ${JSON.stringify(found.config, null, 2)}\n`);
    });
  });

connection
  .command('test')
  .argument('<connection>')
  .description('Test connection, authentication and permissions')
  .action(async (name: string) => {
    await main(async () => {
      await withApp(async (app) => {
        const result = await app.testConnection(name);
        if (globalOptions().json) return printJson(result);
        process.stdout.write(`${result.success ? 'OK' : 'FAILED'} ${name} (${result.latency_ms}ms)\n`);
        if (result.server_version) process.stdout.write(`server: ${result.server_version}\n`);
        for (const line of result.diagnostics) process.stdout.write(`  - ${line}\n`);
        if (!result.success) throw new UdmtError('CONNECTION_FAILED', result.error?.message ?? 'Connection test failed');
      });
    });
  });

connection
  .command('discover')
  .argument('<connection>')
  .description('List resources (databases, schemas, tables, collections)')
  .action(async (name: string) => {
    await main(async () => {
      await withApp(async (app) => {
        const resources = await app.discoverResources(name);
        if (globalOptions().json) return printJson(resources);
        printTable(resources.map((resource) => ({
          type: resource.type,
          resource: resource.id,
        })), ['type', 'resource']);
      });
    });
  });

connection
  .command('schema')
  .argument('<connection>')
  .argument('<resource>')
  .description('Show the schema of a resource')
  .action(async (name: string, resource: string) => {
    await main(async () => {
      await withApp(async (app) => {
        const schema = await app.resourceSchema(name, resource);
        if (globalOptions().json) return printJson(schema);
        process.stdout.write(`${schema.resource} (${schema.source}${schema.rowCountEstimate ? `, ~${schema.rowCountEstimate} rows` : ''})\n`);
        printTable(schema.columns.map((column) => ({
          column: column.name,
          type: column.type,
          native: column.nativeType ?? '—',
          nullable: column.nullable ?? true,
          pk: column.primaryKey ?? false,
        })), ['column', 'type', 'native', 'nullable', 'pk']);
      });
    });
  });

connection
  .command('update')
  .argument('<connection>')
  .description('Update name, config or credential')
  .option('--name <name>')
  .option('--env <environment>')
  .option('--description <text>')
  .option('--config <json>')
  .option('--path <file>')
  .option('--uri <uri>')
  .option('--host <host>')
  .option('--port <port>')
  .option('--database <name>')
  .option('--user <name>')
  .option('--password <password>')
  .option('--password-stdin')
  .option('--ssl <mode>')
  .option('--url <url>')
  .option('--disable', 'disable the connection')
  .option('--enable', 'enable the connection')
  .action(async (name: string, options: Record<string, unknown>) => {
    await main(async () => {
      const password = await resolvePassword(options);
      await withApp((app) => {
        const existing = app.getConnection(name);
        const hasConfigFlags = ['config', 'path', 'uri', 'host', 'database', 'user', 'url', 'port', 'ssl'].some(
          (key) => options[key] !== undefined,
        );
        const patch: Record<string, unknown> = {};
        if (options.name) patch.name = String(options.name);
        if (options.env) patch.environment = String(options.env);
        if (options.description) patch.description = String(options.description);
        if (options.disable) patch.is_active = false;
        if (options.enable) patch.is_active = true;
        if (hasConfigFlags) {
          const nextConfig = connectionConfigFromFlags(existing.provider_id, { ...existing.config, ...options });
          patch.config = nextConfig;
        }
        if (password) patch.secret = { password };
        const updated = app.updateConnection(existing.id, patch as never);
        if (globalOptions().json) return printJson(updated);
        process.stdout.write(`Updated connection "${updated.name}".\n`);
      });
    });
  });

connection
  .command('remove')
  .argument('<connection>')
  .description('Delete a connection and its stored secret')
  .action(async (name: string) => {
    await main(async () => {
      await withApp((app) => {
        app.deleteConnection(name);
        process.stdout.write(`Deleted connection "${name}".\n`);
      });
    });
  });

// ------------------------------------------------------------------ export
program
  .command('export')
  .description('Export a resource to CSV/JSONL/JSON')
  .requiredOption('--conn <connection>')
  .requiredOption('--resource <resource>', 'e.g. main.users or app.customers')
  .addOption(new Option('--format <format>', 'output format').choices(['jsonl', 'csv', 'json', 'xml', 'xlsx']).default('jsonl'))
  .addOption(new Option('--compression <mode>', 'none|gzip').choices(['none', 'gzip']).default('none'))
  .option('--out <directory>', 'output directory (defaults to the managed artifacts root)')
  .option('--limit <n>', 'maximum rows to export', (value) => Number(value))
  .option('--batch-size <n>', 'rows per batch', (value) => Number(value))
  .option('--columns <list>', 'comma-separated column subset')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      await withApp(async (app) => {
        const started = app.startExport({
          connection_id: String(options.conn),
          resource: String(options.resource),
          format: options.format as ExportFormat,
          compression: options.compression as 'none' | 'gzip',
          ...(options.out ? { output_dir: String(options.out) } : {}),
          ...(options.limit ? { limit: Number(options.limit) } : {}),
          ...(options.batchSize ? { batch_size: Number(options.batchSize) } : {}),
          ...(options.columns ? { columns: parseKeyColumns(String(options.columns)) } : {}),
        });
        const run = assertSuccess(await watchRun(app, started.run.id));
        const artifact = app.getArtifact(String(run.result?.artifact_id));
        if (globalOptions().json) return printJson({ run, artifact });
        process.stdout.write(`Export completed.\n`);
        process.stdout.write(`  artifact: ${artifact.id}\n`);
        process.stdout.write(`  file:     ${artifact.absolute_path}\n`);
        process.stdout.write(`  rows:     ${artifact.manifest.row_count}\n`);
        process.stdout.write(`  size:     ${formatBytes(artifact.size_bytes)}\n`);
        process.stdout.write(`  sha256:   ${artifact.checksum_value}\n`);
        process.stdout.write(`  verified: ${artifact.verification_status}\n`);
        process.stdout.write(`Import it with: udmt import --conn <target> --resource <resource> --artifact ${artifact.id}\n`);
      });
    });
  });

// ------------------------------------------------------------------ import
program
  .command('import')
  .description('Import data from an artifact or a local file')
  .requiredOption('--conn <connection>', 'target connection')
  .requiredOption('--resource <resource>', 'target resource, e.g. main.users')
  .option('--from <path>', 'source CSV/JSONL/JSON file')
  .option('--artifact <id>', 'source artifact id')
  .addOption(new Option('--format <format>', 'source format when importing a file').choices(['jsonl', 'csv', 'json', 'xml', 'xlsx']))
  .addOption(new Option('--mode <mode>', 'load mode').choices(['append', 'upsert', 'truncate_and_load']).default('append'))
  .option('--key-columns <list>', 'upsert key columns (comma separated)')
  .option('--batch-size <n>', 'rows per batch', (value) => Number(value))
  .option('--dry-run', 'validate and sample without writing')
  .option('--confirm <connection_name>', 'required for destructive or production targets')
  .option('--no-create', 'do not create the target resource automatically')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      if (!options.from && !options.artifact) {
        throw new UdmtError('INVALID_INPUT', 'Import needs --from <file> or --artifact <id>.');
      }
      await withApp(async (app) => {
        const request: ImportRequest = {
          connection_id: String(options.conn),
          resource: String(options.resource),
          source: options.artifact ? { artifact_id: String(options.artifact) } : { path: String(options.from) },
          mode: options.mode as ImportRequest['mode'],
          ...(options.format ? { format: options.format as ExportFormat } : {}),
          ...(options.keyColumns ? { key_columns: parseKeyColumns(String(options.keyColumns)) } : {}),
          ...(options.batchSize ? { batch_size: Number(options.batchSize) } : {}),
          ...(options.dryRun ? { dry_run: true } : {}),
          ...(options.confirm ? { confirm: String(options.confirm) } : {}),
          create_resource: options.create !== false,
        };
        const started = app.startImport(request);
        const run = assertSuccess(await watchRun(app, started.run.id));
        if (globalOptions().json) return printJson(run);
        const result = run.result ?? {};
        if (result.dry_run) {
          process.stdout.write(`Dry run finished — nothing was written.\n`);
        } else {
          process.stdout.write(`Import completed.\n`);
        }
        process.stdout.write(`  run:      ${run.id}\n`);
        process.stdout.write(`  read:     ${result.rows_read ?? result.rows_sampled ?? 0}\n`);
        if (!result.dry_run) process.stdout.write(`  written:  ${result.rows_written ?? 0}\n`);
        process.stdout.write(`  mode:     ${String(result.mode ?? request.mode)}\n`);
        const warnings = (result.warnings as string[] | undefined) ?? [];
        if (warnings.length > 0) {
          process.stdout.write(`  warnings:\n`);
          for (const warning of warnings.slice(0, 20)) process.stdout.write(`    - ${warning}\n`);
        }
      });
    });
  });

// ------------------------------------------------------------------ operations
const operation = program.command('operation').description('Inspect and control operations');

operation
  .command('list')
  .description('List recent runs')
  .option('--limit <n>', 'maximum rows', (value) => Number(value), 30)
  .option('--status <status>')
  .option('--type <type>')
  .action(async (options: Record<string, unknown>) => {
    await withApp((app) => {
      const runs = app.listRuns({
        limit: Number(options.limit ?? 30),
        ...(options.status ? { status: String(options.status) } : {}),
        ...(options.type ? { operation_type: String(options.type) } : {}),
      });
      if (globalOptions().json) return printJson(runs);
      printTable(
        runs.map((run) => ({
          id: run.id.slice(0, 8),
          type: run.operation_type,
          status: run.status,
          resource: run.resource ?? '—',
          source: run.source_label ?? '—',
          target: run.target_label ?? '—',
          progress: run.progress ? `${Math.round(run.progress.percent)}%` : '—',
          created: run.created_at,
        })),
        ['id', 'type', 'status', 'resource', 'source', 'target', 'progress', 'created'],
      );
    });
  });

operation
  .command('status')
  .argument('<run_id>')
  .description('Show a run with progress and result')
  .action(async (runId: string) => {
    await main(async () => {
      await withApp((app) => {
        const run = app.getRun(runId);
        if (globalOptions().json) return printJson(run);
        process.stdout.write(`run ${run.id}\n`);
        process.stdout.write(`  type:     ${run.operation_type}\n`);
        process.stdout.write(`  status:   ${statusColor(run.status)}${run.status}${RESET}\n`);
        process.stdout.write(`  resource: ${run.resource ?? '—'}\n`);
        if (run.progress) process.stdout.write(`  progress: ${Math.round(run.progress.percent)}% (${run.progress.stage})\n`);
        if (run.started_at) process.stdout.write(`  started:  ${run.started_at}\n`);
        if (run.finished_at) process.stdout.write(`  finished: ${run.finished_at}\n`);
        if (run.error_message_safe) process.stdout.write(`  error:    ${run.error_code}: ${run.error_message_safe}\n`);
        if (run.result) process.stdout.write(`  result:   ${JSON.stringify(run.result, null, 2)}\n`);
      });
    });
  });

operation
  .command('logs')
  .argument('<run_id>')
  .description('Print the operation log')
  .option('--limit <n>', 'maximum lines', (value) => Number(value), 200)
  .action(async (runId: string, options: Record<string, unknown>) => {
    await withApp((app) => {
      const logs = app.runLogs(runId, { limit: Number(options.limit ?? 200) });
      if (globalOptions().json) return printJson(logs);
      for (const entry of logs) {
        process.stdout.write(`${entry.created_at} [${entry.level}] ${entry.message}\n`);
      }
    });
  });

operation
  .command('cancel')
  .argument('<run_id>')
  .description('Request cancellation of a run')
  .action(async (runId: string) => {
    await withApp((app) => {
      const run = app.cancelRun(app.getRun(runId).id);
      if (globalOptions().json) return printJson(run);
      process.stdout.write(`Cancel requested for ${run.id} (status: ${run.status}).\n`);
      if (!app.engine.isRunningLocally(run.id)) {
        process.stdout.write('Note: no local process is executing this run; the worker will observe the request.\n');
      }
    });
  });

// ------------------------------------------------------------------ artifacts
const artifact = program.command('artifact').description('Manage export artifacts');

artifact
  .command('list')
  .description('List artifacts')
  .option('--limit <n>', 'maximum rows', (value) => Number(value), 50)
  .action(async (options: Record<string, unknown>) => {
    await withApp((app) => {
      const artifacts = app.listArtifacts({ limit: Number(options.limit ?? 50) });
      if (globalOptions().json) return printJson(artifacts);
      printTable(
        artifacts.map((item) => ({
          id: item.id.slice(0, 8),
          created: item.created_at,
          provider: item.provider_id ?? '—',
          resource: item.manifest.resource ?? '—',
          rows: item.manifest.row_count,
          size: formatBytes(item.size_bytes),
          verified: item.verification_status,
          pinned: item.pinned,
        })),
        ['id', 'created', 'provider', 'resource', 'rows', 'size', 'verified', 'pinned'],
      );
    });
  });

artifact
  .command('inspect')
  .argument('<artifact_id>')
  .description('Show artifact manifest')
  .action(async (artifactId: string) => {
    await main(async () => {
      await withApp((app) => {
        const found = app.getArtifact(artifactId);
        if (globalOptions().json) return printJson(found);
        process.stdout.write(JSON.stringify(found.manifest, null, 2));
        process.stdout.write(`\nfile: ${found.absolute_path}\n`);
      });
    });
  });

artifact
  .command('verify')
  .argument('<artifact_id>')
  .description('Recompute the checksum and verify the artifact')
  .action(async (artifactId: string) => {
    await main(async () => {
      await withApp(async (app) => {
        const result = await app.verifyArtifact(artifactId);
        if (globalOptions().json) return printJson(result);
        process.stdout.write(`${result.valid ? 'OK' : 'FAILED'} ${artifactId}\n`);
        process.stdout.write(`  run: ${result.run.id}\n`);
        if (!result.valid) throw new UdmtError('VALIDATION_FAILED', 'Artifact verification failed');
      });
    });
  });

artifact
  .command('pin')
  .argument('<artifact_id>')
  .description('Pin an artifact so retention never deletes it')
  .action(async (artifactId: string) => {
    await withApp((app) => {
      const updated = app.pinArtifact(artifactId, true);
      process.stdout.write(`Pinned ${updated.id}.\n`);
    });
  });

artifact
  .command('unpin')
  .argument('<artifact_id>')
  .action(async (artifactId: string) => {
    await withApp((app) => {
      const updated = app.pinArtifact(artifactId, false);
      process.stdout.write(`Unpinned ${updated.id}.\n`);
    });
  });

artifact
  .command('delete')
  .argument('<artifact_id>')
  .description('Delete an artifact record and its file')
  .action(async (artifactId: string) => {
    await main(async () => {
      await withApp(async (app) => {
        await app.deleteArtifact(artifactId);
        process.stdout.write(`Deleted artifact ${artifactId}.\n`);
      });
    });
  });

artifact
  .command('prune')
  .description('Apply a retention policy to artifacts')
  .requiredOption('--older-than-days <n>', 'delete artifacts older than N days', (value) => Number(value))
  .option('--keep-last <n>', 'always keep the N newest artifacts per provider', (value) => Number(value), 3)
  .option('--dry-run', 'report what would be deleted')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      await withApp(async (app) => {
        const result = await app.cleanupArtifacts({
          older_than_days: Number(options.olderThanDays),
          keep_last: Number(options.keepLast ?? 3),
          dry_run: Boolean(options.dryRun),
        });
        if (globalOptions().json) return printJson(result);
        process.stdout.write(
          `${options.dryRun ? 'Would delete' : 'Deleted'} ${result.deleted.length} artifacts, kept ${result.kept}.\n`,
        );
        for (const item of result.deleted) {
          process.stdout.write(`  ${item.id} ${item.manifest.resource ?? ''} ${formatBytes(item.size_bytes)}\n`);
        }
        for (const reason of result.skipped_reasons) process.stdout.write(`  skipped: ${reason}\n`);
      });
    });
  });

// ------------------------------------------------------------------ storage
const storage = program.command('storage').description('Manage artifact storage backends');

storage
  .command('list')
  .description('List storage backends')
  .action(async () => {
    await withApp((app) => {
      const rows = app.listStorageBackends();
      if (globalOptions().json) return printJson(rows);
      printTable(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.backend_type,
          default: row.is_default,
          endpoint: row.endpoint_hint ?? '—',
          last_test: row.last_test_status ? `${row.last_test_status} @ ${row.last_tested_at}` : 'never',
        })),
        ['id', 'name', 'type', 'default', 'endpoint', 'last_test'],
      );
    });
  });

storage
  .command('inspect')
  .argument('<backend>')
  .description('Show a storage backend (secrets are never printed)')
  .action(async (idOrName: string) => {
    await withApp((app) => {
      const row = app.getStorageBackend(idOrName);
      if (globalOptions().json) return printJson(row);
      process.stdout.write(`${row.name} (${row.id}) — ${row.backend_type}\n`);
      process.stdout.write(`default:  ${row.is_default ? 'yes' : 'no'}\n`);
      process.stdout.write(`endpoint: ${row.endpoint_hint ?? '—'}\n`);
      process.stdout.write(`credential: ${row.credential_ref ? 'stored encrypted' : 'none'}\n`);
      process.stdout.write(`last test:  ${row.last_test_status ?? 'never'} ${row.last_tested_at ?? ''}\n`);
      process.stdout.write(`config:   ${JSON.stringify(row.config, null, 2)}\n`);
    });
  });

storage
  .command('add')
  .description('Add a local or S3-compatible storage backend')
  .requiredOption('--name <name>')
  .addOption(new Option('--type <type>', 'backend type').choices(['local', 's3']).default('local'))
  .option('--root <dir>', 'local backend root (managed under the artifacts directory by default)')
  .option('--endpoint <url>', 'S3 endpoint URL')
  .option('--region <region>', 'S3 region', 'auto')
  .option('--bucket <bucket>')
  .option('--prefix <prefix>')
  .option('--access-key-id <id>')
  .option('--secret-access-key <key>', 'prefer --secret-access-key-stdin')
  .option('--secret-access-key-stdin', 'read the S3 secret access key from stdin')
  .option('--session-token <token>')
  .option('--virtual-host', 'use virtual-hosted bucket addressing instead of path-style')
  .option('--default', 'make this the default artifact backend')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      await withApp(async (app) => {
        const type = String(options.type) as 'local' | 's3';
        let secret: Record<string, unknown> = {};
        if (type === 's3') {
          if (!options.endpoint || !options.bucket) {
            throw new UdmtError('INVALID_INPUT', 'S3 storage needs --endpoint and --bucket.');
          }
          const secretKey = options.secretAccessKeyStdin
            ? (await readStdin()) || undefined
            : (options.secretAccessKey as string | undefined);
          if (!options.accessKeyId || !secretKey) {
            throw new UdmtError('INVALID_INPUT', 'S3 storage needs --access-key-id and a secret access key.');
          }
          secret = {
            access_key_id: String(options.accessKeyId),
            secret_access_key: String(secretKey),
            ...(options.sessionToken ? { session_token: String(options.sessionToken) } : {}),
          };
        }
        const created = app.createStorageBackend({
          name: String(options.name),
          backend_type: type,
          config:
            type === 's3'
              ? {
                  endpoint: String(options.endpoint),
                  region: String(options.region ?? 'auto'),
                  bucket: String(options.bucket),
                  ...(options.prefix ? { prefix: String(options.prefix) } : {}),
                  force_path_style: !options.virtualHost,
                }
              : options.root
                ? { root: String(options.root) }
                : {},
          secret,
          is_default: Boolean(options.default),
        });
        if (globalOptions().json) return printJson(created);
        process.stdout.write(`Created storage backend "${created.name}" (${created.backend_type}).\n`);
        process.stdout.write(`Endpoint: ${created.endpoint_hint ?? '—'}\n`);
      });
    });
  });

storage
  .command('test')
  .argument('<backend>')
  .description('Probe read/write access for a storage backend')
  .action(async (idOrName: string) => {
    await main(async () => {
      await withApp(async (app) => {
        const result = await app.testStorageBackend(idOrName);
        if (globalOptions().json) return printJson(result);
        process.stdout.write(`${result.success ? 'OK' : 'FAILED'} ${idOrName} (${result.latency_ms}ms)\n`);
        for (const line of result.diagnostics) process.stdout.write(`  - ${line}\n`);
        if (!result.success) throw new UdmtError('STORAGE_ERROR', result.diagnostics[0] ?? 'Storage test failed');
      });
    });
  });

storage
  .command('default')
  .argument('<backend>')
  .description('Choose the default artifact backend')
  .action(async (idOrName: string) => {
    await withApp((app) => {
      const updated = app.setDefaultStorageBackend(idOrName);
      process.stdout.write(`Default storage backend is now "${updated.name}".\n`);
    });
  });

storage
  .command('remove')
  .argument('<backend>')
  .description('Remove a storage backend (must be empty and not the default)')
  .action(async (idOrName: string) => {
    await main(async () => {
      await withApp((app) => {
        app.deleteStorageBackend(idOrName);
        process.stdout.write(`Removed storage backend "${idOrName}".\n`);
      });
    });
  });

// ------------------------------------------------------------------ sync
const sync = program.command('sync').description('Manage and run source→target sync pipelines');
const syncPipeline = sync.command('pipeline').description('Manage sync pipeline definitions');

function parseJsonOption<T>(value: unknown, label: string): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    throw new UdmtError('INVALID_INPUT', `${label} must be valid JSON.`);
  }
}

function printSyncRun(run: OperationRun): void {
  if (globalOptions().json) return printJson(run);
  const result = run.result ?? {};
  process.stdout.write(`${result.dry_run ? 'Sync dry run finished — nothing was written.' : 'Sync completed.'}\n`);
  process.stdout.write(`  run:      ${run.id}\n`);
  process.stdout.write(`  status:   ${run.status}\n`);
  if (result.dry_run) {
    process.stdout.write(`  sampled:  ${result.rows_sampled ?? 0}\n`);
    process.stdout.write(`  matched:  ${result.rows_matched ?? 0}\n`);
  } else {
    process.stdout.write(`  read:     ${result.rows_read ?? 0}\n`);
    process.stdout.write(`  filtered: ${result.rows_filtered ?? 0}\n`);
    process.stdout.write(`  written:  ${result.rows_written ?? 0}\n`);
    process.stdout.write(`  skipped:  ${result.rows_skipped ?? 0}\n`);
  }
  process.stdout.write(`  errors:   ${result.errors ?? 0}\n`);
  for (const warning of ((result.warnings as string[] | undefined) ?? []).slice(0, 20)) {
    process.stdout.write(`  warning:  ${warning}\n`);
  }
}

syncPipeline
  .command('list')
  .description('List sync pipelines')
  .action(async () => {
    await withApp((app) => {
      const rows = app.listSyncPipelines();
      if (globalOptions().json) return printJson(rows);
      printTable(
        rows.map((row) => ({
          id: row.id.slice(0, 8),
          name: row.name,
          mode: row.load_mode,
          source: row.source_resource,
          target: row.target_resource,
          enabled: row.enabled,
          updated: row.updated_at,
        })),
        ['id', 'name', 'mode', 'source', 'target', 'enabled', 'updated'],
      );
    });
  });

syncPipeline
  .command('inspect')
  .argument('<pipeline>')
  .description('Show a sync pipeline definition and its last state')
  .action(async (idOrName: string) => {
    await withApp((app) => {
      const row = app.getSyncPipeline(idOrName);
      const state = app.syncState(row.id);
      if (globalOptions().json) return printJson({ pipeline: row, state });
      process.stdout.write(`${row.name} (${row.id}) — ${row.load_mode}\n`);
      process.stdout.write(`source:  ${row.source_connection_id}.${row.source_resource}\n`);
      process.stdout.write(`target:  ${row.target_connection_id}.${row.target_resource}\n`);
      process.stdout.write(`keys:    ${row.key_columns.join(', ') || '—'}\n`);
      process.stdout.write(`enabled: ${row.enabled ? 'yes' : 'no'}\n`);
      process.stdout.write(`mapping: ${JSON.stringify(row.mapping, null, 2)}\n`);
      process.stdout.write(`options: ${JSON.stringify(row.options, null, 2)}\n`);
      if (state) {
        process.stdout.write(`last run: ${state.last_status ?? '—'} @ ${state.last_run_at ?? '—'} (${state.rows_synced} rows total)\n`);
      }
    });
  });

function syncDefinitionFromFlags(options: Record<string, unknown>) {
  return {
    ...(options.name ? { name: String(options.name) } : {}),
    ...(options.sourceConn ? { source_connection_id: String(options.sourceConn) } : {}),
    ...(options.targetConn ? { target_connection_id: String(options.targetConn) } : {}),
    ...(options.sourceResource ? { source_resource: String(options.sourceResource) } : {}),
    ...(options.targetResource ? { target_resource: String(options.targetResource) } : {}),
    ...(options.mode ? { load_mode: String(options.mode) as SyncLoadMode } : {}),
    ...(options.keyColumns ? { key_columns: parseKeyColumns(String(options.keyColumns)) } : {}),
    ...(options.mapping ? { mapping: parseJsonOption<SyncFieldMapping[]>(options.mapping, '--mapping') } : {}),
    ...(options.options ? { options: parseJsonOption<SyncOptions>(options.options, '--options') } : {}),
    ...(options.disabled ? { enabled: false } : {}),
  };
}

function addSyncDefinitionOptions(command: Command, required: boolean): Command {
  const commandWithFlags = required
    ? command
        .requiredOption('--name <name>', 'pipeline name')
        .requiredOption('--source-conn <connection>', 'source connection')
        .requiredOption('--target-conn <connection>', 'target connection')
        .requiredOption('--source-resource <resource>', 'source table/collection/file')
        .requiredOption('--target-resource <resource>', 'target table/collection/file')
    : command
        .option('--name <name>', 'pipeline name')
        .option('--source-conn <connection>', 'source connection')
        .option('--target-conn <connection>', 'target connection')
        .option('--source-resource <resource>', 'source table/collection/file')
        .option('--target-resource <resource>', 'target table/collection/file');
  return commandWithFlags
    .addOption(
      new Option('--mode <mode>', 'load mode').choices(['append', 'upsert', 'truncate_and_load', 'replace_resource']).default(required ? 'append' : undefined),
    )
    .option('--key-columns <list>', 'upsert key target columns (comma separated)')
    .option('--mapping <json>', 'field mapping JSON array, e.g. [{"source":"id","target":"id"}]')
    .option('--options <json>', 'options JSON object (filter, batch_size, on_error, retry, dry_run, create_resource, limit)')
    .option('--disabled', 'create the pipeline disabled');
}

addSyncDefinitionOptions(
  syncPipeline.command('create').description('Create a sync pipeline'),
  true,
).action(async (options: Record<string, unknown>) => {
  await main(async () => {
    await withApp((app) => {
      const created = app.createSyncPipeline(syncDefinitionFromFlags(options) as never);
      if (globalOptions().json) return printJson(created);
      process.stdout.write(`Created sync pipeline "${created.name}" (${created.id}).\n`);
    });
  });
});

addSyncDefinitionOptions(
  syncPipeline.command('update').argument('<pipeline>').description('Update a sync pipeline'),
  false,
).action(async (idOrName: string, options: Record<string, unknown>) => {
  await main(async () => {
    await withApp((app) => {
      const patch = syncDefinitionFromFlags(options);
      const updated = app.updateSyncPipeline(idOrName, patch);
      if (globalOptions().json) return printJson(updated);
      process.stdout.write(`Updated sync pipeline "${updated.name}".\n`);
    });
  });
});

syncPipeline
  .command('remove')
  .argument('<pipeline>')
  .description('Delete a sync pipeline')
  .action(async (idOrName: string) => {
    await main(async () => {
      await withApp((app) => {
        app.deleteSyncPipeline(idOrName);
        process.stdout.write(`Deleted sync pipeline ${idOrName}.\n`);
      });
    });
  });

sync
  .command('run')
  .argument('<pipeline>')
  .description('Run a sync pipeline')
  .option('--dry-run', 'validate and sample without writing')
  .option('--limit <n>', 'maximum source rows', (value) => Number(value))
  .option('--batch-size <n>', 'rows per batch', (value) => Number(value))
  .addOption(new Option('--on-error <mode>', 'row error handling').choices(['fail', 'skip']))
  .option('--confirm <target_connection_name>', 'required for destructive or production targets')
  .action(async (idOrName: string, options: Record<string, unknown>) => {
    await main(async () => {
      await withApp(async (app) => {
        const pipeline = app.getSyncPipeline(idOrName);
        const started = app.engine.startSync({
          pipeline_id: pipeline.id,
          ...(options.dryRun ? { dry_run: true } : {}),
          ...(options.limit ? { limit: Number(options.limit) } : {}),
          ...(options.batchSize ? { batch_size: Number(options.batchSize) } : {}),
          ...(options.onError ? { on_error: options.onError as 'fail' | 'skip' } : {}),
          ...(options.confirm ? { confirm: String(options.confirm) } : {}),
        });
        const run = assertSuccess(await watchRun(app, started.run.id));
        printSyncRun(run);
      });
    });
  });

sync
  .command('validate')
  .argument('<pipeline>')
  .description('Dry-run a pipeline against a bounded sample')
  .option('--limit <n>', 'rows to sample', (value) => Number(value), 100)
  .action(async (idOrName: string, options: Record<string, unknown>) => {
    await main(async () => {
      await withApp(async (app) => {
        const { run } = await app.validateSyncPipeline(idOrName, { limit: Number(options.limit ?? 100) });
        const finished = assertSuccess(run);
        printSyncRun(finished);
      });
    });
  });

sync
  .command('state')
  .argument('<pipeline>')
  .description('Show checkpoint state for a pipeline')
  .action(async (idOrName: string) => {
    await withApp((app) => {
      const state = app.syncState(idOrName);
      if (globalOptions().json) return printJson(state);
      if (!state) return process.stdout.write('No sync state yet.\n');
      process.stdout.write(`pipeline: ${state.pipeline_id}\n`);
      process.stdout.write(`last run: ${state.last_run_id ?? '—'} (${state.last_status ?? '—'})\n`);
      process.stdout.write(`updated:  ${state.updated_at}\n`);
      process.stdout.write(`rows:     ${state.rows_synced}\n`);
      process.stdout.write(`checkpoint: ${JSON.stringify(state.checkpoint, null, 2)}\n`);
    });
  });

sync
  .command('reset')
  .argument('<pipeline>')
  .description('Clear the checkpoint/watermark so the next run replays fully')
  .action(async (idOrName: string) => {
    await withApp((app) => {
      app.resetSyncState(idOrName);
      process.stdout.write(`Cleared sync state for ${idOrName}. The next run reads from the beginning.\n`);
    });
  });

sync
  .command('errors')
  .argument('<run>')
  .description('Show persisted row errors for a sync run')
  .option('--limit <n>', 'maximum rows', (value) => Number(value), 200)
  .action(async (runId: string, options: Record<string, unknown>) => {
    await withApp((app) => {
      const rows = app.syncErrors(runId, Number(options.limit ?? 200));
      if (globalOptions().json) return printJson(rows);
      if (rows.length === 0) return process.stdout.write('No sync row errors recorded.\n');
      printTable(
        rows.map((row) => ({
          row: row.row_index ?? '—',
          batch: row.batch_index ?? '—',
          code: row.code,
          message: row.message,
        })),
        ['row', 'batch', 'code', 'message'],
      );
    });
  });

// ------------------------------------------------------------------ plugins
const plugin = program.command('plugin').description('Manage external provider plugins');

plugin
  .command('list')
  .description('List installed plugins')
  .action(async () => {
    await withApp((app) => {
      const rows = app.listPlugins();
      if (globalOptions().json) return printJson(rows);
      if (rows.length === 0) return process.stdout.write('No plugins installed.\n');
      printTable(
        rows.map((row) => ({
          id: row.id,
          version: row.version,
          status: row.status,
          enabled: row.enabled,
          trusted: row.trusted,
          permissions: row.granted_permissions.join(',') || '—',
          updated: row.updated_at,
        })),
        ['id', 'version', 'status', 'enabled', 'trusted', 'permissions', 'updated'],
      );
    });
  });

plugin
  .command('inspect')
  .argument('<plugin>')
  .description('Show a plugin manifest, permissions and status')
  .action(async (id: string) => {
    await withApp((app) => {
      const row = app.getPlugin(id);
      if (globalOptions().json) return printJson(row);
      process.stdout.write(`${row.name} (${row.id}) v${row.version} — ${row.status}\n`);
      process.stdout.write(`path:          ${row.install_path}\n`);
      process.stdout.write(`protocol:      ${row.protocol_version}\n`);
      process.stdout.write(`enabled:       ${row.enabled ? 'yes' : 'no'}\n`);
      process.stdout.write(`trusted:       ${row.trusted ? 'yes' : 'no'}\n`);
      process.stdout.write(`requested:     ${row.requested_permissions.join(', ') || '—'}\n`);
      process.stdout.write(`granted:       ${row.granted_permissions.join(', ') || '—'}\n`);
      process.stdout.write(`capabilities:  ${row.manifest.provider.capabilities.join(', ')}\n`);
      process.stdout.write(`runtime:       ${row.manifest.runtime.command} ${(row.manifest.runtime.args ?? []).join(' ')}\n`);
      if (row.last_error) process.stdout.write(`last error:    ${row.last_error}\n`);
    });
  });

plugin
  .command('install')
  .description('Install a plugin from a folder containing udmt-plugin.json')
  .requiredOption('--path <dir>')
  .option('--trust', 'grant every requested permission immediately')
  .option('--enable', 'enable the plugin (requires trust)')
  .action(async (options: Record<string, unknown>) => {
    await withApp((app) => {
      const installed = app.installPlugin({
        path: String(options.path),
        trusted: Boolean(options.trust),
        enabled: Boolean(options.enable),
      });
      if (globalOptions().json) return printJson(installed);
      process.stdout.write(`Installed plugin "${installed.id}" v${installed.version} (trusted: ${installed.trusted}).\n`);
      if (!installed.trusted) {
        process.stdout.write(`Review permissions with: udmt plugin inspect ${installed.id}\n`);
        process.stdout.write(`Grant them with: udmt plugin trust ${installed.id}\n`);
      }
    });
  });

plugin
  .command('update')
  .argument('<plugin>')
  .description('Re-read the manifest from the install folder')
  .action(async (id: string) => {
    await withApp((app) => {
      const updated = app.updatePlugin(id);
      if (globalOptions().json) return printJson(updated);
      process.stdout.write(`Updated plugin "${updated.id}" to v${updated.version}.\n`);
    });
  });

plugin
  .command('trust')
  .argument('<plugin>')
  .option('--permissions <list>', 'comma-separated subset of the requested permissions')
  .description('Grant permissions and mark the plugin trusted')
  .action(async (id: string, options: Record<string, unknown>) => {
    await withApp((app) => {
      const granted = typeof options.permissions === 'string' && options.permissions.trim()
        ? (options.permissions.split(',').map((entry) => entry.trim()).filter(Boolean) as PluginPermission[])
        : undefined;
      const updated = app.setPluginTrust(id, { trusted: true, ...(granted ? { granted_permissions: granted } : {}) });
      if (globalOptions().json) return printJson(updated);
      process.stdout.write(`Trusted plugin "${updated.id}" with permissions: ${updated.granted_permissions.join(', ') || '—'}\n`);
    });
  });

plugin
  .command('untrust')
  .argument('<plugin>')
  .description('Revoke trust and disable the plugin')
  .action(async (id: string) => {
    await withApp((app) => {
      const updated = app.setPluginTrust(id, { trusted: false });
      app.setPluginEnabled(id, false);
      if (globalOptions().json) return printJson(updated);
      process.stdout.write(`Revoked trust for plugin "${id}".\n`);
    });
  });

plugin
  .command('enable')
  .argument('<plugin>')
  .description('Enable a trusted plugin')
  .action(async (id: string) => {
    await withApp((app) => {
      const updated = app.setPluginEnabled(id, true);
      if (globalOptions().json) return printJson(updated);
      process.stdout.write(`Enabled plugin "${updated.id}".\n`);
    });
  });

plugin
  .command('disable')
  .argument('<plugin>')
  .description('Disable a plugin')
  .action(async (id: string) => {
    await withApp((app) => {
      const updated = app.setPluginEnabled(id, false);
      if (globalOptions().json) return printJson(updated);
      process.stdout.write(`Disabled plugin "${updated.id}".\n`);
    });
  });

plugin
  .command('remove')
  .argument('<plugin>')
  .description('Remove a plugin (files are left on disk)')
  .action(async (id: string) => {
    await withApp((app) => {
      app.removePlugin(id);
      process.stdout.write(`Removed plugin "${id}".\n`);
    });
  });

plugin
  .command('test')
  .argument('<plugin>')
  .description('Handshake the plugin and report protocol, version and capabilities')
  .action(async (id: string) => {
    await withApp(async (app) => {
      const result = await app.testPlugin(id);
      if (globalOptions().json) return printJson(result);
      process.stdout.write(`${result.success ? 'OK' : 'FAILED'} ${id} (${result.latency_ms}ms)\n`);
      for (const line of result.diagnostics) process.stdout.write(`  - ${line}\n`);
    });
  });

// ------------------------------------------------------------------ jobs & schedules
const job = program.command('job').description('Manage reusable jobs');

job
  .command('list')
  .action(async () => {
    await withApp((app) => {
      const jobs = app.listJobs();
      if (globalOptions().json) return printJson(jobs);
      printTable(
        jobs.map((item) => ({
          id: item.id.slice(0, 8),
          name: item.name,
          type: item.operation_type,
          enabled: item.enabled,
          created: item.created_at,
        })),
        ['id', 'name', 'type', 'enabled', 'created'],
      );
    });
  });

job
  .command('add-export')
  .description('Create an export job (optionally scheduled)')
  .requiredOption('--name <name>')
  .requiredOption('--conn <connection>')
  .requiredOption('--resource <resource>')
  .addOption(new Option('--format <format>').choices(['jsonl', 'csv', 'json', 'xml', 'xlsx']).default('jsonl'))
  .addOption(new Option('--compression <mode>').choices(['none', 'gzip']).default('gzip'))
  .option('--out <directory>')
  .option('--batch-size <n>', 'rows per batch', (value) => Number(value))
  .option('--schedule <type>', 'once|interval|daily|weekly|monthly')
  .option('--timezone <tz>', 'IANA timezone', 'UTC')
  .option('--at <iso>', 'for --schedule once')
  .option('--every-minutes <n>', 'interval in minutes', (value) => Number(value))
  .option('--hour <n>', 'hour 0-23', (value) => Number(value))
  .option('--minute <n>', 'minute 0-59', (value) => Number(value))
  .option('--day <n>', 'monthly day', (value) => Number(value))
  .option('--days <list>', 'weekly days 0-6, comma separated')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      await withApp((app) => {
        const schedule = buildScheduleInput(options);
        const result = app.createExportJob({
          name: String(options.name),
          connection_id: String(options.conn),
          resource: String(options.resource),
          format: options.format as ExportFormat,
          compression: options.compression as 'none' | 'gzip',
          ...(options.out ? { output_dir: String(options.out) } : {}),
          ...(options.batchSize ? { batch_size: Number(options.batchSize) } : {}),
          ...(schedule ? { schedule } : {}),
        });
        if (globalOptions().json) return printJson(result);
        process.stdout.write(`Created job "${result.job.name}" (${result.job.id}).\n`);
        if (result.schedule?.next_run_at) process.stdout.write(`Next run: ${result.schedule.next_run_at}\n`);
      });
    });
  });

job
  .command('add-import')
  .description('Create an import job (optionally scheduled)')
  .requiredOption('--name <name>')
  .requiredOption('--conn <connection>')
  .requiredOption('--resource <resource>')
  .requiredOption('--from <path>')
  .addOption(new Option('--format <format>').choices(['jsonl', 'csv', 'json', 'xml', 'xlsx']))
  .addOption(new Option('--mode <mode>').choices(['append', 'upsert', 'truncate_and_load']).default('append'))
  .option('--key-columns <list>')
  .option('--confirm <connection_name>')
  .option('--dry-run')
  .option('--schedule <type>', 'once|interval|daily|weekly|monthly')
  .option('--timezone <tz>', 'IANA timezone', 'UTC')
  .option('--at <iso>', 'for --schedule once')
  .option('--every-minutes <n>', 'interval in minutes', (value) => Number(value))
  .option('--hour <n>', 'hour 0-23', (value) => Number(value))
  .option('--minute <n>', 'minute 0-59', (value) => Number(value))
  .option('--day <n>', 'monthly day', (value) => Number(value))
  .option('--days <list>')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      await withApp((app) => {
        const schedule = buildScheduleInput(options);
        const result = app.createImportJob({
          name: String(options.name),
          connection_id: String(options.conn),
          resource: String(options.resource),
          source_path: String(options.from),
          ...(options.format ? { format: options.format as ExportFormat } : {}),
          mode: options.mode as 'append' | 'upsert' | 'truncate_and_load',
          ...(options.keyColumns ? { key_columns: parseKeyColumns(String(options.keyColumns)) } : {}),
          ...(options.confirm ? { confirm: String(options.confirm) } : {}),
          ...(options.dryRun ? { dry_run: true } : {}),
          ...(schedule ? { schedule } : {}),
        });
        if (globalOptions().json) return printJson(result);
        process.stdout.write(`Created job "${result.job.name}" (${result.job.id}).\n`);
        if (result.schedule?.next_run_at) process.stdout.write(`Next run: ${result.schedule.next_run_at}\n`);
      });
    });
  });

job
  .command('add-sync')
  .description('Create a sync job (optionally scheduled)')
  .requiredOption('--name <name>')
  .requiredOption('--pipeline <pipeline>')
  .option('--limit <n>', 'maximum source rows', (value) => Number(value))
  .option('--batch-size <n>', 'rows per batch', (value) => Number(value))
  .addOption(new Option('--on-error <mode>').choices(['fail', 'skip']))
  .option('--confirm <target_connection_name>')
  .option('--dry-run')
  .option('--schedule <type>', 'once|interval|daily|weekly|monthly')
  .option('--timezone <tz>', 'IANA timezone', 'UTC')
  .option('--at <iso>', 'for --schedule once')
  .option('--every-minutes <n>', 'interval in minutes', (value) => Number(value))
  .option('--hour <n>', 'hour 0-23', (value) => Number(value))
  .option('--minute <n>', 'minute 0-59', (value) => Number(value))
  .option('--day <n>', 'monthly day', (value) => Number(value))
  .option('--days <list>')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      await withApp((app) => {
        const schedule = buildScheduleInput(options);
        const result = app.createSyncJob({
          name: String(options.name),
          pipeline_id: String(options.pipeline),
          ...(options.limit ? { limit: Number(options.limit) } : {}),
          ...(options.batchSize ? { batch_size: Number(options.batchSize) } : {}),
          ...(options.onError ? { on_error: options.onError as 'fail' | 'skip' } : {}),
          ...(options.confirm ? { confirm: String(options.confirm) } : {}),
          ...(options.dryRun ? { dry_run: true } : {}),
          ...(schedule ? { schedule } : {}),
        });
        if (globalOptions().json) return printJson(result);
        process.stdout.write(`Created job "${result.job.name}" (${result.job.id}).\n`);
        if (result.schedule?.next_run_at) process.stdout.write(`Next run: ${result.schedule.next_run_at}\n`);
      });
    });
  });

job
  .command('remove')
  .argument('<job_id>')
  .action(async (jobId: string) => {
    await withApp((app) => {
      app.deleteJob(jobId);
      process.stdout.write(`Deleted job ${jobId}.\n`);
    });
  });

function buildScheduleInput(options: Record<string, unknown>) {
  if (!options.schedule) return undefined;
  const type = String(options.schedule) as 'once' | 'interval' | 'daily' | 'weekly' | 'monthly';
  const timezone = String(options.timezone ?? 'UTC');
  const config: Record<string, unknown> = {};
  if (type === 'once') config.at = String(options.at ?? new Date().toISOString());
  if (type === 'interval') config.every_minutes = Number(options.everyMinutes ?? 60);
  if (type === 'daily' || type === 'weekly' || type === 'monthly') {
    config.hour = Number(options.hour ?? 2);
    config.minute = Number(options.minute ?? 0);
  }
  if (type === 'weekly') config.days = parseKeyColumns(String(options.days ?? '1,2,3,4,5'))?.map(Number);
  if (type === 'monthly') config.day = Number(options.day ?? 1);
  return { schedule_type: type, schedule_config: config, timezone };
}

const schedule = program.command('schedule').description('Manage schedules');

schedule
  .command('list')
  .action(async () => {
    await withApp((app) => {
      const schedules = app.listSchedules();
      if (globalOptions().json) return printJson(schedules);
      printTable(
        schedules.map((item) => ({
          id: item.id.slice(0, 8),
          job: item.job?.name ?? '—',
          description: item.description,
          enabled: item.enabled,
          next_run: item.next_run_at ?? '—',
          last_run: item.last_run_at ?? '—',
        })),
        ['id', 'job', 'description', 'enabled', 'next_run', 'last_run'],
      );
    });
  });

schedule
  .command('enable')
  .argument('<schedule_id>')
  .action(async (scheduleId: string) => {
    await main(async () => {
      await withApp((app) => {
        const updated = app.setScheduleEnabled(scheduleId, true);
        process.stdout.write(`Enabled schedule; next run ${updated.next_run_at ?? 'not scheduled'}.\n`);
      });
    });
  });

schedule
  .command('disable')
  .argument('<schedule_id>')
  .action(async (scheduleId: string) => {
    await withApp((app) => {
      app.setScheduleEnabled(scheduleId, false);
      process.stdout.write('Disabled schedule.\n');
    });
  });

schedule
  .command('remove')
  .argument('<schedule_id>')
  .action(async (scheduleId: string) => {
    await withApp((app) => {
      app.deleteSchedule(scheduleId);
      process.stdout.write(`Deleted schedule ${scheduleId}.\n`);
    });
  });

// ------------------------------------------------------------------ worker
const worker = program.command('worker').description('Background worker (scheduler runtime)');

worker
  .command('run')
  .description('Run the worker in the foreground')
  .option('--interval <ms>', 'poll interval in ms', (value) => Number(value), 15000)
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      const app = openApp();
      const runtime = new WorkerRuntime(app, { pollIntervalMs: Number(options.interval ?? 15000) });
      await runtime.start();
      logLine(`worker ${runtime.instance.id} started (pid ${process.pid}, host ${hostname()})`);
      const shutdown = async (signal: string) => {
        logLine(`received ${signal}, stopping worker gracefully…`);
        await runtime.stop();
        app.close();
        process.exit(EXIT.OK);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      await new Promise<void>(() => undefined);
    });
  });

worker
  .command('once')
  .description('Run a single scheduler pass and exit')
  .action(async () => {
    await main(async () => {
      const app = openApp();
      try {
        const runtime = new WorkerRuntime(app, { once: true });
        const started = await runtime.start();
        const result = started.tick ?? { started: [], skipped: [] };
        if (globalOptions().json) printJson(result);
        else {
          process.stdout.write(`Started ${result.started.length} run(s).\n`);
          for (const skipped of result.skipped) process.stdout.write(`  skipped: ${skipped}\n`);
        }
      } finally {
        app.close();
      }
    });
  });

worker
  .command('status')
  .description('Show worker heartbeat and state')
  .action(async () => {
    await withApp((app) => {
      const status = app.workerStatus();
      if (globalOptions().json) return printJson(status);
      if (!status.instance) {
        process.stdout.write('Worker has never run.\n');
        return;
      }
      process.stdout.write(`state:     ${status.running ? 'Running' : status.stale ? 'Stale' : 'Stopped'}\n`);
      process.stdout.write(`instance:  ${status.instance.id}\n`);
      process.stdout.write(`pid:       ${status.instance.pid} on ${status.instance.hostname}\n`);
      process.stdout.write(`heartbeat: ${status.heartbeat_age_seconds}s ago\n`);
      process.stdout.write(`tasks:     ${status.instance.tasks_running}\n`);
      if (status.instance.last_error) process.stdout.write(`last error: ${status.instance.last_error}\n`);
    });
  });

// ------------------------------------------------------------------ misc
program
  .command('doctor')
  .description('System and database diagnostics')
  .action(async () => {
    await withApp((app) => {
      const report = app.doctor();
      if (globalOptions().json) return printJson(report);
      process.stdout.write(`udmt ${report.app_version}\n`);
      process.stdout.write(`node ${report.node_version} (${report.platform})\n`);
      process.stdout.write(`data dir        ${report.data_dir}\n`);
      process.stdout.write(`database        ${report.db_path} [${report.db_integrity}]\n`);
      process.stdout.write(`artifacts       ${report.artifacts_dir}\n`);
      process.stdout.write(`secret backend  ${report.secret_backend}\n`);
      if (report.secret_warning) process.stdout.write(`warning         ${report.secret_warning}\n`);
      process.stdout.write(`worker          ${report.worker.running ? 'running' : 'stopped'}\n`);
      process.stdout.write(
        `counts          connections=${report.counts.connections} runs=${report.counts.runs} artifacts=${report.counts.artifacts} schedules=${report.counts.schedules}\n`,
      );
      process.stdout.write(`providers       ${report.providers.map((provider) => provider.provider_id).join(', ')}\n`);
    });
  });

program
  .command('serve')
  .description('Start the local API server used by the GUI')
  .option('--port <port>', 'port', (value) => Number(value), DEFAULT_PORT)
  .option('--host <host>', 'bind address', '127.0.0.1')
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      const app = openApp();
      const server = await startApiServer(app, {
        port: Number(options.port ?? DEFAULT_PORT),
        host: String(options.host ?? '127.0.0.1'),
      });
      logLine(`udmt API listening on ${server.url}`);
      const shutdown = async () => {
        await server.close();
        app.close();
        process.exit(EXIT.OK);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      await new Promise<void>(() => undefined);
    });
  });

program
  .command('gui')
  .description('Start the API server and print how to open the GUI')
  .option('--port <port>', 'port', (value) => Number(value), DEFAULT_PORT)
  .action(async (options: Record<string, unknown>) => {
    await main(async () => {
      const app = openApp();
      const port = Number(options.port ?? DEFAULT_PORT);
      let server: Awaited<ReturnType<typeof startApiServer>>;
      try {
        server = await startApiServer(app, { port, host: '127.0.0.1' });
      } catch (error) {
        const running = await probeRunningServer(port);
        if (running) {
          process.stdout.write(`udmt GUI is already running at ${running}\n`);
          process.stdout.write(`This command would have used data dir: ${app.paths.dataDir}\n`);
          process.stdout.write('Reuse the running window, or start a second instance with --port <other> (and --data-dir if needed).\n');
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw new UdmtError('PRECONDITION_FAILED', `Port ${port} is already in use by another program.`, {
            details: { port, hint: 'Run `udmt gui --port 4005` to pick a free port.' },
          });
        }
        throw error;
      }
      const uiUrl = server.uiUrl;
      process.stdout.write(`API:     ${server.url}\n`);
      process.stdout.write(`Data:    ${app.paths.dataDir}\n`);
      if (uiUrl) {
        process.stdout.write(`GUI:     ${uiUrl}\n`);
      } else {
        process.stdout.write('GUI build not found. Run `npm run build:gui` first, or use `npm run dev:gui`.\n');
      }
      const shutdown = async () => {
        await server.close();
        app.close();
        process.exit(EXIT.OK);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      await new Promise<void>(() => undefined);
    });
  });

// `pnpm run udmt -- <args>` forwards the literal `--`; Commander would read it as
// end-of-options and treat the next token as a command name. Drop it.
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

program.parseAsync(['node', 'udmt', ...args]).catch((error) => {
  const udmt = toUdmtError(error);
  process.stderr.write(`error [${udmt.code}]: ${udmt.message}\n`);
  process.exit(exitCodeFor(udmt));
});

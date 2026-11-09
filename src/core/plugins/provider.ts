import { UdmtError } from '../errors.js';
import { pluginProviderId, type PluginRecord, type ProviderDescriptor, type RowBatch, type Row } from '../types.js';
import type { ConnectionTestResult, DataProvider, OperationContext, ReadRequest, ValidatedConnectionConfig, WriteRequest, WriteResult } from '../providers/contract.js';
import { caps } from '../providers/contract.js';
import { PluginProcess } from './host.js';

/**
 * Wraps an installed, trusted external plugin as a `DataProvider`. Config is
 * validated locally (so connection creation stays synchronous and offline); all
 * live calls go to the child process over JSON-RPC with a timeout and support for
 * cancellation. A dead/absent process is restarted on the next call.
 */
export class ExternalProvider implements DataProvider {
  private process: PluginProcess | null = null;

  constructor(private readonly record: PluginRecord) {}

  get providerId(): string {
    return pluginProviderId(this.record.id);
  }

  descriptor(): ProviderDescriptor {
    const { provider, version: manifestVersion } = this.record.manifest;
    return {
      provider_id: this.providerId,
      display_name: `${provider.display_name} (plugin: ${this.record.id})`,
      version: provider.version ?? manifestVersion,
      built_in: false,
      capabilities: caps(...provider.capabilities),
      service_profiles: provider.service_profiles ?? [],
      config_fields: provider.config_fields ?? [],
      secret_fields: provider.secret_fields ?? [],
    };
  }

  validateConfig(config: Record<string, unknown>, _secret: Record<string, unknown>): ValidatedConnectionConfig {
    for (const field of this.record.manifest.provider.config_fields ?? []) {
      const value = config[field.name];
      if (field.required && (value === undefined || value === null || value === '')) {
        throw new UdmtError('INVALID_CONFIG', `Plugin provider "${this.record.name}" requires "${field.label}".`);
      }
    }
    return { config: { ...config }, endpoint_hint: endpointHint(config) ?? pluginProviderId(this.record.id) };
  }

  private ensure(): PluginProcess {
    if (this.process && this.process.alive) return this.process;
    this.process = new PluginProcess(this.record.id, this.record.install_path, this.record.manifest, this.record.granted_permissions);
    return this.process;
  }

  private async call<T>(method: string, params: Record<string, unknown>, ctx?: OperationContext): Promise<T> {
    await this.ensure().handshake();
    return (await this.ensure().request(method, params, ctx ? { signal: ctx.signal } : {})) as T;
  }

  async testConnection(config: Record<string, unknown>, secret: Record<string, unknown>, ctx: OperationContext): Promise<ConnectionTestResult> {
    const result = await this.call<ConnectionTestResult>('provider.testConnection', { config, secret }, ctx);
    return {
      success: Boolean(result.success),
      server_version: result.server_version ?? null,
      database: result.database ?? null,
      latency_ms: result.latency_ms,
      diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [],
      detected_capabilities: Array.isArray(result.detected_capabilities) ? result.detected_capabilities : this.record.manifest.provider.capabilities,
    };
  }

  async discoverResources(config: Record<string, unknown>, secret: Record<string, unknown>, ctx: OperationContext) {
    return this.call<import('../types.js').ResourceDescriptor[]>('provider.discoverResources', { config, secret }, ctx);
  }

  async readSchema(config: Record<string, unknown>, secret: Record<string, unknown>, resource: string, ctx: OperationContext) {
    return this.call<import('../types.js').ResourceSchema>('provider.readSchema', { config, secret, resource }, ctx);
  }

  async *readRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: ReadRequest,
    ctx: OperationContext,
  ): AsyncGenerator<RowBatch, void, unknown> {
    let offset: unknown = request.offset ?? 0;
    while (true) {
      ctx.throwIfCancelled();
      const result = await this.call<{ rows?: Row[]; next_offset?: unknown }>(
        'provider.readBatch',
        { config, secret, request: { ...request, offset } },
        ctx,
      );
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      if (rows.length > 0) yield rows;
      if (result?.next_offset === null || result?.next_offset === undefined) break;
      if (rows.length === 0) break;
      offset = result.next_offset;
    }
  }

  async writeRows(
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
    request: WriteRequest,
    rows: AsyncIterable<RowBatch>,
    ctx: OperationContext,
  ): Promise<WriteResult> {
    let written = 0;
    let skipped = 0;
    const warnings: string[] = [];
    for await (const batch of rows) {
      ctx.throwIfCancelled();
      const result = await this.call<{ rows_written?: number; rows_skipped?: number; warnings?: string[] }>(
        'provider.writeBatch',
        { config, secret, request, rows: batch },
        ctx,
      );
      written += Number(result?.rows_written ?? batch.length);
      skipped += Number(result?.rows_skipped ?? 0);
      if (Array.isArray(result?.warnings)) warnings.push(...result.warnings);
    }
    return { rows_written: written, rows_skipped: skipped, warnings };
  }

  /** Handshakes and forgets the process so the next call starts a fresh one. */
  async reset(testCtx?: OperationContext): Promise<string[]> {
    if (this.process) await this.process.stop();
    this.process = null;
    const process = this.ensure();
    const handshake = await process.handshake();
    void testCtx;
    if (handshake.capabilities.length === 0) {
      throw new UdmtError('CAPABILITY_UNSUPPORTED', `Plugin "${this.record.id}" declared no capabilities.`);
    }
    return process.logLines;
  }

  diagnostics(): string[] {
    return this.process?.logLines ?? [];
  }

  async shutdown(): Promise<void> {
    if (this.process) await this.process.stop();
    this.process = null;
  }
}

function endpointHint(config: Record<string, unknown>): string | null {
  for (const key of ['base_url', 'url', 'host', 'path', 'database', 'endpoint']) {
    const value = config[key];
    if (typeof value === 'string' && value) return sanitize(value);
  }
  return null;
}

function sanitize(value: string): string {
  return value.replace(/\/\/[^@/]+@/, '//').slice(0, 200);
}

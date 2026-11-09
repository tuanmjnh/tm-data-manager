import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isErrorCode, UdmtError } from '../errors.js';
import { PLUGIN_PROTOCOL_VERSION, type CapabilityId, type PluginManifest } from '../types.js';
import { resolveRuntimePath } from './manifest.js';

export interface PluginHandshake {
  protocol: string;
  server: { name: string; version: string };
  capabilities: CapabilityId[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

const MAX_DIAGNOSTIC_LINES = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One child process per external plugin, speaking newline-delimited JSON-RPC 2.0
 * over stdio. The process is spawned without a shell, never inherits the parent's
 * secrets through arguments, and is killed if a call times out or the run is
 * cancelled. A crash rejects pending calls and is reported to the caller; it can
 * never take down the core or GUI.
 */
export class PluginProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private diagnostics: string[] = [];
  private ready: Promise<PluginHandshake> | null = null;
  private lastExit: { code: number | null; signal: string | null } | null = null;

  constructor(
    readonly pluginId: string,
    private readonly pluginDir: string,
    private readonly manifest: PluginManifest,
    private readonly grantedPermissions: string[],
  ) {}

  get alive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  get logLines(): string[] {
    return [...this.diagnostics];
  }

  async handshake(): Promise<PluginHandshake> {
    if (!this.ready) {
      this.ready = this.start().catch(async (error) => {
        // A failed handshake must not poison future calls: drop the process.
        this.ready = null;
        await this.stop();
        throw error instanceof UdmtError ? error : new UdmtError('CONNECTION_FAILED', String(error));
      });
    }
    return this.ready;
  }

  private async start(): Promise<PluginHandshake> {
    const { runtime } = this.manifest;
    const baseDir = runtime.cwd ? resolveRuntimePath(this.pluginDir, runtime.cwd) : this.pluginDir;
    const command = resolveRuntimePath(baseDir, runtime.command);
    const args = (runtime.args ?? []).map((arg) => resolveRuntimePath(baseDir, arg));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: baseDir,
        env: { ...process.env, ...(runtime.env ?? {}), UDMT_PLUGIN_ID: this.manifest.id, UDMT_PROTOCOL: PLUGIN_PROTOCOL_VERSION },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      throw new UdmtError('CONNECTION_FAILED', `Could not start plugin "${this.pluginId}": ${(error as Error).message}`);
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    child.on('error', (error) => this.failAll(new UdmtError('CONNECTION_FAILED', `Plugin "${this.pluginId}" error: ${error.message}`, { cause: error })));
    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal };
      this.child = null;
      this.ready = null;
      const detail = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`;
      this.failAll(new UdmtError('CONNECTION_FAILED', `Plugin "${this.pluginId}" stopped unexpectedly (${detail}).`));
    });

    const result = await this.sendRequest('initialize', {
      protocol: PLUGIN_PROTOCOL_VERSION,
      client: { name: 'udmt', version: '0.1.0' },
      permissions: this.grantedPermissions,
      plugin_id: this.manifest.id,
    });
    const handshake = result as Partial<PluginHandshake> | null;
    if (!handshake || typeof handshake !== 'object' || handshake.protocol !== PLUGIN_PROTOCOL_VERSION) {
      throw new UdmtError(
        'CAPABILITY_UNSUPPORTED',
        `Plugin "${this.pluginId}" did not complete a ${PLUGIN_PROTOCOL_VERSION} handshake.`,
      );
    }
    return {
      protocol: handshake.protocol,
      server: handshake.server ?? { name: this.manifest.id, version: this.manifest.version },
      capabilities: Array.isArray(handshake.capabilities) ? (handshake.capabilities as CapabilityId[]) : this.manifest.provider.capabilities,
    };
  }

  async request(method: string, params: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    await this.handshake();
    return this.sendRequest(method, params, options);
  }

  private async sendRequest(method: string, params: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!this.child) throw new UdmtError('CONNECTION_FAILED', `Plugin "${this.pluginId}" is not running.`);
    if (options.signal?.aborted) throw new UdmtError('OPERATION_CANCELLED', 'Plugin call cancelled.');

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UdmtError('CONNECTION_FAILED', `Plugin "${this.pluginId}" timed out after ${timeoutMs}ms during ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });

    const onAbort = () => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      this.notify('provider.cancel', { id });
      pending.reject(new UdmtError('OPERATION_CANCELLED', 'Plugin call cancelled.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.send({ jsonrpc: '2.0', id, method, params });
      return await promise;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.child) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    try {
      this.send({ jsonrpc: '2.0', method: 'shutdown', params: {} });
    } catch {
      /* the process may already be gone */
    }
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null && !child.killed) child.kill();
    this.child = null;
    this.ready = null;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child) return;
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(line);
    } catch (error) {
      throw new UdmtError('CONNECTION_FAILED', `Could not write to plugin "${this.pluginId}": ${(error as Error).message}`);
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
    if (this.stdoutBuffer.length > 1_000_000) {
      this.stdoutBuffer = '';
      this.pushDiagnostic('warn: plugin produced an oversized non-newline-terminated frame; discarded.');
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.pushDiagnostic(`warn: ignoring non-JSON plugin output: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      this.handleNotification(message.method, message.params);
      return;
    }
    const id = typeof message.id === 'number' ? message.id : null;
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.error) {
      pending.reject(this.pluginError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: unknown): void {
    const body = (params ?? {}) as Record<string, unknown>;
    if (method === 'log' || method === 'progress') {
      const level = typeof body.level === 'string' ? body.level : 'info';
      const text = typeof body.message === 'string' ? body.message : JSON.stringify(body);
      this.pushDiagnostic(`${level}: ${text}`);
    }
  }

  private pluginError(error: unknown): Error {
    const body = (error ?? {}) as { code?: unknown; message?: unknown; data?: { code?: unknown } };
    const message = typeof body.message === 'string' ? body.message : 'Plugin call failed.';
    const code = body.data?.code;
    if (isErrorCode(code)) return new UdmtError(code, message);
    if (body.code === -32601) return new UdmtError('CAPABILITY_UNSUPPORTED', `Plugin "${this.pluginId}" does not implement this method.`);
    return new UdmtError('OPERATION_FAILED', `Plugin "${this.pluginId}" failed: ${sanitize(message)}`);
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim()) this.pushDiagnostic(`stderr: ${sanitize(line.trim())}`);
    }
  }

  private pushDiagnostic(line: string): void {
    this.diagnostics.push(line.slice(0, 500));
    if (this.diagnostics.length > MAX_DIAGNOSTIC_LINES) this.diagnostics.shift();
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sanitize(message: string): string {
  return message.replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
}

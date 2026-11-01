import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UdmtApp } from './service.js';
import { newWorkerInstance } from './service.js';
import { nextRunAt, type ScheduleInput } from './scheduler.js';
import { isUdmtError } from './errors.js';
import { nowIso, newId } from './utils.js';
import type { ExportRequest, ImportRequest, OperationRun, ScheduleRecord, WorkerInstance } from './types.js';

const HEARTBEAT_MS = 10_000;
const STALE_HEARTBEAT_MS = 60_000;
const MISFIRE_GRACE_MS = 120_000;
const LOCK_LEASE_MS = 10 * 60_000;

/**
 * Headless worker (roadmap 10.4). Runs scheduled export/import jobs without the
 * GUI. State lives in SQLite so the UI can show real status even after a crash.
 */
export class WorkerRuntime {
  instance: WorkerInstance;
  private timer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private runningTick = false;
  private readonly lockPath: string;
  private lockHeld = false;

  constructor(
    private readonly app: UdmtApp,
    private readonly options: { pollIntervalMs?: number; once?: boolean } = {},
  ) {
    this.instance = newWorkerInstance();
    this.lockPath = join(app.paths.dataDir, 'worker.lock');
  }

  async start(): Promise<{ ok: true; tick?: { started: string[]; skipped: string[] } }> {
    if (!this.acquireLock()) {
      throw new Error('Another udmt worker already holds the local worker lock. Stop it first.');
    }
    this.app.store.upsertWorkerInstance({ ...this.instance, status: 'starting' });
    await this.recover();
    this.app.store.upsertWorkerInstance({ ...this.instance, status: 'running', heartbeat_at: nowIso() });

    this.heartbeatTimer = setInterval(() => {
      this.app.store.upsertWorkerInstance({
        ...this.instance,
        status: this.stopping ? 'stopping' : 'running',
        heartbeat_at: nowIso(),
        tasks_running: this.runningTick ? 1 : 0,
      });
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();

    if (this.options.once) {
      const tick = await this.tick();
      await this.stop();
      return { ok: true, tick };
    }

    const interval = this.options.pollIntervalMs ?? 15_000;
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    return { ok: true };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Wait for an in-flight tick (bounded).
    const deadline = Date.now() + 15_000;
    while (this.runningTick && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.app.store.upsertWorkerInstance({
      ...this.instance,
      status: 'stopped',
      heartbeat_at: nowIso(),
      tasks_running: 0,
    });
    this.releaseLock();
  }

  /** One scheduler pass. Safe to call from tests. */
  async tick(now: Date = new Date()): Promise<{ started: string[]; skipped: string[] }> {
    if (this.runningTick) return { started: [], skipped: ['tick already running'] };
    if (this.stopping) return { started: [], skipped: ['worker stopping'] };
    this.runningTick = true;
    const started: string[] = [];
    const skipped: string[] = [];
    try {
      this.purgeStaleLocks();
      const due = this.app.store.listDueSchedules(now.toISOString());
      for (const schedule of due) {
        if (this.stopping) break;
        const outcome = await this.runSchedule(schedule, now);
        if (outcome.startedRunId) started.push(outcome.startedRunId);
        if (outcome.skipped) skipped.push(outcome.skipped);
      }
    } finally {
      this.runningTick = false;
    }
    return { started, skipped };
  }

  private async runSchedule(
    schedule: ScheduleRecord,
    now: Date,
  ): Promise<{ startedRunId?: string; skipped?: string }> {
    const { store } = this.app;
    const job = store.getJob(schedule.job_id);
    if (!job) {
      store.updateSchedule(schedule.id, { enabled: false, next_run_at: null });
      store.audit('schedule.disabled', { schedule_id: schedule.id, reason: 'job missing' });
      return { skipped: `schedule ${schedule.id}: job missing` };
    }
    if (!job.enabled) {
      this.advance(schedule, now);
      return { skipped: `schedule ${schedule.id}: job disabled` };
    }

    const lockOwner = `worker:${this.instance.id}`;
    if (!store.acquireLock(`schedule:${schedule.id}`, lockOwner, null, LOCK_LEASE_MS)) {
      return { skipped: `schedule ${schedule.id}: locked by another worker` };
    }

    try {
      const dueAt = schedule.next_run_at ? new Date(schedule.next_run_at) : now;
      const missed = now.getTime() - dueAt.getTime();

      if (missed > MISFIRE_GRACE_MS && schedule.misfire_policy === 'skip') {
        this.advance(schedule, now);
        store.audit('schedule.misfired_skipped', { schedule_id: schedule.id, due_at: dueAt.toISOString() });
        return { skipped: `schedule ${schedule.id}: misfire skipped by policy` };
      }

      if (schedule.overlap_policy === 'forbid') {
        const active = store.listActiveRunsForJob(job.id);
        if (active.length > 0) {
          this.advance(schedule, now);
          store.audit('schedule.overlap_skipped', {
            schedule_id: schedule.id,
            active_runs: active.map((run) => run.id),
          });
          return { skipped: `schedule ${schedule.id}: previous run still active` };
        }
      }

      const config = job.config as Record<string, unknown>;
      let started: { run: OperationRun; done: Promise<OperationRun> } | null = null;

      if (job.operation_type === 'export') {
        const request: ExportRequest = {
          connection_id: String(config.connection_id ?? job.source_connection_id ?? ''),
          resource: String(config.resource ?? ''),
          format: (config.format as ExportRequest['format']) ?? 'jsonl',
          compression: (config.compression as ExportRequest['compression']) ?? 'gzip',
          ...(typeof config.output_dir === 'string' ? { output_dir: config.output_dir } : {}),
          ...(typeof config.batch_size === 'number' ? { batch_size: config.batch_size } : {}),
        };
        started = this.app.engine.startExport(request, { jobId: job.id, workerId: this.instance.id });
      } else if (job.operation_type === 'import') {
        const source = (config.source ?? {}) as { path?: string; artifact_id?: string };
        const request: ImportRequest = {
          connection_id: String(config.connection_id ?? job.target_connection_id ?? ''),
          resource: String(config.resource ?? ''),
          source,
          mode: (config.mode as ImportRequest['mode']) ?? 'append',
          ...(Array.isArray(config.key_columns) ? { key_columns: config.key_columns as string[] } : {}),
          ...(typeof config.confirm === 'string' ? { confirm: config.confirm } : {}),
          ...(typeof config.dry_run === 'boolean' ? { dry_run: config.dry_run } : {}),
          ...(typeof config.format === 'string' ? { format: config.format as ImportRequest['format'] } : {}),
        };
        started = this.app.engine.startImport(request, { jobId: job.id, workerId: this.instance.id });
      }

      store.updateSchedule(schedule.id, {
        last_run_at: nowIso(),
        next_run_at: this.computeNext(schedule, now),
      });

      if (!started) return { skipped: `schedule ${schedule.id}: unsupported operation ${job.operation_type}` };

      const runId = started.run.id;
      const run = await started.done;
      if (run.status === 'failed' || run.status === 'interrupted') {
        this.instance.last_error = `run ${run.id}: ${run.error_message_safe ?? run.status}`;
        this.app.store.upsertWorkerInstance({ ...this.instance, last_error: this.instance.last_error });
      }
      return { startedRunId: runId };
    } catch (error) {
      const message = isUdmtError(error) ? error.message : (error as Error).message;
      this.instance.last_error = message;
      this.app.store.upsertWorkerInstance({ ...this.instance, last_error: message });
      store.audit('schedule.error', { schedule_id: schedule.id, error: message });
      // Prevent a hot loop on a permanently broken schedule.
      this.advance(schedule, now);
      return { skipped: `schedule ${schedule.id}: ${message}` };
    } finally {
      store.releaseLock(`schedule:${schedule.id}`, lockOwner);
    }
  }

  private computeNext(schedule: ScheduleRecord, from: Date): string | null {
    const input: ScheduleInput = {
      schedule_type: schedule.schedule_type,
      schedule_config: schedule.schedule_config,
      timezone: schedule.timezone,
    };
    const next = nextRunAt(input, from);
    return next ? next.toISOString() : null;
  }

  private advance(schedule: ScheduleRecord, now: Date): void {
    const next = this.computeNext(schedule, now);
    this.app.store.updateSchedule(schedule.id, { next_run_at: next });
  }

  /** Marks runs abandoned by a dead worker as interrupted (roadmap 10.4). */
  async recover(): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();
    const abandoned = this.app.store.findAbandonedRuns(staleBefore);
    for (const run of abandoned) {
      this.app.store.markRunInterrupted(
        run.id,
        'Worker stopped or lost its heartbeat during this operation. Inspect the target before retrying.',
      );
    }
    for (const instance of this.app.store.listWorkerInstances()) {
      if (instance.id === this.instance.id) continue;
      if (instance.status === 'running' && new Date(instance.heartbeat_at).getTime() < Date.now() - STALE_HEARTBEAT_MS) {
        this.app.store.upsertWorkerInstance({ ...instance, status: 'crashed', tasks_running: 0 });
      }
    }
    return abandoned.length;
  }

  private purgeStaleLocks(): void {
    this.app.store.purgeStaleLocks(new Date(Date.now() - LOCK_LEASE_MS).toISOString());
  }

  private acquireLock(): boolean {
    if (existsSync(this.lockPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number; started_at: string };
        if (raw.pid && isProcessAlive(raw.pid)) return false;
      } catch {
        // corrupt lock file: take it over
      }
    }
    writeFileSync(
      this.lockPath,
      JSON.stringify({ pid: process.pid, instance_id: this.instance.id, started_at: nowIso() }),
      { mode: 0o600 },
    );
    this.lockHeld = true;
    return true;
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* already gone */
    }
    this.lockHeld = false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Helper used by the CLI `worker run` command to keep the process alive. */
export async function runWorkerUntilSignal(app: UdmtApp, intervalMs?: number): Promise<void> {
  const worker = new WorkerRuntime(app, intervalMs ? { pollIntervalMs: intervalMs } : {});
  await worker.start();
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[udmt worker ${worker.instance.id.slice(0, 8)}] received ${signal}, stopping…\n`);
    await worker.stop();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Keep the event loop referenced while the timer is unref'd.
  await new Promise<void>(() => undefined);
}

export { newId };

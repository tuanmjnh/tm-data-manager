# Worker and scheduler

## Responsibilities

The worker is a headless runtime that runs scheduled export/import jobs and recovers abandoned runs.
It never opens a window and shares the same `UdmtApp` facade as the CLI and GUI.

## Lifecycle

`starting → running → stopping → stopped`, plus `crashed` when a previous instance's heartbeat is stale.
Status is written to `worker_instances` with pid, host, version, heartbeat every 10 s and the current
task count. The GUI only shows "Running" while the heartbeat is fresh (< 45 s), never just because a
process was spawned.

## Schedule evaluation

1. Every poll (15 s by default, `--interval`) read schedules where `enabled = 1 AND next_run_at <= now`.
2. Acquire `schedule:<id>` lease; skip when another worker holds it.
3. If missed by more than 2 minutes:
   - `skip` → advance `next_run_at` without running,
   - `run_once_on_recovery` (default) → run exactly once.
4. If `overlap_policy = forbid` and the job has an active run → skip and advance.
5. Create the run from the job config with `job_id` + `worker_instance_id`, execute it, then set
   `last_run_at` and the next occurrence.
6. Release the lock. A schedule that throws is advanced to avoid a hot loop and records the error on the
   worker instance + audit log.

## Timezones and DST

`nextRunAt` walks calendar days in the target IANA zone (not in UTC), then converts the wall-clock time
to UTC using the zone offset of that candidate day. This avoids skipping a day for UTC+13/+14 and
handles the spring-forward gap. Covered by tests for UTC, Asia/Ho_Chi_Minh and Europe/Berlin.

## OS integration

Supported today: run in the foreground (`udmt worker run`) or trigger one pass (`udmt worker once`) from
Windows Task Scheduler, cron, systemd timer, etc. A first-class service installer is not implemented;
`docs/IMPLEMENTATION-STATUS.md` records that gap.

## Shutdown

SIGINT/SIGTERM mark the instance `stopping`, stop accepting ticks, wait up to 15 s for the current pass,
write `stopped`, and release the local lock file. A run still executing when the process is killed is
marked `interrupted` by the next worker start (`recover`).
